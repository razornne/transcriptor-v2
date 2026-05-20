# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## What this is

**Skriptly (transcriptor-v2)** — облачный сервис транскрипции созвонов со спикер-разделением и LLM-обработкой. После Stage 2 архитектура: фронт-енд + бэк-енд на Modal, аутентификация и хранилище через Supabase. Ноут юзера больше не нужен.

v1 (`C:\projects\transcriptor\`) — старая Railway-версия на OpenAI API. **Продолжает работать параллельно, намеренно. Не сливать.**

## Архитектура (Stage 2 — production)

```
Browser
   │
   │ load skriptly.io
   ▼
Vercel (Next.js landing + Studio v2 redesign)
   │
   ├─ skriptly.io/              → Next.js landing
   ├─ skriptly.io/app           → rewrite to Modal flask_app `/` (текущий transcriptor)
   ├─ skriptly.io/v2            → НОВЫЙ Studio redesign (Next.js, в разработке)
   └─ skriptly.io/api/*         → rewrite to Modal flask_app /api/* (fallback)

Browser JS (on skriptly.io/app)
   │
   │ Supabase JS: auth (Google OAuth / magic link)
   │ window.fetch напрямую на Modal (обходит Vercel Edge 4MB body limit)
   ▼
Modal flask_app (CPU, scale-to-zero)
   │
   │ JWT verify (Supabase JWKS) + .spawn() в GPU класс
   ▼
Modal Transcriptor (A10G GPU, scaledown_window=300)
   - faster-whisper large-v3-turbo
   - pyannote-3.1
   - Qwen2.5-7B-Instruct (4-bit)

Supabase Postgres
   - auth.users (Google OAuth / Email magic link)
   - public.transcripts (RLS — owner-only)
```

**Production URLs:**
- **skriptly.io** — landing (Vercel)
- **skriptly.io/app** — текущее приложение (HTML с Modal через Vercel rewrite, API напрямую на Modal). РАБОТАЕТ, не трогать пока v2 не готов.
- **skriptly.io/v2** — новый Studio редизайн (Next.js, статичный каркас сделан, ML-логика не подключена)
- **razornne--transcriptor-v2-flask-app.modal.run** — Modal endpoint напрямую

**Стек:**
- **Modal** — serverless GPU. Два контейнера в одном app (`transcriptor-v2`):
  - `Transcriptor` cls — A10G GPU, whisper large-v3-turbo + pyannote-3.1 + Qwen2.5-7B-Instruct (4-bit)
  - `flask_app` wsgi — лёгкий CPU контейнер, тонкий прокси
- **Supabase** — Auth (Google + magic link) + Postgres (история транскриптов, RLS)
- **Vercel** — Next.js landing на `skriptly.io`, rewrites для `/app` и `/api/*` (fallback)
- **Frontend приложения** — `templates/index.html` отдаётся Modal Flask, проксируется через Vercel на `/app`

**Поток обработки:**
1. Юзер логинится через Supabase Auth (Google или magic link)
2. Запись: `fullRecorder` MediaRecorder `timeslice=5s` → каждый chunk в IndexedDB (autosave для recovery)
3. Stop: blob отправляется на `/api/transcribe` с JWT в header
4. Flask валидирует JWT через JWKS, делает `Transcriptor.transcribe_full.spawn(audio_bytes, ...)` → возвращает `t_<modal_call_id>`
5. Фронт polling'ует `/api/jobs/<job_id>` каждые 2с → `FunctionCall.from_id(id).get(timeout=0)`
6. На done — segments возвращаются, рендерятся
7. Фронт сохраняет в Supabase `public.transcripts` через **raw fetch** (Supabase JS PostgrestClient зависает в нашей среде)
8. Параллельно `/api/title` генерирует заголовок через `run_llm.spawn(...)`

## Файлы

### Backend (Python)
- **`modal_app.py`** — Modal app definition. Содержит:
  - `image` — GPU образ (CUDA 12.4 + faster-whisper + pyannote + transformers + bitsandbytes)
  - `web_image` — лёгкий CPU образ (Flask + flask-cors + pyjwt[crypto] + requests)
  - `Transcriptor` (cls, A10G) — `load_models()` грузит whisper / pyannote / Qwen в `@modal.enter()`. Методы `transcribe_full(audio_bytes, language, num_speakers, prompt)` и `run_llm(prompt, max_tokens, temperature)`.
  - `flask_app()` — `@modal.wsgi_app()` декоратор, импортирует `app.py` и отдаёт Flask instance. Принудительно выставляет `USE_MODAL=true`.

- **`app.py`** — Flask backend. Эндпоинты:
  - `GET /api/health` — без auth, для проверки
  - `POST /api/transcribe` (auth) — принимает audio, `_transcriptor.transcribe_full.spawn(...)` → `{job_id: "t_<id>"}`
  - `POST /api/generate` (auth) — LLM template processing → `{job_id: "g_<id>"}`
  - `POST /api/chat` (auth) — вопрос-ответ по транскрипту → `{job_id: "c_<id>"}`
  - `GET /api/jobs/<job_id>` (auth) — `FunctionCall.from_id(...).get(timeout=0)`. Префикс job_id определяет какое поле возвращать (`segments` / `result` / `answer`)
  - `POST /api/title` (auth, sync) — короткий LLM запрос ~5-10c
  - `POST /api/tags` (auth, sync) — LLM tags (FEATURE_TAGS=false на фронте)
  - `POST /api/transcribe-chunk` (auth, sync) — **dormant**, оставлен на случай возврата live-text фичи
  - `GET /` — отдаёт `templates/index.html` (для текущего deploy; уберётся когда фронт переедет на Vercel)
  - **JWT middleware**: `@app.before_request _require_jwt()` валидирует токен через Supabase JWKS endpoint (поддерживает HS256 legacy + ES256/RS256 new). Только `/api/health` пропускается без auth.
  - **Dual mode**: `USE_MODAL=true` (production на Modal) → spawn-based async. `USE_MODAL` не задан (local dev) → in-memory `JOBS` dict + Python threads + локальные Whisper/pyannote/Ollama.

- **`transcriber.py`** — local mode only. faster-whisper wrapper. На Modal не используется (Transcriptor cls в modal_app.py содержит свою версию).
- **`diarizer.py`** — local mode only. pyannote wrapper.
- **`merger.py`** — общий для Modal и local. Word-level speaker alignment. Конфигурируемый smoothing через `SMOOTH_THRESHOLD_S` (default 0 = выключено). Forward-fill для SPEAKER_UNKNOWN на первых словах сегмента.

### Frontend — приложение
- **`templates/index.html`** — single-file (CSS+JS inline). ~3000 строк. Это сам transcriptor (запись, транскрипт, AI tools).

### Frontend — landing + Studio v2 (Next.js)
- **`landing/`** — Next.js 15 проект, деплоится на Vercel как `skriptly.io`.
  Сейчас держит ДВЕ независимые поверхности:

  **Landing (`/`):**
  - `app/layout.tsx` — root layout, шрифты (Bricolage Grotesque + Onest для UA + Manrope + JetBrains Mono), theme bootstrap, viewport
  - `app/page.tsx` → монтирует `LandingClient`
  - `app/globals.css` — стили лендинга (Direction C + светлая/тёмная темы + mobile breakpoints)
  - `components/` — Nav, Hero, Social, HowItWorks, Features, Breakout, Pricing, FinalCTA, Footer + SegToggle, ThemeToggle, AppMock, Logo
  - `lib/content.ts` — EN/UA копирайтинг + 4 тарифа (Free $0 / Pro $15 / Max $29 / Team $14)
  - `lib/hooks.ts` — useTypewriter, useReveal, useParallax, useTween

  **Studio v2 redesign (`/v2`)** — см. отдельную секцию ниже:
  - `app/v2/{layout,page,v2.css}.tsx`
  - `components/studio/` — Studio компоненты
  - `lib/studio/mock-data.ts` — mock-данные

  **Общие настройки:**
  - `next.config.mjs` — rewrites `/app` и `/api/*` на Modal endpoint (API сейчас обходится напрямую с фронта, см. ниже)
  - Production deploy: Vercel автодеплоит при push в `main`. Root Directory: `landing/`.

## Common commands

```powershell
# ── Landing + Studio v2 dev (Next.js) ─────────────────────────
cd landing
npm install               # один раз
npm run dev               # → http://localhost:3000 (landing)
                          #   http://localhost:3000/v2 (Studio redesign)

# Производственный билд (НЕ запускать пока dev сервер крутится —
# затрёт .next кеш и dev упадёт с "Cannot find module './833.js'")
npm run build             # сначала pkill node, потом rm -rf .next, потом build

# Восстановление после порчи .next:
Stop-Process -Name node -Force
Remove-Item -Recurse -Force .next
npm run dev

# ── Production деплой ─────────────────────────────────────────
# Modal CLI должен быть установлен (pip install modal в venv) и авторизован (modal setup)
modal deploy modal_app.py

# Frontend (Vercel) автоматом при git push в main

# Modal Secret c HF_TOKEN и SUPABASE_URL
modal secret create transcriptor-secrets HF_TOKEN=hf_... SUPABASE_URL=https://bmonakhktbaliwgobrxv.supabase.co --force

# ── Локальная разработка (без Modal) ──────────────────────────
python -m venv venv
.\venv\Scripts\Activate.ps1
pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu124
pip install -r requirements.txt
pip install nvidia-cudnn-cu12 nvidia-cublas-cu12

# cuDNN fix (см. README, обязательно на Windows)
cd venv\Lib\site-packages\torch\lib
Get-ChildItem cudnn*.dll | ForEach-Object { Rename-Item $_.FullName -NewName ($_.Name + ".bak") }
Copy-Item ..\..\nvidia\cudnn\bin\cudnn*.dll .
cd ..\..\..\..\..

# Ollama для локального LLM (только если USE_MODAL не задан)
winget install Ollama.Ollama
ollama pull qwen2.5:3b

# .env — для локального dev режима
Copy-Item .env.example .env  # отредактировать HF_TOKEN

# Запуск локального Flask (без Modal)
python app.py  # → http://localhost:5000

# Запуск локального Flask с Modal backend
$env:USE_MODAL = "true"
python app.py
```

Нет тестов, нет линтера, нет билд-шага.

## Frontend (templates/index.html) — ключевые куски

### Auth
- **Supabase JS** загружается с CDN в `<head>` (v2)
- **Login overlay** — fullscreen card, видна пока нет сессии. Кнопки: Continue with Google + Email magic link
- `sb.auth.onAuthStateChange()` — реагирует на `INITIAL_SESSION` / `SIGNED_IN` / `SIGNED_OUT`. Показывает/скрывает overlay, обновляет email-pill в hero
- `authFetch(url, opts)` — обёртка над `fetch()` которая добавляет `Authorization: Bearer <jwt>` для всех вызовов к нашему бэку
- **Sign out button** в hero-meta секции — `sb.auth.signOut()` → onAuthStateChange покажет login

### История (Postgres через raw REST)
- **Не используем Supabase JS PostgrestClient** — он висит на `.then()` в нашей среде (auth работает нормально, проблема только в query клиенте)
- `_sbFetch(path, opts)` — обёртка над `fetch` к `${SUPABASE_URL}/rest/v1`. Добавляет `apikey` и `Authorization: Bearer <user_jwt>`. Для POST/PATCH ставит `Prefer: return=representation`
- `_historyCache` — массив в памяти. `getHistory()` синхронна, возвращает кэш. Обновляется через `refreshHistory()` после login и любой мутации
- CRUD: `saveToHistory`, `updateHistoryEntry`, `deleteFromHistory`, `clearHistory` — все async, идут через `_sbFetch`. Маппинг между DB-форматом (snake_case) и JS-форматом (camelCase) через `_rowToEntry()`

### Запись
- **Один MediaRecorder** (`fullRecorder`) на mix микрофона + getDisplayMedia через AudioContext. `start(5000)` timeslice → каждый chunk в IndexedDB (см. Audio safety net)
- На Stop: blob → `/api/transcribe` (multipart form) → async job → poll → segments

### Job polling
- `submitJob(url, body, isFormData)` — POST через `authFetch`, возвращает `job_id`
- `pollJob(jobId, onProgress)` — каждые 2с GET `/api/jobs/<id>` через `authFetch`. На done — возвращает result. **Прогресс сейчас не работает в Modal-режиме** (только `processing` без granular статуса) — UX-косметика, можно вернуть через `modal.Dict` если нужно

### Tab keep-alive (для долгих созвонов в background-вкладке)
- **Silent audio** — `OscillatorNode` gain=0.0001 → браузер не дискардит вкладку
- **Wake Lock API** — `navigator.wakeLock.request('screen')` на старте, re-acquire на `visibilitychange`
- **OS Notifications** — `Notification.requestPermission()` + `notify(title, body)` для started/ready/failed
- **Battery warning** — confirm если не charging + level<40%

### Audio safety net (3 уровня)
- `lastRecordingBlob` — после Stop держим blob в памяти. Если /api/transcribe упал → recovery box: Retry / Download / Discard
- `beforeunload` warning при непустом blob
- IndexedDB autosave — `idbCreateSession / idbAppendChunk / idbDeleteSession`. Каждый chunk пишется. На load `idbGetOrphanedSessions()` находит незавершённые → confirm recovery

### Переименования и UI
- **Speaker rename**: клик по `.speaker-name` → inline input → Enter сохраняет в `currentSpeakerNames[rawLabel]`. Имена идут в DB через update entry
- **Auto-title + progressive UI**: `autoSuggestTitle()` ставит placeholder из первых ~6 слов. `requestLLMTitle()` запускает LLM в фоне, рендерит `✨ thinking…` placeholder. Если юзер кликнул и переименовал руками — `currentTitleIsAuto=false`, LLM не перетирает
- **Inline edit транскрипта** — двойной клик на текст или ✎ hover-кнопка → textarea (auto-sized). Enter save, Esc cancel, Shift+Enter newline. Помечает `seg.edited`

### Контент-секции
- **Notes section** — textarea между транскриптом и AI-блоком. Дебаунс 600ms перед save
- **AI tools** — Summary / Action items + dropdown с другими шаблонами. Кешируется в `currentAIResults[template]`. Карточки имеют actions: copy, regenerate, ×

### Search и filter
- `filterHistory(history, query)` — поиск по title / text / speaker names / date / language. Активный tag filter если `activeTagFilter`
- Подсветка совпадений через `<mark>`, scroll-to-first

### Feature flags
- `FEATURE_CHAT = false` — Chat with transcript (готово, скрыто)
- `FEATURE_TAGS = false` — Auto-tags + tag-фильтр (готово, скрыто)

### Persistence
- **Supabase Postgres** — основная история (`public.transcripts`)
- **localStorage**: `transcriptor_settings` (lang + numSpeakers), `theme`. История больше не там.
- **IndexedDB** (`transcriptor_recordings` → `sessions`): autosave чанков. Удаляется после успешной транскрипции.

## Modal app — ключевые куски

### Container reuse
- **`Transcriptor` cls** (`@app.cls(gpu="A10G", scaledown_window=300)`) — держится тёплым 5 мин. Первый запуск ~60-90с (загрузка моделей), последующие быстрые.
- **`flask_app` wsgi** (`@app.function(min_containers=0, scaledown_window=60)`) — scale-to-zero. Cold start ~3-5с.
- Persistent Volume `transcriptor-models` — модели кэшируются между рестартами.

### Spawn-based async
- `Transcriptor.transcribe_full.spawn(audio_bytes, language, num_speakers, prompt)` → возвращает `FunctionCall` сразу. Flask отдаёт `object_id` как `job_id` (с префиксом `t_`)
- На polling: `modal.FunctionCall.from_id(call_id).get(timeout=0)` — не блокирует, либо `TimeoutError` (processing) либо result. Errors всплывают как исключения с оригинальным сообщением.

### Native Python типы перед return
- faster-whisper и pyannote возвращают `numpy.float32` для start/end. Modal serializes via cbor2; **Flask контейнер не имеет numpy** → deserialize падает.
- Все timestamps кастуем через `float()`, speakers через `str()` перед return.

### LLM correction
- `_correct_segments(merged, language)` внутри `transcribe_full` — батчи по 60 сегментов, формат `1. text\n2. text\n...`
- Safety checks: отклоняем если изменение длины >40% или появилась латиница в Cyrillic-тексте

## Non-obvious things future-Claude will trip on

### Modal / Backend
- **Supabase JWT validation через JWKS** — не shared HS256 secret. PyJWKClient кэширует ключи. Работает с legacy HS256 и новым ES256/RS256 одновременно (`algorithms=["HS256", "ES256", "RS256"]`).
- **`SUPABASE_URL` в Modal Secret обязателен** — без него JWKS клиент не инициализируется и **JWT validation пропускается** (для локального dev режима). На prod должен быть выставлен.
- **`pyjwt[crypto]` extra нужна** для ES256/RS256. Просто `pyjwt` поддерживает только HS256.
- **Modal `scaledown_window` не `container_idle_timeout`** — deprecated имя.
- **CUDA base image, не debian_slim** — `nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04` чтобы `libcublas.so.12` был доступен системно. Без этого torch/ctranslate2 падают с "library not found".
- **`add_local_python_source("merger")` / `("app")`** — Modal должен знать о локальных модулях чтобы упаковать. Без этого `from merger import merge` и `from app import app` упадут.

### Frontend
- **API_BASE на проде = абсолютный Modal URL, обходит Vercel.** На `skriptly.io/app` фронт грузится через Vercel-proxy → Modal, но XHR-запросы к `/api/*` идут НАПРЯМУЮ на `razornne--transcriptor-v2-flask-app.modal.run` (см. `const API_BASE` в templates/index.html). Причина: Vercel Edge Network имеет body-size ~4MB на проксированных запросах, аудио легко превышает → 502 `ROUTER_EXTERNAL_TARGET_ERROR`. Cross-origin работает потому что Flask настроен `CORS(..., origins="*")`. На `localhost` API_BASE остаётся пустым (same-origin для dev).

- **Supabase JS PostgrestClient зависает на `.then()` в нашей среде.** Auth работает, но `sb.from('transcripts').select()` никогда не резолвится. Поэтому raw fetch к `/rest/v1`. Если будут вопросы "почему не SDK" — это причина. Может починится в будущей версии Supabase JS.
- **`?error=...` в URL после неудачного Google OAuth** — Supabase JS не очищает URL, остаётся как параметр. Не критично, но user видит. Идея для cleanup: `history.replaceState({}, '', window.location.pathname)` после успешного `SIGNED_IN`.
- **OAuth consent screen в testing mode** — только добавленные test users могут логиниться через Google. Для широкой аудитории — Publish app в Google Cloud Console.
- **Supabase magic link rate limit** — 4 в час на default SMTP. Custom SMTP (Resend / SendGrid) снимает лимит.

### LLM language hints
- **При autodetect фронт прислал пустую строку — бэк сам детектит язык.** `_detect_transcript_language()` в app.py считает кириллицу vs латиницу + украинские специфичные буквы (`іїєґ`) → возвращает `uk`/`ru`/`en`. Используется в `/api/title`, `/api/chat`, `/api/generate`. Без этого Qwen2.5 регулярно сваливался в английский, даже когда транскрипт был украинский. Тэги (`/api/tags`) ВСЕГДА на английском намеренно — для надёжной фильтрации across languages.

### Whisper / Diarization
- **Word-level alignment в merger** — режет Whisper-сегменты в местах смены спикера. Требует `word_timestamps=True` в whisper.transcribe.
- **SPEAKER_UNKNOWN forward-fill** — pyannote иногда не атрибутирует первое слово сегмента. Merger делает forward-fill из следующих слов с known speaker.
- **Smoothing выключен по умолчанию** — `SMOOTH_THRESHOLD_S=0`. Pyannote-3.1 достаточно точен, smoothing ломал быстрый диалог. Можно включить через env (1.0 = переназначать сегменты короче 1с между одинаковыми соседями).

### Локальный режим (USE_MODAL=false)
- **cuDNN конфликт PyTorch vs CTranslate2** на Windows — см. README. Замена `torch/lib/cudnn*.dll` на `9.22` из `nvidia-cudnn-cu12`.
- **ffmpeg в PATH обязателен**.
- **HF_TOKEN обязателен** + принять условия pyannote-3.1 + pyannote-community-1 на HF.
- **Ollama должна быть запущена** (`http://localhost:11434`), модель `qwen2.5:3b` (или override через `OLLAMA_MODEL`).
- **VRAM 8 GB минимум** для large-v3 + pyannote одновременно.

### Прочее
- **Async jobs spawn'ятся в Modal** — Flask мгновенно возвращает `job_id`. Старая логика с Python threads осталась только для local mode (USE_MODAL=false).
- **`CORS(app, ..., origins="*")`** — открыто для dev. При переезде на `skriptly.io` через Vercel rewrites CORS не нужен (single origin), но оставить.
- **`recordings/` ephemeral** в local mode. На Modal вообще не пишем — bytes в память → ffmpeg → wav в /tmp → удаляется.
- **History в Postgres** хранит `segments` JSONB целиком. Не ломать формат без миграции схемы.

## Studio v2 Redesign (в разработке — Phase 1 done)

Полная переделка `/app` UI под Studio direction из Claude Design прототипа.
Старый `templates/index.html` работает в проде на `/app`, новый строится
параллельно на `/v2`. **Не удалять старый пока новый не одобрен.**

### Текущий статус — Phase 1 ✅ (статический каркас)

Доступен на `skriptly.io/v2` (Vercel автоматом) или `localhost:3000/v2` (dev).
Полностью рабочий визуально, но **БЕЗ ML / API / Auth**:
- Mock-данные из `lib/studio/mock-data.ts`
- Кнопки REC / language picker / tab переключение работают только локально
- Command palette ⌘K открывается, действия — stubs

### Дизайн-направление

**Studio — audio-first cinematic** (выбрано из 3 вариантов в Claude Design):
- **Шрифт display:** `Bricolage Grotesque` (wide axis 100, opsz 96, вес 700)
- **Шрифт UI:** `Manrope` 400-700
- **Шрифт mono:** `JetBrains Mono` для таймстемпов, ярлыков, цифр
- **Accent:** Phosphor mint `#3FBFA3` / hi `#5EEAD4` / on-accent `#0A1612`
  - **НЕ brand blue лендинга** — юзер выбрал mint по мокапу.
- **Light theme:** тёплый parchment cream (`#EDE8E0`) + мягкий accent glow в фоне
- **Dark theme:** тёплый графит (`#1A1613` → `#0F0C0A`) + accent radial glow
- **Speakers palette:** mint / amber / lavender / clay (4 цвета чередуются)

### URL и роутинг

- `/v2` — основной экран (recording / live state по дефолту)
- В будущем (Phase 4+): `/v2/login`, `/v2/settings`, `/v2/r/[id]` (просмотр прошлой записи)
- Когда v2 одобрен → меняем rewrite в `next.config.mjs`: `/app` ведёт сюда вместо Modal, старый `templates/index.html` удаляется или архивируется в `legacy/`.

### File structure

```
landing/
├── app/
│   └── v2/
│       ├── layout.tsx          ← тонкая обёртка, импорт v2.css
│       ├── page.tsx            ← композер: Sidebar + Topbar + scroll + Footer
│       │                         + CommandPalette + global keyboard handlers
│       └── v2.css              ← все стили Studio под .studio-root scope
│                                  (не пересекается с landing globals.css)
├── components/
│   └── studio/
│       ├── Sidebar.tsx         ← header (mic + Studio) + Search + grouped
│       │                         history (Today/Yesterday/This week) с
│       │                         mini-waveform thumbnails + user pill внизу
│       ├── Topbar.tsx          ← eyebrow + Bricolage title +
│       │                         History/Theme buttons. Содержит
│       │                         StudioThemeToggle (light/dark).
│       ├── StudioPanel.tsx     ← Glass card: LIVE indicator + timer +
│       │                         waveform + REC button + LanguagePicker
│       │                         + speakers detected chip + ? hint
│       ├── Waveform.tsx        ← Phase 1: статичные псевдослучайные бары.
│       │                         Phase 2: AnalyserNode из AudioContext.
│       ├── LanguagePicker.tsx  ← Inline pills "Lang | EN | RU | UK | AUTO▾"
│       ├── SpeakerChips.tsx    ← Большие чипы 01/02/03 + speaker names +
│       │                         Rename. Цвета из --s-spk-1..4
│       ├── TranscriptTabs.tsx  ← Tab bar: Transcript / Summary / Actions / Notes
│       ├── TranscriptView.tsx  ← Chat-bubble cards: avatar 40px + name +
│       │                         time + text card (surface bg, border)
│       ├── Footer.tsx          ← Auto-saving indicator + Copy / Download.md
│       └── CommandPalette.tsx  ← ⌘K overlay: Actions / Recent / Settings
│                                  с keyboard nav (↑↓ Enter Esc) + query filter
└── lib/
    └── studio/
        └── mock-data.ts        ← MOCK_TRANSCRIPT, MOCK_HISTORY,
                                  MOCK_SPEAKER_NAMES, MOCK_USER,
                                  SUPPORTED_LANGUAGES, waveBars(n, seed)
```

### CSS архитектура

**Всё под scope `.studio-root`** в `app/v2/v2.css` — не пересекается с
лендингом. Переменные:
- `--s-bg / --s-bg-deep / --s-surface / --s-surface-2` — слои поверхностей
- `--s-border / --s-border-hi / --s-hairline*` — рамки/разделители
- `--s-ink / --s-ink-soft / --s-mute / --s-faint` — текст по убыванию контраста
- `--s-accent / --s-accent-hi / --s-accent-dim / --s-accent-soft / --s-on-accent`
- `--s-spk-1..4` — палитра спикеров
- `--s-display / --s-ui / --s-mono` — шрифты
- `--s-r-sm/md/lg/xl` — радиусы (8/12/20/28)
- `--s-body-bg` — финальный градиент фона
- Light/dark — те же переменные, разные значения. Управляется `[data-theme="dark"]`
  на `<html>` (тот же глобальный механизм что и landing).

### Mock data (Phase 1)

В `lib/studio/mock-data.ts`:
- `MOCK_TRANSCRIPT` — 8 сегментов с тремя спикерами Eli/Sasha/Niko
- `MOCK_HISTORY` — 7 записей с **explicit `group` полем** (Today / Yesterday
  / This week / Earlier). Делает sidebar группировку без вычисления дат
  на клиенте (избегаем SSR hydration mismatch).
- `MOCK_SPEAKER_NAMES` — `{ SPEAKER_00: "Eli", SPEAKER_01: "Sasha", SPEAKER_02: "Niko" }`
- `MOCK_USER` — email, initials (NB), plan (Free), hoursUsed/Limit
- `SUPPORTED_LANGUAGES` — auto / en / ru / uk
- `waveBars(n, seed)` — детерминированный pseudo-random для статичных
  волн. **Важно**: на Phase 1 высоты `.toFixed(2)` чтобы избежать
  hydration mismatch (SSR vs CSR разный float-to-string).

### Phase plan

- **Phase 1 ✅ Статичный каркас** — текущий состояние. Все экраны/компоненты
  на mock-данных, тема, palette, scroll, keyboard shortcuts (⌘K, ⌘R), Esc.
- **Phase 2 — Recording flow.** MediaRecorder + AudioContext mix, **live
  waveform через AnalyserNode** (заменить статичную). Перенос tab keep-alive
  (silent audio, wake lock, OS notifications, battery warning). Перенос
  audio safety net (lastRecordingBlob, IndexedDB autosave, recovery).
- **Phase 3 — Transcribe + Result.** POST на `/api/transcribe` через
  authFetch helper. Polling `/api/jobs`. Processing экран с прогресс-баром.
  Реальный transcript рендеринг. Inline edit, speaker rename. Auto-title
  через `/api/title`.
- **Phase 4 — Auth + History.** Supabase Auth (Google + magic link)
  перенос. Login экран в Studio стиле (см. дизайн ниже). Sidebar history
  из Supabase через raw fetch wrapper (тот же `_sbFetch` паттерн что в
  старом index.html). Past recording экран.
- **Phase 5 — AI + дополнительные экраны.** Summary / Action items /
  templates через tabs внутри transcript view. Settings экран (account,
  usage, defaults). Export modal (.md / .txt / .srt / .json). Empty state,
  Permissions guide. Shortcuts modal в новом стиле. Notes — отдельный
  tab + FAB во время записи.
- **Phase 6 — Mobile + polish.** Mobile breakpoints, hamburger drawer
  для sidebar. Финальная полировка.
- **Phase 7 — Cutover.** Убрать Vercel rewrite `/app → Modal` (в
  `next.config.mjs`). Старый `templates/index.html` в `legacy/` или
  удалить. Обновить README / CLAUDE.md.

**Итого:** ~30-40 часов работы, 5-7 рабочих сессий.

### Открытые решения (приняты в обсуждениях, см. чат)

1. **Studio + Bricolage** (НЕ Bodoni — юзер так захотел)
2. **Accent = mint** (НЕ brand blue, по дизайн-мокапу)
3. **Старое не трогаем** до явного "релиз" от юзера
4. **Settings:** НЕ модели/GPU/CPU (всё в облаке). Внутри:
   account email, plan, usage minutes, defaults (lang, num speakers, theme),
   sign out, danger zone (delete data). Usage tracking нужно добавить в
   backend (счётчик минут на user_id в Supabase) — **новая фича для Phase 5**.
5. **AI tools placement:** табы внутри transcript view (Transcript /
   Summary / Actions / Notes). Templates (sales_call/one_on_one/standup)
   как dropdown рядом с Summary/Actions либо как command palette actions.
6. **Notes:** отдельный таб + FAB "+ Note" во время записи с timestamp
   (FAB → Phase 5, простой textarea таб → Phase 1+).
7. **Login screen** — центрированная карточка на cream/graphite фоне,
   "Welcome back. Sign in to continue.", Continue with Google primary,
   divider "or magic link", email input + Send link button. Лого + theme
   toggle в углу. Дизайн будет финализирован в Phase 4.

### Studio v2 gotchas

- **`min-height: 0` обязателен** на flex-children с `overflow:auto`.
  Без этого flex-item не уважает overflow и контент вылазит за пределы
  родителя без скроллбара. Сейчас стоит на `.s-scroll` (scroll-контейнер
  между topbar и footer).
- **`.toFixed(2)` на ВСЕХ float значениях** в JSX-style (`height`, `width`,
  `transform`). Без него — hydration mismatch: SSR рендерит
  `43.686723035074785%`, CSR — `43.6867%`. Особенно в `Waveform` и
  `MiniWave` (sidebar thumbnails).
- **NPM build кладёт HMR кеш dev сервера.** Если делаешь `npm run build`
  пока `npm run dev` крутится — `.next/server/webpack-runtime.js` конфликтнёт
  и dev упадёт с `Cannot find module './833.js'`. **Лечение:** kill node
  processes → `rm -rf .next` → `npm run dev` снова.
- **Keyboard shortcuts глобальные** — слушаются на `document.keydown` в
  `app/v2/page.tsx`. ⌘K toggle palette, ⌘R toggle recording, Esc blur input.
  CommandPalette имеет свой keyboard handler (↑↓ Enter Esc) активный
  только когда open=true.
- **`data-theme` на `<html>` управляется кодом из обоих мест** — landing
  ThemeToggle и Studio Topbar StudioThemeToggle оба пишут в
  `localStorage.skriptly-theme` + ставят атрибут. Тема одна для всего
  сайта, не отдельная для /v2.
- **Component scoping** — все Studio стили под `.studio-root` (root div
  v2 страницы). Landing использует свои `:root` переменные. Они не
  конфликтуют, но если редактируешь — следи где какие `--var`.
- **CommandPalette overlay z-index 100** — выше всего остального на
  странице. Backdrop с blur. Клик за пределами карточки → закрытие.

### Что НЕ делать

- **Не трогать `templates/index.html`** пока v2 не одобрен. Старый прод
  работает на нём, пользователи активно используют.
- **Не удалять Vercel rewrite `/app → Modal`** в `next.config.mjs` до Phase 7.
- **Не перетаскивать landing components/ в studio/.** Они независимые.
- **Не использовать Tailwind / styled-components** — кодовая база на чистом
  CSS под `.studio-root` scope. Консистентность.
- **Не делать `npm run build` пока `npm run dev` запущен.** Стандартный
  workflow: одно или другое. Build для проверки компиляции — kill dev
  сервер первым.

---

## Deployment

**Production live:** https://skriptly.io

**Стек:**
- **Modal** app `transcriptor-v2` — Transcriptor (A10G) + flask_app (wsgi)
- **Supabase** project `bmonakhktbaliwgobrxv` — Auth (Google + magic link) + Postgres (`public.transcripts` с RLS)
- **Vercel** project `transcriptor-v2` — landing (Next.js, root `landing/`), автодеплой из `main` ветки GitHub
- **DNS** — Porkbun: A `216.198.79.1` для apex, CNAME для www, оба на Vercel
- **Google OAuth** — project Skriptly, client Skriptly Web. **Testing mode** (max 100 test users). Чтобы пустить любого Google-юзера — Publish app в OAuth consent screen.

**Команды деплоя:**
```powershell
# Backend (Modal)
modal deploy modal_app.py

# Frontend landing — автоматом из GitHub push в main
git push origin main  # Vercel сразу собирает и катит на skriptly.io
```

См. `ROADMAP.md` для дальнейших шагов.

## Constraints

- Modal A10G GPU — pay-per-use, idle = 0. Один пользователь за раз с быстрой обработкой; параллельные транскрипции спавнят новые контейнеры (Modal auto-scales).
- Supabase free tier: 500MB DB, 50K MAU, 4 magic link emails/hour.
- Web-only frontend. Mobile via responsive design, native не планируется.
- Только NVIDIA GPU в local mode (CUDA).
