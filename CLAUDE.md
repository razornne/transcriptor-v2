# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## What this is

**Skriptly (transcriptor-v2)** — облачный сервис транскрипции созвонов со спикер-разделением и LLM-обработкой. После Stage 2 архитектура: фронт-енд + бэк-енд на Modal, аутентификация и хранилище через Supabase. Ноут юзера больше не нужен.

v1 (`C:\projects\transcriptor\`) — старая Railway-версия на OpenAI API. **Продолжает работать параллельно, намеренно. Не сливать.**

## Архитектура (Stage 2 — текущая)

```
Browser (index.html)
       │
       │ Supabase JS auth (Google OAuth / magic link)
       ▼
   skriptly.io  (TODO — пока razornne--transcriptor-v2-flask-app.modal.run)
       │
       ├──→ Vercel → static index.html  (TODO — пока Flask serves /)
       │
       └──→ Vercel rewrite /api/* → Modal flask_app  (TODO — пока тот же Modal URL)
                                           │
                                           ▼
                              ┌─────────────────────┐
                              │  Modal Cls          │
                              │  Transcriptor (A10G)│
                              │  - whisper turbo    │
                              │  - pyannote-3.1     │
                              │  - Qwen2.5-7B-Instr │
                              └─────────────────────┘

                              Supabase Postgres
                              ├─ auth.users
                              └─ public.transcripts (RLS, owner-only)
```

**Стек:**
- **Modal** — serverless GPU. Два контейнера в одном app (`transcriptor-v2`):
  - `Transcriptor` cls — A10G GPU, whisper large-v3-turbo + pyannote-3.1 + Qwen2.5-7B-Instruct (4-bit)
  - `flask_app` wsgi — лёгкий CPU контейнер, тонкий прокси
- **Supabase** — Auth (Google + magic link) + Postgres (история транскриптов, RLS)
- **Frontend** — `templates/index.html` сейчас отдаётся Flask, скоро переедет на Vercel

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

### Frontend
- **`templates/index.html`** — single-file (CSS+JS inline). ~3000 строк.

## Common commands

```powershell
# ── Production деплой ─────────────────────────────────────────
# Modal CLI должен быть установлен (pip install modal в venv) и авторизован (modal setup)
modal deploy modal_app.py

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
- **Supabase JS PostgrestClient зависает на `.then()` в нашей среде.** Auth работает, но `sb.from('transcripts').select()` никогда не резолвится. Поэтому raw fetch к `/rest/v1`. Если будут вопросы "почему не SDK" — это причина. Может починится в будущей версии Supabase JS.
- **`?error=...` в URL после неудачного Google OAuth** — Supabase JS не очищает URL, остаётся как параметр. Не критично, но user видит. Идея для cleanup: `history.replaceState({}, '', window.location.pathname)` после успешного `SIGNED_IN`.
- **OAuth consent screen в testing mode** — только добавленные test users могут логиниться через Google. Для широкой аудитории — Publish app в Google Cloud Console.
- **Supabase magic link rate limit** — 4 в час на default SMTP. Custom SMTP (Resend / SendGrid) снимает лимит.

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

## Deployment

**Текущее состояние:** Modal app deployed at `https://razornne--transcriptor-v2-flask-app.modal.run/`. Custom domain `skriptly.io` куплен, ждёт Vercel-фронт (Stage 2C).

**Stack по нашей оси прогресса:**
- Modal: `transcriptor-v2` app (Transcriptor + flask_app)
- Supabase: project `bmonakhktbaliwgobrxv` (Auth + Postgres)
- Domain: `skriptly.io` (Porkbun, Vercel pending)
- Google OAuth: Skriptly project, Skriptly Web client, in testing mode

См. `ROADMAP.md` для дальнейших шагов.

## Constraints

- Modal A10G GPU — pay-per-use, idle = 0. Один пользователь за раз с быстрой обработкой; параллельные транскрипции спавнят новые контейнеры (Modal auto-scales).
- Supabase free tier: 500MB DB, 50K MAU, 4 magic link emails/hour.
- Web-only frontend. Mobile via responsive design, native не планируется.
- Только NVIDIA GPU в local mode (CUDA).
