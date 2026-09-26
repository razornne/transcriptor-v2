# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## What this is

**Skriptly (transcriptor-v2)** — облачный сервис транскрипции созвонов со спикер-разделением и LLM-обработкой. После Stage 2 архитектура: фронт-енд + бэк-енд на Modal, аутентификация и хранилище через Supabase. Ноут юзера больше не нужен.

v1 (`C:\projects\transcriptor\`) — старая Railway-версия на OpenAI API. **Продолжает работать параллельно, намеренно. Не сливать.**

## Текущее состояние (2026-09-25) — читать первым

Схема ниже местами описывает GPU-пайплайн как основной — это история. Сейчас:

| Что | Как устроено |
|---|---|
| Транскрипция записей | **Soniox batch** (`transcribe_soniox`, CPU). Стерео (веб/приложение) → 2 дорожки: микрофон = SPEAKER_00, звонок с диаризацией. GPU `Transcriptor` (Whisper+pyannote) — только Privacy Mode и записи > 295 мин |
| Спикеры | Если задано Speakers — переразметка по голосу (`speakers.py` + `SpeakerEmbedder`, k-means ровно на k). Без Speakers — метки Soniox |
| Коррекция | Gemini 2.5 Flash, один вызов на запись (ответ ≤ 16k токенов — на часовых звонках хвост не правится) |
| Саммари / actions | GPT-6 Luna (`openai_generate`), фоллбэк Gemini 2.5 Pro |
| Заголовки | **LLM выключен** (`TITLE_GENERATION=off`) — первые слова, юзер переименует |
| Живой транскрипт в вебе | **Выключен** (`FEATURE_LIVE_TRANSCRIPT=false`, env `LIVE_TRANSCRIPT` off) |
| Диктовка | Приложение для Windows `desktop/` (Tauri): Soniox real-time напрямую по временному ключу, чистка Gemini Flash, словарь общий с вебом |
| Запись созвонов | Веб (стерео через вкладку) **и** приложение (микрофон + WASAPI loopback) → тот же `/api/transcribe`. Веб — временно, пока нет macOS-приложения |
| Себестоимость | Час звонка ≈ $0.30, загруженный файл ≈ $0.20, 1 000 слов диктовки ≈ $0.03. Калькулятор: https://claude.ai/artifact/7MdjcE6qfMZ7pVed1wV5TF |
| Тарифы (v2, 2026-09-25) | **Free** 60 мин звонков + спикеры, без AI, 1 ч диктовки · **Pro** $12 ($9 за год) / 249 ₴ (2 390 ₴ за год): 600 мин, AI, диктовка «без лимита» (скрытый предел 10 ч) · **Team** $14 ($11) / 229 ₴ (2 190 ₴) за место: **общий пул** 600 мин × мест на воркспейс. **Max и Privacy Mode убраны** (Privacy Mode выключен пустым `PRIVACY_MODE_ALLOWED_PLANS`, код оставлен). Лимиты — `PLAN_LIMITS` + `_usage()` в app.py, тесты `tests/test_plans.py` |
| Оплата | Stripe (live, аккаунт CZ), **Stripe Managed Payments включён 2026-09-26** (MoR: Stripe/Link продаёт и платит VAT; владелец — физлицо в Чехии; проверено live-сессией Checkout). Terms/Privacy обновлены под Link. `_create_checkout_session`: env `STRIPE_MANAGED_PAYMENTS` = `auto` (по умолчанию — пробует `managed_payments`, пока Stripe не включил — обычный Checkout + одно Telegram-уведомление) / `on` / `off`. Цены v2 — USD с `currency_options` UAH, tax-inclusive, Flask находит их по lookup_key (`pro_monthly_v2` … `team_annual_v2`, `_stripe_price_id`) — price ID в секрет не переносятся. Созданы 2026-09-26 через `modal run scripts/stripe_plans_v2.py --apply` (ключ из `stripe-secrets`). stripe-python в образе 15.x: объекты Stripe не dict, `.get()` на них падает — индексировать или getattr. Запасной вариант — Paddle |

План и открытые решения — `ROADMAP.md` → «Next up».

## Архитектура (Stage 2 — production, после Cutover 2026-06-14)

```
Browser
   │
   │ load skriptly.io
   ▼
Vercel (Next.js landing + Ink & Halftone Studio)
   │
   ├─ skriptly.io/              → Next.js landing
   ├─ skriptly.io/app           → Next.js landing/app/app/ (Ink & Halftone Studio — production)
   └─ skriptly.io/api/*         → rewrite to Modal flask_app /api/* (audio bypasses Vercel: прямо на Modal)

УДАЛЕНО: rewrite /app → Modal. Modal GET / теперь 301 → skriptly.io/app.
Старый templates/index.html → legacy/templates/index.html (архив).

Browser JS (on skriptly.io/app)
   │
   │ Supabase JS: auth (Google OAuth / magic link)
   │ window.fetch напрямую на Modal (обходит Vercel Edge 4MB body limit)
   ▼
Modal flask_app (CPU, scale-to-zero)
   │
   │ JWT verify (Supabase JWKS) + роутинг по длительности:
   │   • короткие (<30 мин) → Transcriptor.transcribe_full.spawn()
   │   • длинные  (>30 мин) → transcribe_long.spawn()  (chunked)
   ▼
Modal Transcriptor (A10G GPU, scaledown_window=150)
   - faster-whisper large-v3-turbo (fast, default)
   - faster-whisper large-v3 (best quality, Max plan only)
   - pyannote-3.1 (с bounds min_speakers=1, max_speakers=6)
   - wespeaker embedding model — speaker centroids для сшивания чанков
   - Qwen2.5-7B-Instruct (4-bit) — title generation + fallback STT correction
   - Gemini 2.5 Flash REST call (direct from container) — STT correction
   - методы: transcribe_full (монолит), transcribe_chunk (один чанк), run_llm

Modal transcribe_long (CPU orchestrator, timeout 14400с)  ← ДЛИННЫЕ ЗАПИСИ
   - ffmpeg silence-aware split: ≤10 чанков одной GPU-волной (20-30 мин каждый)
   - параллельный fan-out в Transcriptor.transcribe_chunk на нескольких A10G
   - упавший чанк → gap-маркер, не валит джобу (per-chunk resilience)
   - глобальное сшивание спикеров (своя cannot-link агломеративка по cosine)
   - стич + релейбл + re-merge. Контракт ответа = transcribe_full

Modal gemini_generate (CPU, scaledown_window=60)
   - Gemini 2.5 Pro REST API — summary, action items
   - Полный транскрипт без обрезки (контекст 2M токенов)

Supabase Postgres
   - auth.users (Google OAuth / Email magic link)
   - public.transcripts (RLS, workspace visibility)
   - public.user_profiles (plan, minutes_used, vocabulary JSONB)
   - public.workspaces + workspace_members (collaboration)
```

**Production URLs:**
- **skriptly.io** — landing (Vercel)
- **skriptly.io/app** — Ink & Halftone Studio (Next.js, production после Cutover 2026-06-14)
- **razornne--transcriptor-v2-flask-app.modal.run** — Modal endpoint напрямую (API + 301 редирект на /app)

**Стек:**
- **Modal** — serverless GPU. Функции в одном app (`transcriptor-v2`):
  - `Transcriptor` cls — A10G GPU, whisper large-v3-turbo + pyannote-3.1 + wespeaker embedding + Qwen2.5-7B-Instruct (4-bit). Методы: `transcribe_full` (монолит, короткие), `transcribe_chunk` (один чанк длинной записи), `run_llm` (title/chat/tags)
  - `transcribe_long` fn — CPU оркестратор длинных записей (>30 мин): режет на чанки, фанит `transcribe_chunk` параллельно, глобально сшивает спикеров
  - `gemini_generate` fn — лёгкий CPU контейнер, вызывает Gemini 2.5 Pro REST API для summary/action items (Qwen на длинной аналитике сильно слабее)
  - `flask_app` wsgi — лёгкий CPU контейнер, тонкий прокси + роутинг по длительности
- **Supabase** — Auth (Google + magic link) + Postgres (история транскриптов, RLS)
- **Vercel** — Next.js landing на `skriptly.io`, rewrite только для `/api/*` (аудио идёт прямо на Modal)
- **Frontend приложения** — `landing/app/app/` (Next.js, Ink & Halftone Studio). Старый `templates/index.html` в `legacy/` (архив).
- **Приложение для Windows** — `desktop/` (Tauri 2): диктовка + запись созвонов. См. раздел «Диктовка — приложение для Windows».

**Поток обработки:**
1. Юзер логинится через Supabase Auth (Google или magic link)
2. Запись: `fullRecorder` MediaRecorder `timeslice=5s` → каждый chunk в IndexedDB (autosave для recovery). **ИЛИ** загрузка готового файла (кнопка Upload file, любой ffmpeg-читаемый audio/video)
3. Stop/Upload: blob отправляется на `/api/transcribe` с JWT + `quality` + `duration_sec` form fields
4. Flask валидирует JWT, проверяет план, достаёт personal vocabulary, **prepend'ит топ-30 правых форм** в Whisper `initial_prompt` + строит `correction_hints` (пары wrong→right). **Роутинг по `duration_sec`**: >`LONG_AUDIO_THRESHOLD_S` (1800) → `transcribe_long.spawn(...)`, иначе `transcribe_full.spawn(...)`. Оба → `t_<modal_call_id>`
5. Фронт polling'ует `/api/jobs/<job_id>` каждые 2с → `FunctionCall.from_id(id).get(timeout=0)`. Длинные — таймаут поллинга 60 мин + прогресс "chunk k/N"
6. Внутри Transcriptor/orchestrator: **ffmpeg audio preprocessing** (highpass 80Hz + lowpass 12kHz + anlmdn шумоподавление + loudnorm + acompressor) → Whisper (turbo или large-v3) → pyannote → merger → **Gemini 2.5 Flash STT correction** (с boundary fix + vocab extraction + known-corrections hints) → re-merge consecutive same-speaker → return `{segments, vocab_additions}`. Для длинных — это происходит per-chunk параллельно, затем глобальный стич спикеров
7. На done — segments + vocab_additions возвращаются. Flask добавляет minutes_used, **сохраняет vocab_additions** в `user_profiles.vocabulary` (с frequency tracking, LRU топ-100)
8. Фронт рендерит, сохраняет в Supabase `public.transcripts` через **raw fetch** (Supabase JS PostgrestClient зависает в нашей среде)
9. ~~`/api/title` генерирует заголовок через Qwen~~ — **выключено 2026-09-25** (`TITLE_GENERATION=off`): каждый заголовок поднимал GPU-контейнер (33 с + 150 с простоя ≈ $0.06 — дороже Soniox за получасовой звонок). Эндпоинт отвечает `{title: null}`; заголовок — первые слова, юзер переименовывает сам
10. По кнопке Summary / Action items — `/api/generate` спавнит `gemini_generate.spawn(...)` (Gemini 2.5 Pro), polling через тот же `/api/jobs/<id>` механизм
11. PostHog трекит ключевые ивенты в каждой точке через `/ingest/*` reverse proxy на Vercel (обход adblock'ов)

## Файлы

### Backend (Python)
- **`modal_app.py`** — Modal app definition. Содержит:
  - `image` — GPU образ (CUDA 12.4 + faster-whisper + pyannote + transformers + bitsandbytes + requests). `requests` нужен для прямого HTTP в Gemini API из GPU контейнера (correction pass).
  - `web_image` — лёгкий CPU образ (Flask + flask-cors + pyjwt[crypto] + requests + stripe)
  - `Transcriptor` (cls, A10G) — `load_models()` грузит **две модели Whisper** (turbo + large-v3 для Max), pyannote, **wespeaker embedding model** (для сшивания чанков, cache на Volume), Qwen в `@modal.enter()`. Методы:
    - `transcribe_full(audio_bytes, language, num_speakers, prompt, progress_key, quality, privacy_mode, correction_hints)` → `{"segments": [...], "vocab_additions": [...]}`. Монолит для коротких записей. **ffmpeg preprocessing**: highpass=f=80, lowpass=f=12000, anlmdn (шумоподавление), loudnorm, acompressor — перед передачей в Whisper. Выбирает модель Whisper по `quality`. Pyannote `min_speakers=1, max_speakers=6` если `num_speakers` не задан. После merge — Gemini correction.
    - `transcribe_chunk(wav_bytes, language, num_speakers, prompt, quality, privacy_mode, correction_hints)` — обрабатывает ОДИН чанк длинной записи (готовый 16k wav). Принимает `num_speakers` — пробрасывается из Flask через `transcribe_long` в каждый чанк (раньше не передавался, спикер-каунт юзера игнорировался). Дополнительно возвращает `embeddings` (до `EMB_PER_SPEAKER` L2-нормированных векторов на локального спикера, через `_speaker_centroids`) для глобального сшивания.
    - `run_llm(prompt, max_tokens, temperature)` — title / chat / tags через Qwen 7B.
  - `transcribe_long(audio_bytes, ...)` — **CPU оркестратор длинных записей** (`orchestrator_image`, timeout 7200с). ffmpeg silence-aware split (`_plan_chunk_boundaries`, `_parse_silences`) на `CHUNK_LEN_S`-чанки → `Transcriptor().transcribe_chunk.spawn(..., num_speakers=num_speakers, ...)` параллельно (num_speakers теперь пробрасывается в каждый чанк) → глобальная кластеризация спикеров (numpy, cosine, `GLOBAL_SPK_THRESHOLD`) → стич с offset + релейбл local→global + re-merge. Контракт ответа = transcribe_full. Прогресс в modal.Dict ("chunk k/N").
  - `_correct_segments` стратегия: Gemini 2.5 Flash → Qwen fallback на ошибке. `_correct_segments_gemini` принимает `correction_hints` (пары wrong→right юзера) + собирает `vocab_additions` (теперь **list of dicts** `{wrong, right}` через `_extract_vocab_pairs`/difflib).
  - **Env-константы:** `CHUNK_LEN_S` (1200, базовая длина чанка), `MAX_PARALLEL_CHUNKS` (10, лимит GPU-волны — планировщик целится в ≤ этого числа чанков), `MAX_CHUNK_LEN_S` (1800, кап длины чанка), `GLOBAL_SPK_THRESHOLD` (0.68, cosine-порог сшивания спикеров при cannot-link кластеризации — ниже = больше спикеров), `EMB_PER_SPEAKER` (6, embedding'ов на локального спикера), `HALLUCINATION_SILENCE_S` (2.0, анти-галлюцинация Whisper), `WHISPER_MODEL`, `LOAD_BEST_QUALITY`, `EMBEDDING_MODEL`, `CORRECTION_MODEL`, `GEMINI_MODEL`.
  - `gemini_generate(prompt, max_output_tokens, temperature)` — CPU функция на `web_image` для summary/actions через Gemini 2.5 **Pro**. Промпт строится с `{detail_hint}`/`{focus_hint}` (детальность + фокус).
  - `flask_app()` — `@modal.wsgi_app()` декоратор. Принудительно `USE_MODAL=true`.

- **`app.py`** — Flask backend. Эндпоинты:
  - `GET /api/health` — без auth
  - `POST /api/transcribe` (auth) — принимает `audio`, `language`, `num_speakers`, `prompt`, `quality`, **`duration_sec`**. Достаёт `user_profiles.vocabulary` → `_build_vocab_prompt` (топ-30 в Whisper prompt) + `_build_correction_hints` (топ-20 пар wrong→right). **Роутинг по `duration_sec > LONG_AUDIO_THRESHOLD_S`** → `transcribe_long` (long) или `transcribe_full` (short). → `{job_id: "t_<id>"}`. Сохраняет `_job_user`/`_job_language` для vocab save.
  - `POST /api/generate` (auth) — Summary / actions → `gemini_generate` (Pro). Принимает **`detail`** (short/medium/detailed) + **`focus`** → `_build_generate_extras` подставляет `{detail_hint}`/`{focus_hint}` в `GENERATE_TEMPLATES`.
  - `POST /api/vocabulary` (auth) — **ручное управление словарём** (rename/delete/add из Insights дашборда И Settings modal). Принимает весь массив, валидирует/санитизирует/cap, сохраняет в `user_profiles.vocabulary` через service role.
  - `POST /api/chat` (auth) — Q&A по транскрипту → `{job_id: "c_<id>"}`
  - `GET /api/jobs/<job_id>` (auth) — `FunctionCall.from_id(...).get(timeout=0)`. На done транскрипции **трекит minutes_used + сохраняет vocab_additions** в профиль юзера.
  - `POST /api/title`, `/api/tags`, `/api/transcribe-chunk` (sync, Qwen)
  - `GET /api/profile` (auth) — план/лимиты/usage + **`vocabulary`** (для дашборда). `POST /api/stripe/*` (биллинг), `POST /api/profile/privacy-mode`.
  - **Workspace API**: `GET/POST/DELETE /api/workspace`, `POST /api/workspace/invite`, `DELETE /api/workspace/members/<id>`, `POST /api/workspace/leave`, `POST /api/workspace/accept`
  - `GET /` — отдаёт `templates/index.html` (через Modal Flask)
  - **JWT middleware**: `_require_jwt()` валидирует через JWKS (HS256 legacy + ES256/RS256 new). Только `/api/health` без auth.
  - **Vocabulary helpers**: `_get_user_vocabulary()`, `_save_vocabulary_additions()` (принимает list of dicts `{wrong,right}`), `_build_vocab_prompt()` (правые формы → Whisper), `_build_correction_hints()` (пары → Gemini), `LONG_AUDIO_THRESHOLD_S` (1800).
  - **Dual mode**: `USE_MODAL=true` (production) vs local dev (Python threads + Ollama).

- **`transcriber.py`** — local mode only. faster-whisper wrapper.
- **`diarizer.py`** — local mode only. pyannote wrapper.
- **`merger.py`** — общий для Modal и local. Гибридный word-level alignment:
  - **Majority-vote для коротких сегментов** (`SHORT_SEGMENT_THRESHOLD_S=2.0`): если Whisper выдал блок ≤2с и в нём ≥70% слов одного спикера — присваиваем весь блок этому спикеру. Лечит микро-ABAB ping-pong от pyannote-шума на быстрых репликах.
  - **Word-level split для длинных сегментов** (>2с) — режем в местах смены спикера. Лечит случай склейки Whisper'ом быстрого диалога.
  - **Iterative smoothing** (`SMOOTH_THRESHOLD_S=1.0` default, было 0): сегменты короче 1с между одинаковыми соседями переназначаются. До 3 проходов (`SMOOTH_PASSES`).
  - **Forward/backward-fill** для `SPEAKER_UNKNOWN` на первых словах сегмента.

### Migrations (`migrations/`)
- **`001_workspace.sql`** — workspaces + workspace_members + transcripts.visibility/workspace_id + RLS. **Дроп `workspaces_member_select`** обязателен — без этого infinite recursion в RLS.
- **`002_vocabulary.sql`** — `user_profiles.vocabulary JSONB` — auto-learned терминология (термины которые Gemini correction исправил → шевелятся в `initial_prompt` следующего Whisper'a).
- **`003_referrals.sql`** — `user_profiles.referral_code` (UNIQUE) + `referred_by` + `bonus_minutes`. +60 мин обоим за каждый успешный реф.
- **`004_team_billing.sql`** — `workspaces.plan/stripe_customer_id/stripe_subscription_id/seats/billing` — per-seat Team подписка (Stripe quantity-based).
- **`005_notion.sql`** — `user_profiles.notion_access_token / notion_workspace_id / notion_workspace_name / notion_default_parent_id / notion_connected_at` — OAuth credentials для "Send to Notion".
- **`006_signup_notified.sql`** — `user_profiles.signup_notified_at TIMESTAMPTZ` — флаг чтобы Telegram-ping на новый signup стрелял ровно один раз (профиль создаётся Supabase-триггером, не нашим кодом — без флага никакой "create new profile" branch не срабатывает).
- **`007_privacy_mode.sql`** — `user_profiles.privacy_mode BOOLEAN` — toggle для Max/Team чтобы транскрипция и AI шли через self-hosted модели (никакого Gemini).
- **`008_vocabulary_pairs.sql`** — расширяет формат элемента `user_profiles.vocabulary` опциональным полем `wrong` (исходная ошибочная форма). Хранит пару `wrong→right` из Gemini-правок → подаётся Gemini correction как "known corrections" на будущих транскрипциях. DDL не нужен (JSONB), только обновление COMMENT.
- **`009_custom_presets.sql`** — `user_profiles.presets` + `workspaces.presets` JSONB. **Фича кастомных пресетов удалена 2026-09-24** (решение владельца: бесполезна) — колонки остались, код ими не пользуется.
- **`010_speaker_names.sql`** — `transcripts.speaker_names JSONB DEFAULT '{}'` — карта `raw-лейбл → отображаемое имя` (например `{"SPEAKER_00": "Alice"}`). Используется endpoint `/api/entries/<id>/rename-speaker`. Пустая карта = дефолтные "Speaker N" лейблы.
- **`011_capture_stats.sql`** — `public.capture_stats`: телеметрия захвата на каждую запись (есть ли звук вкладки, уровни, секунды тишины по каналам, отвалы/переключения микрофона в `events` JSONB, браузер/ОС). `recording_id` — связь с сохранённым аудио того же звонка. Пишется с клиента после Stop.
- **`012_recordings.sql`** — `public.recordings`: индекс архива аудио в Cloudflare R2 (`storage_key`), метаданные записи, **сырой** результат пайплайна (`segments`, до правок юзера) или `error`. `id` = `recording_id` (= `capture_stats.recording_id`). Только service role (RLS без политик).
- **`013_recordings_corrections.sql`** — `recordings.corrections` (что поменяла LLM-коррекция) + `recordings.channel_mode`.
- **`015_dictation_usage.sql`** — `user_profiles.dictation_seconds_pending/total` + RPC `add_dictation_seconds(p_user_id, p_secs)` (только service role): секунды диктовки копятся, каждые полные 60 с уходят в `minutes_used`. **Заменено миграцией 016.**
- **`016_plans_v2.sql`** — тарифы v2: диктовка — своя квота (`dictation_seconds_month` + `dictation_month`, RPC `add_dictation_seconds` больше не трогает `minutes_used`); пул минут Team (`workspaces.minutes_used/minutes_month` + RPC `add_workspace_minutes`); Max → Pro. Счётчики с меткой месяца: RPC обнуляет их в новом месяце, Flask считает счётчик прошлого месяца нулём.
- **`014_user_emails.sql`** — email рядом с id для чтения таблиц в дашборде: `user_profiles/transcripts/capture_stats.user_email`, `workspaces.owner_email`. Заполняет триггер `fill_user_email` из `auth.users` (клиент не подделает), `sync_user_email` на `auth.users` обновляет копии при смене email. Приложение эти колонки не читает.

### STT: Soniox — основной путь (с 2026-09-24)
- `/api/transcribe` → `transcribe_soniox` (CPU, `soniox_image`) для всех, **кроме Privacy Mode и записей > 295 мин** (лимит Soniox 300 мин/файл) — те идут в старый GPU-пайплайн (`transcribe_full`/`transcribe_long`). Откат для всех: env `STT_PROVIDER=selfhost` на flask_app.
- Выбор по `tests/score_stt.py`: эталон (uk/ru/pl/cs/en, чистый+телефонный) — Soniox WER 2.4% / 0% пропущенных слов против 3.7% / 1.3% у Whisper+pyannote; на реальном 54-мин звонке на 4 человека — больше слов и чистые границы реплик; $0.10/ч против ~$0.41.
- Поток: `_classify_channels` → моно-файл в родном формате (ogg/webm/mp3/wav/flac) уходит **как есть**, иначе `_encode_for_stt` (opus 64k, исходная частота — **не** 16k/32k: пережатие стоило Soniox спикера и ~4% слов) → `soniox.transcribe` (dual: 2 сессии параллельно, микрофон без диаризации) → `tokens_to_words` → `words_to_segments` → `drop_echo`/`interleave` (channels.py) → `_gemini_correct_segments` (module-level, без Qwen-фоллбэка) → `_merge_same_speaker`.
- Словарь юзера → `context.terms`, поле «Context» → `context.text` (`soniox.build_context`). Секрет `soniox-secrets` (SONIOX_API_KEY). Файлы/транскрипции у Soniox удаляются сразу (лимит 1000/2000 на аккаунт).
- **Известное ограничение:** у Soniox нельзя задать число спикеров, и похожие голоса он путает. Звонок 24.09 (68 мин, 3 собеседника в канале звонка): двое под одной меткой, третий расщеплён, метка «Максима» стояла на чужих репликах с первых секунд, хотя он подключился на 7-й минуте.
- **Переразметка по голосу (с 2026-09-24):** если юзер задал Speakers (dual: > 2, моно: ≥ 2) — `_voice_relabel` считает эмбеддинги реплик дорожки (`SpeakerEmbedder`: CPU, только wespeaker, ~0.2 с/реплику) и `speakers.relabel` кластеризует их k-means'ом (косинус, k-means++) ровно на k. Центры ближе `MIN_SEPARATION` (0.3) или мало речи → метки Soniox как есть; любой сбой — тоже. Короткие реплики (< 1 с) берут метку ближайшей реплики с той же исходной меткой. Агломеративка (как в transcribe_long) на этом звонке сваливала всех в один кластер — поэтому k-means. Эталон: 0% ошибок до и после (регрессии нет); `tests/eval_speaker_relabel.py`, `tests/test_speakers.py`. Без Speakers — метки Soniox (авто-режим не делали).
- В архиве `recordings.quality = "soniox"`. Тесты: `tests/test_soniox.py`.

### Живой транскрипт во время записи (с 2026-09-24, **выключен 2026-09-25**)
- **Выключен ради себестоимости** (решение владельца): два потока Soniox RT удваивали стоимость часа записи ($0.24/ч сверху). Веб: `FEATURE_LIVE_TRANSCRIPT = false` в page.tsx; бэкенд: `/api/live/token` без `purpose=dictation` отдаёт 503, пока на flask_app не выставлен `LIVE_TRANSCRIPT=on`. Диктовку это не касается. Код ниже оставлен, чтобы вернуть одной строкой.
- Браузер стримит звук **напрямую в Soniox real-time** (`wss://stt-rt.soniox.com`, `stt-rt-v5`) по **временному ключу** от `POST /api/live/token` (`soniox.create_temporary_key`: `usage_type=transcribe_websocket`, живёт 120с — нужен только на открытие сокета; `max_session_duration_seconds` = остаток минут юзера; `client_reference_id = live:{user_id}:{recording_id}` — для подсчёта себестоимости по usage-логам Soniox). Постоянный `SONIOX_API_KEY` не покидает сервер (`soniox-secrets` теперь и на `flask_app`).
- **Это предпросмотр.** Финальный транскрипт после Stop — как раньше, `/api/transcribe` (batch-модель точнее + коррекция + словарь). Минуты списываются только там. Живой текст остаётся на экране, пока готовится финальный, и если финальный упал.
- Клиент: `landing/lib/ink/live.ts` (`LiveTranscript`), панель `components/ink/LivePanel.tsx`. Каналы как в batch: стерео → две сессии (микрофон без диаризации = SPEAKER_00, звонок с диаризацией, если `numSpeakers` не 1/2), только микрофон → одна с диаризацией; Free-план → всё одним спикером. Звук — WebM/Opus из MediaRecorder на моно-потоках `Recorder.liveStreams` (audio.ts, микрофон через `micBus` переживает смену устройства), `audio_format: "auto"`.
- Эхо собеседника в микрофоне режется на клиенте (`dropEcho`): как `channels.drop_echo` + вырезание фраз эха (≥2 совпавших слов подряд) внутри реплик.
- Обрыв → новый ключ, новый MediaRecorder, до 5 неудачных попыток подряд, потом `off`. 402/403/503 от `/api/live/token` = не повторять (Privacy Mode → 403: звук не должен уходить третьим лицам). Выключатель: env `LIVE_TRANSCRIPT=off` на flask_app.
- Стоимость: Soniox RT биллит длительность потока — $0.12/ч на сессию, т.е. до $0.24/ч при стерео, поверх $0.10/ч batch. PostHog: `live_transcript_started` / `_unavailable` / `_stopped {reconnects, words, channels, status}`.

### Диктовка — приложение для Windows (`desktop/`, с 2026-09-24)
- Tauri 2 (Rust + два статичных HTML в `desktop/ui/`), живёт в трее. **Держишь Ctrl+Win — говоришь — отпустил → текст вставлен в активное окно.** Двойной тап — hands-free (ещё раз Ctrl+Win — закончить), Esc — отмена, Ctrl+Win+другая клавиша (системные шорткаты) — отмена. Подробности и сборка — `desktop/README.md`.
- Звук идёт **из приложения прямо в Soniox** (`stt-rt-v5`, pcm_s16le 16 кГц) по временному ключу `/api/live/token` с `purpose=dictation` (ключ живёт час и кэшируется — диктовка не ждёт холодный старт Flask). Бэкенд видит только: `POST /api/dictation/usage {seconds}` (→ RPC `add_dictation_seconds`, миграция 015: секунды копятся и по 60 уходят в общий `minutes_used`) и `POST /api/dictation/cleanup {text}` (переключатель «Polish with AI»: Gemini 2.5 Flash прямо из Flask, `thinkingBudget=0`, ~0.5–1 с; убирает паразиты и применяет самоисправления, словарь юзера как термины; модель ответила/перевела вместо чистки → `_cleanup_is_sane` вернёт исходный текст). Privacy Mode: ключ не выдаётся (403), чистки нет.
- Вход: системный браузер + PKCE, loopback `http://127.0.0.1:53682/callback` — **должен быть в Supabase Auth → Redirect URLs**. У приложения своя сессия Supabase (не общая с вебом).
- Gotchas: хук `WH_KEYBOARD_LL` игнорирует синтетические нажатия (LLKHF_INJECTED) — автотестом хоткей не нажать; отпускание Win глотается и перевбрасывается после `vkE8`, иначе открывается «Пуск». Плашка — `WS_EX_NOACTIVATE|WS_EX_TRANSPARENT`, показ через `SetWindowPos(SWP_NOACTIVATE)`: фокус не уходит из приложения, куда вставляем. Состояние Tauri регистрируется на билдере, а не в `setup()` — окна из конфига грузятся раньше setup. Вставка: буфер обмена + Ctrl+V после отпускания модификаторов (Win+Ctrl+V = системная панель звука), старый буфер (текст/картинка) возвращается.
- **Запись созвонов** (с 0.2.0): L = микрофон, R = звук компьютера через WASAPI loopback (тот же стерео-формат, что у веба) → WAV на диск во время записи (переживает падение; неотправленные записи видны в окне — Transcribe/Discard) → Ogg Vorbis → обычный `/api/transcribe` → строка в `public.transcripts` (как веб `insertEntry`) → заголовок `/api/title`. Бэкенд для этого не менялся. «Open transcript» → `skriptly.io/app?entry=<id>` (page.tsx выбирает запись и чистит параметр). Loopback в тишине не отдаёт данных — микшер (`recorder::Mixer`) выравнивает каналы по настенным часам и досыпает нули.
- **Два шортката** (с 0.4.0, вместо двойного нажатия): «удерживать» (`settings.hotkey`, по умолчанию Ctrl+Win) и «закрепить» (`settings.lock_hotkey`, Ctrl+Win+Space). Если «закрепить» шире «удерживать» (Alt → Alt+Z, как в Wispr Flow), удержание «защёлкивается» нажатием лишней клавиши; не-модификатор сочетания глотается. `validate_pair` запрещает «закрепить» ⊆ «удерживать». `save_settings` шорткаты не трогает (окно держит старую копию настроек — затирало). Тесты последовательностей — через `hotkey::handle` в `cargo test`.
- **Баг 0.1–0.3: настройки не сохранялись вовсе** (`settings.json` не менялся с первого запуска) + запись нового шортката обрывалась: окно отменяло её на `blur`, а капсула раз в секунду поднималась SetWindowPos(SWP_SHOWWINDOW) и сбивала фокус. 0.4.0: `Store::write` логирует ошибки и при сбое rename пишет напрямую; отмены по blur нет; капсула поднимается раз в 15 с без SWP_SHOWWINDOW.
- **Словарь в приложении** (с 0.4.0): тот же `user_profiles.vocabulary`, что Settings → Vocabulary в вебе (`/api/profile` → `/api/vocabulary`). Термины уходят в Soniox как `context.terms` (зашиты в ключ — после правки `forget_token`) и в чистку текста.
- При тестах тестовую сборку закрывать по пути (`Get-Process skriptly | ? Path -like *debug*`), а не `taskkill /IM skriptly.exe` — это убивает и установленное приложение владельца. Плашка показывает только анимацию записи, без текста; в покое — капсула внизу экрана (`show_bar`, прячется над полноэкранными окнами).
- Окно плашки в покое ужимается до капсулы (64×20) и `set_ignore_cursor_events(true)`: одного WS_EX_TRANSPARENT мало — дочернее окно WebView2 ловило клики по невидимой части (поле ввода над панелью задач не нажималось).
- «Pause media while dictating» (`media.rs`): через Global System Media Transport Controls ставит на паузу только реально играющие сессии и после вставки возобновляет их. Не Play/Pause-клавиша — она включила бы музыку, если ничего не играло.
- Выбран язык → `language_hints_strict` (только в диктовке: на созвонах языки мешают). «Instant start» (`mic.rs`) держит микрофон открытым + 0.5 с pre-roll: иначе BT-гарнитура теряет первые ~0.5 с на переключение в режим звонка; плашка «arming» (серая точка) до первого звука, в логе `first audio N ms after the shortcut`.
- Установщик неподписанный (NSIS, per-user) — для своих; SmartScreen: «Подробнее» → «Выполнить в любом случае». Тесты: `cargo test` (ресемплер), `cargo test -- --ignored` (живой прогон stt.rs против Soniox с `SKRIPTLY_TEST_KEY`/`SKRIPTLY_TEST_PCM`).

### Двухканальные записи (L = микрофон, R = звонок)
- `_prepare_audio` (modal_app.py) декодирует запись в 16k стерео и по `channels.ChannelStats` решает: `dual` (каналы разные → два wav), `left_only`/`right_only` (звучит один канал → он), `mono` (моно-файл или dual-mono → даунмикс как раньше). Моно-путь не изменился.
- `dual` в `transcribe_full` (`_label_dual`) и в чанках `transcribe_long` (`call_wav_bytes`): Whisper по каждому каналу → `split_on_pauses` (faster-whisper с VAD склеивает реплики через паузу, иначе каналы не чередуются) → `drop_echo` (эхо собеседника из колонок в микрофоне) → pyannote ТОЛЬКО на канале звонка и только если собеседников может быть >1 (num_speakers не задан или >2) → `interleave`. Владелец микрофона — всегда `SPEAKER_00`. num_speakers=1 (Free) → всё одним спикером.
- Gemini-коррекция в dual-режиме с `speakers_fixed=True`: без boundary-fix, смена спикера запрещена (спикер известен по каналу).
- Ответ содержит `channel_mode`. Логи: `[audio] channels=… corr=…`.
- Тесты: `tests/test_channels.py`. Проверено на GPU на синтетическом стерео-звонке (чешский TTS + эхо 25%/200мс): 2 спикера — 0% ошибок разметки, эхо вычищено, длинный пайплайн так же.

### Архив записей (работа над ошибками)
- Каждая транскрипция (запись и upload, **кроме Privacy Mode**) → копия аудио в R2 `recordings/{user_id}/{recording_id}.{ext}` + строка в `public.recordings`. Делает `/api/transcribe` фоновым потоком (`_archive_recording`) после spawn; результат джобы (`segments`/`error`) дописывает `/api/jobs/<id>` (`_archive_job_result`, PATCH по `job_id`). Всё best-effort — сбой архива не ломает транскрипцию. **Удаление аккаунта** (`/api/account/delete`) стирает префикс `recordings/{user_id}/` в R2 (`_r2_delete_prefix`); строки `recordings`/`capture_stats` уходят каскадом с `auth.users`. Раскрыто в Privacy Policy (2026-09-26: 90 дней, доступ только у основателя, не для обучения).
- Фронт шлёт `recording_id` (из `startRecording`, для upload — новый uuid) и `source` (`record`/`upload`) в FormData.
- Секрет `r2-secrets` (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET; опционально R2_ENDPOINT — только для бакета с юрисдикцией EU) на `flask_app`. Хранение 90 дней: lifecycle-правило бакета в дашборде Cloudflare + `recordings.expires_at`.
- **`/app/review`** — админка (ADMIN_EMAILS): список записей с флагами проблем, плеер с раздельным прослушиванием каналов (L=микрофон, R=звонок) через ChannelSplitter, телеметрия + журнал событий, сырой транскрипт (клик → перемотка). Аудио проксируется через `/api/admin/recordings/<id>/audio` — CORS на бакете не нужен.
- Миграции выполняются **вручную через Supabase SQL Editor** — нет миграционного фреймворка. После добавления новой — обновить эту секцию + сам файл должен начинаться с комментария "Run in Supabase SQL Editor".

### Frontend — приложение
- **`landing/app/app/`** — **production** после Cutover 2026-06-14. Ink & Halftone Studio: Next.js App Router, полный функционал транскрипции (запись, upload, AI tools, история, биллинг, настройки). Подробнее — `## Ink & Halftone Studio (/app)` секция.
- **`legacy/templates/index.html`** — архив старого single-file приложения (~5200 строк, CSS+JS inline). **НЕ редактировать** — только как reference.

### Frontend — landing (Next.js)
- **`landing/`** — Next.js 15 проект, деплоится на Vercel как `skriptly.io`.
  Держит ДВЕ независимые поверхности:

  **Landing (`/`) — Sprint 12: полностью пересобран под Ink & Halftone:**
  - `app/layout.tsx` — root layout, шрифты (Bricolage Grotesque + Instrument Serif italic + Onest UA + Manrope + JetBrains Mono), theme bootstrap, JSON-LD FAQ schema
  - `app/page.tsx` → монтирует `LandingClient`
  - `app/globals.css` — дизайн-токены Ink & Halftone (`--paper`, `--ink`, `--accent`, `--signal` + типо-токены). Shared с `/app` Studio через CSS custom properties на `:root`. Содержит все секции лендинга: trust-bar, inapp-mock, use-cases, faq, final-cta.
  - `components/` — Nav, Hero (Bricolage + Instrument Serif editorial pair), Social (trust bar), HowItWorks, Features (halftone icon pattern), Breakout (InsideApp sidebar), UseCases (tabs), Pricing, FAQ (grid-template-rows accordion), FinalCTA, Footer + SegToggle, ThemeToggle, AppMock, Logo
  - `lib/content.ts` — EN/UA копирайтинг + 4 тарифа (Free $0 / Pro $15 / Max $29 / Team $14) + `useCases` + `faq` секции
  - `lib/hooks.ts` — useTypewriter, useReveal, useParallax, useTween

  **Ink & Halftone Studio (`/app`) — production:**
  - `app/app/{layout,page}.tsx` — root layout + главный экран (монтирует все ink-компоненты)
  - `app/app/ink.css` — все стили Studio под `.i-*` namespace
  - `components/ink/` — DotField (canvas background), InkSidebar, InputCard (rec + upload), LoginScreen, ResultView (transcript + tabs), SettingsModal (7 tabs incl. Vocabulary), UpgradeCard
  - `lib/ink/` — api.ts (Modal backend), audio.ts, config.ts, db.ts (Supabase CRUD), idb.ts (IndexedDB), keepalive.ts, settings.ts, supabase.ts

  **Общие настройки:**
  - `next.config.mjs` — rewrites `/app` и `/api/*` на Modal endpoint (API сейчас обходится напрямую с фронта, см. ниже)
  - Production deploy: Vercel автодеплоит при push в `main`. Root Directory: `landing/`.

## Common commands

```powershell
# ── Landing dev (Next.js) ──────────────────────────────────────
cd landing
npm install               # один раз
npm run dev               # → http://localhost:3000 (landing)
                          #   http://localhost:3000/app (Ink & Halftone Studio)

# Производственный билд (НЕ запускать пока dev сервер крутится —
# затрёт .next кеш и dev упадёт с "Cannot find module './833.js'")
npm run build             # сначала pkill node, потом rm -rf .next, потом build

# Восстановление после порчи .next:
Stop-Process -Name node -Force
Remove-Item -Recurse -Force .next
npm run dev

# ── Production деплой ─────────────────────────────────────────
# Modal CLI должен быть установлен (pip install modal в venv) и авторизован (modal setup)
# ВАЖНО: PYTHONUTF8=1 обязателен на Windows (без него charmap codec падает на ✓ эмодзи)
$env:PYTHONUTF8 = "1"
modal deploy modal_app.py

# Frontend (Vercel) автоматом при git push в main

# Modal Secrets разбиты на несколько небольших, привязанных к flask_app:
#   • transcriptor-secrets — основные (HF, Supabase, Gemini)
#   • notion-secrets       — Notion OAuth client_id + secret
#   • admin-secrets        — Telegram bot token + chat_id + ADMIN_EMAILS
#   • stripe-secrets       — live Stripe key, webhook secret, 6 price IDs
# --force заменяет КАЖДЫЙ секрет целиком — нужно указывать все ключи в нём.

modal secret create transcriptor-secrets `
  HF_TOKEN=hf_... `
  SUPABASE_URL=https://bmonakhktbaliwgobrxv.supabase.co `
  SUPABASE_SERVICE_ROLE_KEY=eyJ... `
  GEMINI_API_KEY=AIza... `
  --force

modal secret create stripe-secrets `
  STRIPE_SECRET_KEY=sk_live_... `
  STRIPE_WEBHOOK_SECRET=whsec_... `
  STRIPE_PRO_MONTHLY_PRICE=price_... STRIPE_PRO_ANNUAL_PRICE=price_... `
  STRIPE_MAX_MONTHLY_PRICE=price_... STRIPE_MAX_ANNUAL_PRICE=price_... `
  STRIPE_TEAM_MONTHLY_PRICE=price_... STRIPE_TEAM_ANNUAL_PRICE=price_... `
  --force

# admin-secrets и notion-secrets — отдельными командами по той же схеме

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

Линтера и билд-шага нет. **Тесты есть**: `tests/test_*.py` — чистая логика
(merger, планировщик чанков, кластеризация спикеров, map-reduce сплиттер).
Запуск: `python tests/test_merger.py` (или все: каждый файл — самодостаточный
runner; merger-тесты идут на голом Python, остальным нужен numpy/modal из venv).

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
- **Delete UX — двойное подтверждение + undo:** первый клик на `×` меняет кнопку на `Delete?` (красный) на 3с. Второй клик → запись убирается из `_historyCache` и UI мгновенно, показывается `showUndoToast`. Реальный `DELETE` в Supabase идёт через 7 секунд (`_pendingDelete.timer`). Клик Undo — `clearTimeout` + `_historyCache.unshift(entry)` + `renderHistory()`, в DB ничего не летит. Клик `×` на тосте — немедленный DELETE без ожидания.

### Запись
- **Один MediaRecorder** (`fullRecorder`) на mix микрофона + getDisplayMedia через AudioContext. `start(5000)` timeslice → каждый chunk в IndexedDB (см. Audio safety net)
- На Stop: blob → `/api/transcribe` (multipart form) → async job → poll → segments
- **Upload file** (`#uploadBtn` + `#audioFileInput`): `uploadAndTranscribe(file)` достаёт длительность через скрытый media-элемент (`getMediaDuration`), выставляет `recordingDurationSec` и переиспользует тот же `transcribeBlob`. Бэкенд `/api/transcribe` принимает любой ffmpeg-читаемый файл (audio/video). Длинные файлы автоматом → chunked long-pipeline. Guard на `isRecording`/`waitingForFull`.

### Job polling
- `submitJob(url, body, isFormData)` — POST через `authFetch`, возвращает `job_id`. **Важно:** 402 проверяется ДО `safeJson(res)` — иначе нестандартное тело ответа (HTML страница ошибки от прокси) роняет `safeJson` и `upgradeRequired` никогда не ставится, юзер видит generic error вместо upgrade prompt.
- `pollJob(jobId, onProgress)` — каждые 2с GET `/api/jobs/<id>` через `authFetch`. На done — возвращает result. **Прогресс сейчас не работает в Modal-режиме** (только `processing` без granular статуса) — UX-косметика, можно вернуть через `modal.Dict` если нужно

### Tab keep-alive (для долгих созвонов в background-вкладке)
- **Silent audio** — `OscillatorNode` gain=0.0001 → браузер не дискардит вкладку
- **Wake Lock API** — `navigator.wakeLock.request('screen')` на старте, re-acquire на `visibilitychange`
- **OS Notifications** — `Notification.requestPermission()` + `notify(title, body)` для started/ready/failed
- **Battery warning** — confirm если не charging + level<40%
- **Pre-recording limit check** — первым делом в `startBtn` handler: если `currentMinutesUsed >= currentMinutesLimit` → блокируем запись, показываем upgrade prompt (без запроса разрешений). Если осталось ≤30 мин → confirm с предупреждением. `upgrade_prompt_shown` стреляет в PostHog в обоих случаях.

### Audio safety net (3 уровня)
- `lastRecordingBlob` — после Stop держим blob в памяти. Если /api/transcribe упал → recovery box: Retry / Download / Discard
- `beforeunload` warning при непустом blob
- IndexedDB autosave — `idbCreateSession / idbAppendChunk / idbDeleteSession`. Каждый chunk пишется. На load `idbGetOrphanedSessions()` находит незавершённые → confirm recovery

### Переименования и UI
- **Speaker rename**: клик по `.speaker-name` → inline input → Enter сохраняет в `currentSpeakerNames[rawLabel]`. Имена идут в DB через update entry. **Hint-иконка ✎** появляется при hover на имя спикера — напоминает что можно нажать.
- **Auto-title + progressive UI**: `autoSuggestTitle()` ставит placeholder из первых ~6 слов. `requestLLMTitle()` запускает LLM в фоне, рендерит `✨ thinking…` placeholder. Если юзер кликнул и переименовал руками — `currentTitleIsAuto=false`, LLM не перетирает
- **Inline edit транскрипта** — двойной клик на текст или ✎ hover-кнопка → textarea (auto-sized). Enter save, Esc cancel, Shift+Enter newline. Помечает `seg.edited`

### Контент-секции (Tabs UI)
- **Tab bar**: `Transcript | Summary | Actions`. Появляется когда `hasSegments`. Notes-таб **удалён** (2026-06-29). Под капотом — три `tab-panel` div'а, видимость управляется `switchTab(name)`.
- **Transcript tab** — сам транскрипт + copy/download .md кнопки + recovery box + error box
- **Summary tab** — generate button → результат от Gemini Pro (или upgrade prompt для Free). Loading spinner пока генерация.
- **Actions tab** — то же что Summary, но шаблон "actions". Каждый таб имеет дот-индикатор `.tab-has-content` если результат уже есть.
- `renderAIPanel(template)` — рендерит один панель (Summary или Actions). `runAI(template)` спавнит job, обновляет таб с loading state, парсит результат.
- **Detail + Focus контролы** (`.ai-controls`, статичный HTML над `#summaryPanel`/`#actionsPanel`, не перерисовывается `renderAIPanel`): сегмент-контрол Short/Medium/Detailed (`aiDetailPref`, глобальный пресет в localStorage `transcriptor_settings.aiDetail`) + поле Focus (`#summaryFocus`/`#actionsFocus`). `runAI` шлёт `detail`+`focus` в `/api/generate`; бэк через `_build_generate_extras` подставляет `{detail_hint}`/`{focus_hint}` в `GENERATE_TEMPLATES`. Regenerate перечитывает текущие значения.
- `currentAIResults` хранит результаты обоих templates в памяти. При загрузке из истории — восстанавливается.

### Insights дашборд (`#dashboardModal`)
Оверлей "Insights" (кнопка-график `#sidebarInsightsBtn` в sidebar-user рядом с шестерёнкой). `renderDashboard()` считает всё **клиентски** из `_historyCache` (segments→длительность `max(segment.end)`, lang, created_at) + профиля (`currentMinutesUsed/Limit`) + `currentVocabulary` (топ-термины, `vocabulary` добавлен в `/api/profile`). Метрики: записей всего, всего часов, за месяц, использование лимита, активность 14 дней, языки, топ-термины. Графики — чистый CSS (`.dash-*`), без библиотек. Миграция не нужна. **v1 в `/app`; план — перенести в v2 Studio (`/v2/insights`) и сделать красивее.**
- **Best Quality toggle** — чекбокс `qualityBestToggle` под Controls. Виден только если `currentPlan === 'max'`. При checked → отправляется `quality=best` в FormData.

### Search и filter
- `filterHistory(history, query)` — поиск по title / text / speaker names / date / language. Активный tag filter если `activeTagFilter`
- Подсветка совпадений через `<mark>`, scroll-to-first

### Feature flags
- `FEATURE_CHAT = false` — Chat with transcript (готово, скрыто)
- `FEATURE_TAGS = false` — Auto-tags + tag-фильтр (готово, скрыто)

### Persistence
- **Supabase Postgres** — основная история (`public.transcripts`)
- **localStorage**: `transcriptor_settings` (lang + numSpeakers + **aiDetail** пресет саммари), `theme`. История больше не там.
- **IndexedDB** (`transcriptor_recordings` → `sessions`): autosave чанков. Удаляется после успешной транскрипции.

### Тема (light/dark) — View Transitions
`applyTheme` переключает через **View Transitions API** (`document.startViewTransition`)
— GPU-кроссфейд снапшота всей страницы. **НЕ навешивать `transition` на каждый
элемент** (`*`) — на большом транскрипте это лагало (браузер анимировал тысячи
узлов). Фоллбэк (Firefox / нет API / `prefers-reduced-motion`) — мгновенное
переключение. CSS: `::view-transition-old(root)/new(root) { animation-duration }`.

## Modal app — ключевые куски

### Container reuse
- **`Transcriptor` cls** (`@app.cls(gpu="A10G", scaledown_window=150)`) — держится тёплым 2.5 мин (было 300: после длинной джобы 10 контейнеров висели по 5 мин = ~50 GPU-мин idle-хвоста, ~30% стоимости 4ч джобы; 150с хватает на follow-up title). Первый запуск ~60-90с (загрузка моделей + первый прогрев большой модели). VRAM: turbo (3GB) + large-v3 (3GB) + pyannote (2GB) + wespeaker embedding (~0.1GB) + Qwen 4-bit (5GB) ≈ 13GB на 24GB A10G.
- **`flask_app` wsgi** (`@app.function(min_containers=0, scaledown_window=60)`) — scale-to-zero. Cold start ~3-5с.
- Persistent Volume `transcriptor-models` — модели кэшируются между рестартами.

### Spawn-based async
- `Transcriptor.transcribe_full.spawn(audio_bytes, language, num_speakers, prompt, progress_key, quality)` → возвращает `FunctionCall` сразу. Flask отдаёт `object_id` как `job_id` (с префиксом `t_`).
- Возвращает **dict** `{"segments": [...], "vocab_additions": [...]}` (раньше был bare list). Polling endpoint обратно совместим — детектит формат.
- На polling: `modal.FunctionCall.from_id(call_id).get(timeout=0)` — не блокирует, либо `TimeoutError` либо result. Errors всплывают как исключения.

### Native Python типы перед return
- faster-whisper и pyannote возвращают `numpy.float32` для start/end. Modal serializes via cbor2; **Flask контейнер не имеет numpy** → deserialize падает.
- Все timestamps кастуем через `float()`, speakers через `str()` перед return.

### STT correction pipeline (Gemini → Qwen fallback)
- **Primary: Gemini 2.5 Flash** (`CORRECTION_MODEL` env, override на Pro для Max). HTTP вызов напрямую из GPU контейнера (есть `requests` + `GEMINI_API_KEY` в общем секрете).
- Один вызов на **весь транскрипт** с speaker labels: `"N. [SPEAKER_XX] text"`. Контекст 2M токенов → часовой созвон в один shot.
- Gemini может:
  1. Чинить STT-ошибки используя **world knowledge** (рдух → ADHD, СТР → CTR, имена)
  2. Делать **boundary fix** — переносить 1-5 слов через границу спикеров если грамматика явно показывает что фразу прикрепило не к тому
- Safety: coverage ≥70% (иначе отвергаем целиком), length ratio ≤50%, latin/cyrillic guard (8 latin chars OK для аббревиатур), speaker reassignment только в существующего из набора.
- После Gemini boundary-fix — re-merge consecutive same-speaker сегменты (могли стать соседями).
- **Vocab extraction**: `_extract_vocab_terms` берёт изменённые слова, фильтрует на аббревиатуры (2+ CAPS) и имена собственные (Capitalized, 4+ chars). Возвращается в `vocab_additions` → Flask сохраняет в `user_profiles.vocabulary`.
- **Fallback: Qwen 7B 4-bit** — старая логика батчей по 60 строк, формат `N. text`. Используется только если Gemini fail (нет ключа, network, rate limit, parse fail). Без vocab additions.

## Non-obvious things future-Claude will trip on

### Modal / Backend
- **Supabase JWT validation через JWKS** — не shared HS256 secret. PyJWKClient кэширует ключи. Работает с legacy HS256 и новым ES256/RS256 одновременно (`algorithms=["HS256", "ES256", "RS256"]`).
- **`SUPABASE_URL` в Modal Secret обязателен** — без него JWKS клиент не инициализируется и **JWT validation пропускается** (для локального dev режима). На prod должен быть выставлен.
- **`pyjwt[crypto]` extra нужна** для ES256/RS256. Просто `pyjwt` поддерживает только HS256.
- **Modal `scaledown_window` не `container_idle_timeout`** — deprecated имя.
- **CUDA base image, не debian_slim** — `nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04` чтобы `libcublas.so.12` был доступен системно. Без этого torch/ctranslate2 падают с "library not found".
- **`add_local_python_source("merger")` / `("app")`** — Modal должен знать о локальных модулях чтобы упаковать. Без этого `from merger import merge` и `from app import app` упадут.

### Frontend
- **Supabase Storage free-tier хардкап 50MB/файл** (платформенный, не настройка бакета — `storage.buckets.file_size_limit` можно поднять, но global cap на Free плане его всё равно режет). Большие Upload-файлы (>200MB, `LARGE_FILE_THRESHOLD` в api.ts) идут через Storage path (`transcribeLarge`) — на Free плане падают с "exceeded the maximum allowed size" на чём-то вроде часового видео-созвона (500MB+). **Фикс: `lib/ink/audioExtract.ts`** — клиентское извлечение аудио через ffmpeg.wasm ДО любой загрузки, для файлов >60MB (`EXTRACT_THRESHOLD`). Стрипает видео-трек, рекомпрессит в mono 16kHz opus 64kbps (то, что всё равно нужно Whisper'у) — 930MB/60мин видео сжимается до ~30MB, обычно вообще минует Storage path. **ffmpeg.wasm core: UMD сборка, не ESM** (`@ffmpeg/core/dist/umd`, не `/dist/esm`) — ESM-воркер делает runtime `import()` blob:-URL core файла, который webpack-бандленный Worker не резолвит ("Cannot find module 'blob:...'"). UMD использует classic `importScripts()`, не перехватывается webpack. При ошибке extraction — fallback на загрузку оригинального файла (try/catch в `onFile`, page.tsx).
- **Speaker rename — editingSpk хранит индекс сегмента, не speaker label.** Если хранить label, все строки одного спикера одновременно рендерят `<input>`, каждый из них получает фокус и сразу теряет через `onBlur → onRename → setEditingSpk(null)`. Нажатие выглядит как "ничего не происходит". Хранить `number | null` (segIdx) — только одна конкретная строка становится полем.
- **`####` в Gemini-ответах** — Gemini 2.5 Pro генерирует h4 (`####`) для подзаголовков summary. `renderMd` в ResultView должен обрабатывать h4, иначе выводится raw "####". Добавить кейс `raw.startsWith("#### ")` ПЕРЕД `### `.
- **API_BASE на проде = абсолютный Modal URL, обходит Vercel.** На `skriptly.io/app` фронт грузится через Vercel-proxy → Modal, но XHR-запросы к `/api/*` идут НАПРЯМУЮ на `razornne--transcriptor-v2-flask-app.modal.run` (см. `const API_BASE` в templates/index.html). Причина: Vercel Edge Network имеет body-size ~4MB на проксированных запросах, аудио легко превышает → 502 `ROUTER_EXTERNAL_TARGET_ERROR`. Cross-origin работает потому что Flask настроен `CORS(..., origins="*")`. На `localhost` API_BASE остаётся пустым (same-origin для dev).

- **Supabase JS PostgrestClient зависает на `.then()` в нашей среде.** Auth работает, но `sb.from('transcripts').select()` никогда не резолвится. Поэтому raw fetch к `/rest/v1`. Если будут вопросы "почему не SDK" — это причина. Может починится в будущей версии Supabase JS.
- **`?error=...` в URL после неудачного Google OAuth** — Supabase JS не очищает URL, остаётся как параметр. Не критично, но user видит. Идея для cleanup: `history.replaceState({}, '', window.location.pathname)` после успешного `SIGNED_IN`.
- **OAuth consent screen в testing mode** — только добавленные test users могут логиниться через Google. Для широкой аудитории — Publish app в Google Cloud Console.
- **Supabase magic link rate limit** — 4 в час на default SMTP. Custom SMTP (Resend / SendGrid) снимает лимит.
- **PostHog reverse proxy через Vercel rewrites** — `*.posthog.com` режут все популярные adblock'и (uBlock, AdGuard, Brave, Privacy Badger) → `ERR_BLOCKED_BY_CLIENT`. Конфиг в `landing/next.config.mjs`: `/ingest/static/*` → `eu-assets.i.posthog.com/static/*`, `/ingest/*` → `eu.i.posthog.com/*`. **Важен порядок** — static rule должен быть ПЕРЕД общим `/ingest/:path*`. Также `skipTrailingSlashRedirect: true` чтобы PostHog endpoints не редиректились. На localhost rewrites не работают → фоллбэк на прямой `eu.i.posthog.com` (см. логику в `posthog.init` snippet).
- **`PYTHONUTF8=1` обязателен при `modal deploy`** на Windows. Без него `'charmap' codec can't encode character '✓'` валит CLI на UTF-8 эмодзи. Запускать: `PYTHONUTF8=1 modal deploy modal_app.py` (или `$env:PYTHONUTF8="1"; modal deploy modal_app.py` в PowerShell).

### LLM для summary / action items
- **С 2026-09-23 `summary` и `actions` идут в `openai_generate` (GPT-6 Luna)**, при любой ошибке OpenAI функция сама вызывает `gemini_generate` (Gemini 2.5 Pro) с тем же промптом. Выбрано по `tests/compare_summaries.py` на реальном 54-мин звонке (4 участника): владелец выбрал Luna как самую точную; $0.005 против ~$0.06 у Gemini Pro. Секрет `openai-secrets` (OPENAI_API_KEY). Custom-пресеты и Lab пока на Gemini. Список шаблонов этого пути: `GEMINI_TEMPLATES` в `app.py` (имя историческое).
- **Все модели саммари ошибаются в атрибуции, если ошибается диаризация**: на том же звонке пайплайн нашёл 6 спикеров вместо 4 — чинить разделение голосов, а не промпт.
- **Полный транскрипт без обрезки** для Gemini-пути. У 2.5 Pro контекст 2M токенов — часовой созвон (~50-80k символов) влезает целиком. Для Qwen-пути обрезка `[:12000]` сохранена (7B-4bit деградирует на длинном контексте).
- **Промпты в `GENERATE_TEMPLATES`** написаны под Gemini Pro: длинные структурированные с адаптивным набором секций, жёсткими анти-галлюцинационными правилами, инструкциями по глубине пропорциональной длине транскрипта. **Не сокращай промпты «для краткости»** — это сильно ухудшает результат.
- **`GEMINI_MODEL` в `modal_app.py`** — одна строка для смены модели. Pro даёт лучшее качество, Flash в ~4x дешевле. Free tier Google Gemini API не пускает Pro (`limit: 0`) — нужен billing в Google Cloud Console.
- **`GEMINI_API_KEY` в Modal Secret `transcriptor-secrets`.** Ключ от AI Studio (aistudio.google.com).
- **Цены на 2026-05 (с billing):** Pro $1.25 / $10 за MTok (input/output) → ~$0.06 за summary часового созвона. Flash $0.30 / $2.50 → ~$0.015.
- **Ошибки Gemini проходят через Modal FunctionCall как `RuntimeError`** — фронт получает их в `error` поле job status'а как обычно. Safety filter блокировки → "gemini: no candidates (feedback=...)". Rate limit → "gemini 429: ...".

### LLM language hints
- **При autodetect фронт прислал пустую строку — бэк сам детектит язык.** `_detect_transcript_language()` в app.py считает кириллицу vs латиницу + украинские специфичные буквы (`іїєґ`), польские (`ąęłż…`) и чешские (`ěščřžů…`) диакритики → возвращает `uk`/`ru`/`pl`/`cs`/`en`. Используется в `/api/title`, `/api/chat`, `/api/generate`. Без этого Qwen2.5 регулярно сваливался в английский, даже когда транскрипт был украинский. Тэги (`/api/tags`) ВСЕГДА на английском намеренно — для надёжной фильтрации across languages.
- **Языки: `ru`/`uk`/`en`/`pl`/`cs`.** Новый язык = `ALLOWED_LANGUAGES` + `LANG_HINTS` + title-hint (app.py), `_LANG_PROMPTS` + `_CORRECTION_INSTRUCTIONS` + `_GAP_TEXTS` (modal_app.py), `SUPPORTED_LANGUAGES` (landing/lib/ink/config.ts), тест в `tests/test_language_detect.py`.
- **`FORCE_BEST_QUALITY_LANGUAGES` (app.py, сейчас `{"cs"}`) — large-v3 независимо от плана.** На чешском turbo (урезанный декодер) на тестовом диалоге выкинул целую реплику и задвоил другую (WER 35%, deletion 18%), large-v3 — ~3% реальных ошибок. Кандидаты в этот сет — любые языки кроме ru/uk/en.

### Whisper / Diarization
- **ffmpeg audio preprocessing** перед Whisper: `highpass=f=80, lowpass=f=12000, anlmdn (шумоподавление), loudnorm, acompressor`. Порог lowpass — **12kHz**, не 8kHz: 8kHz срезает согласные, нужные для распознавания английских терминов ("pitch deck" → "page-теку", "IRR" → "АРР" — регрессия обнаружена при реальном использовании). Применяется в `transcribe_full` и при нарезке чанков в `transcribe_long` (каждый чанк уже обработан).
- **Word-level alignment в merger** — режет Whisper-сегменты в местах смены спикера. Требует `word_timestamps=True` в whisper.transcribe.
- **Гибридный split в merger** (2026-05): короткий Whisper-сегмент (≤2s) → majority-vote (70% threshold). Длинный → word-level split. Решает проблему когда pyannote дробит одну реплику на ABAB ping-pong.
- **SPEAKER_UNKNOWN forward-fill** — pyannote иногда не атрибутирует первое слово сегмента. Merger делает forward/backward-fill.
- **Smoothing включён по умолчанию (1.0с)** + до 3 проходов. Раньше был выключен (`SMOOTH_THRESHOLD_S=0`) — но без него быстрые диалоги дробились на ABA-паттерны. Переменные: `SMOOTH_THRESHOLD_S`, `SHORT_SEGMENT_THRESHOLD_S`, `SMOOTH_PASSES`.
- **Pyannote bounds**: когда `num_speakers` не задан, передаём `min_speakers=1, max_speakers=6`. Это уменьшает фантомных спикеров (один разделён на двух) и слияние двух в одного. Если юзер ввёл точное число — приоритет ему (`num_speakers=N` constraint, без bounds).
- **`whisper_best` опционально**: грузится только если `LOAD_BEST_QUALITY=true` (default) и `WHISPER_BEST_MODEL != WHISPER_MODEL`. Если VRAM проблема — выключить `LOAD_BEST_QUALITY=false`, `transcribe_full` тогда фоллбэкает на fast для всех.

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

## Privacy Mode (Max + Team plans)

> **Убран из тарифов 2026-09-25** (решение владельца, «если что — восстановим»): `PRIVACY_MODE_ALLOWED_PLANS = set()`, тоггл удалён из SettingsModal. Вернуть: `{"team"}` + тоггл. Описание ниже — как было.

Toggle в Settings → Subscription tab. Видим только Max и Team plan'ам. Когда включён, **никакая часть пайплайна не идёт в Google/OpenAI**:

| Stage | Default | Privacy Mode ON |
|-------|---------|-----------------|
| Whisper (transcription) | Modal A10G | Modal A10G (unchanged) |
| Pyannote (diarization) | Modal A10G | Modal A10G (unchanged) |
| STT correction | Gemini 2.5 Flash REST | Qwen 7B on same A10G |
| Summary / Action items | Gemini 2.5 Pro REST | gpt-oss-20b on L40S (map-reduce на длинных, см. ниже) |

**Backend gating** (`app.py`):
- `PRIVACY_MODE_ALLOWED_PLANS = {"max", "team"}`
- `_privacy_mode_active(profile, effective_plan)` — true только если флаг ON И plan eligible (defence-in-depth: даже если юзер на Pro как-то выставил флаг — backend игнорит)
- `/api/profile/privacy-mode POST` отвергает с 402 если plan ниже Max
- `/api/transcribe` читает privacy_mode из профиля → пассует в `Transcriptor.transcribe_full.spawn(..., privacy_mode=True)` → `_correct_segments(privacy_mode=True)` идёт сразу в Qwen-ветку, минуя Gemini
- `/api/generate` для summary/actions: если privacy_mode → spawn'ит `LabGPTOSS20B.generate_mapreduce` вместо `gemini_generate`. **Map-reduce (ISS-1):** gpt-oss-20b поддерживает только eager attention (O(n²) память) → на 3-4ч транскрипте одним промптом ловил CUDA OOM. Теперь транскрипт режется на окна ~12k символов (`_split_text_windows`), каждое сжимается в плотные заметки (map, `PRIVACY_MAP_PROMPT` из app.py), финал генерируется по заметкам исходным шаблоном (reduce). Текст подставляется в промпты через сентинел `<<TRANSCRIPT_TEXT>>` (`PRIVACY_TEXT_SLOT`/`MAPREDUCE_TEXT_SLOT` — литералы должны совпадать, есть тест). Короткие транскрипты — одним вызовом как раньше. Worst case 4ч ≈ 15-20 мин (внутри 22-мин poll-таймаута фронта).

**Frontend UI:**
- Settings → Subscription → "Privacy Mode" чекбокс, optimistic UI с rollback при ошибке save
- PostHog ивент `privacy_mode_toggled {enabled}` — измеряем кто включает

**Trade-off:** gpt-oss-20b даёт качество ~75-80% от Gemini Pro (заметно беднее на длинных summary, лучше на reasoning). Стоимость инференса близка: ~$0.05/call на L40S vs ~$0.05 у Gemini Pro. Главный win — privacy, не цена.

## Lab harness (`app.py` → `/api/lab/*`)

Admin-only инструмент для side-by-side сравнения LLM на реальных транскриптах юзера. Использовался чтобы выбрать gpt-oss-20b для Privacy Mode.

**Доступ:** `ADMIN_EMAILS` env var (в `admin-secrets` Modal Secret) — comma-separated email allowlist. `is_admin` возвращается в `/api/profile`, фронт показывает "⚗ Compare models" кнопку под транскриптом только для админов.

**Endpoints:**
- `GET /api/lab/info` — список доступных моделей + GENERATE_TEMPLATES keys
- `POST /api/lab/compare {transcript_id, task, models}` — спавнит каждую модель параллельно, возвращает `job_ids`, фронт поллит через тот же `/api/jobs/<id>` (re-use `g_` префикса). Async — не блокирует HTTP gateway

**Зарегистрированные модели** (`LAB_MODELS` в `app.py`):
- `gemini` → `gemini_generate` (Gemini 2.5 Pro baseline)
- ~~`mamaylm` → `LabMamayLM9B.generate`~~ — **удалён из деплоя 2026-06-10** (сравнение завершено, gpt-oss выбран). Вернуть — git history.
- `gptoss20b` → `LabGPTOSS20B.generate` — gpt-oss-20b MXFP4 на L40S. Eager attention, `reasoning_effort="low"`, post-process `_strip_gpt_oss_analysis` убирает "analysis" channel из output'a. **Текущий Privacy Mode backend.**

**UI Lab modal:** task dropdown + model checkboxes + run → side-by-side колонки + Download .md экспорт результатов.

## Long recordings — chunked pipeline (3-4ч созвоны)

Монолитный `transcribe_full` не тянет длинные записи (таймаут + один Gemini-вызов
на весь транскрипт). Записи **> `LONG_AUDIO_THRESHOLD_S` (1800с = 30 мин)**
роутятся в `transcribe_long`.

**Поток:** Flask `/api/transcribe` по `duration_sec` → `transcribe_long.spawn()`
(CPU оркестратор) → ffmpeg decode → **silence-aware split** (`_parse_silences` +
`_plan_chunk_boundaries`; число чанков подгоняется под ≤`MAX_PARALLEL_CHUNKS`
(10) чтобы все шли ОДНОЙ волной GPU, длина чанка ≤`MAX_CHUNK_LEN_S` 1800с;
4ч = 10×~24-мин чанков; каждый чанк вырезается с **нахлёстом `CHUNK_PAD_S`
(3с)** с обеих сторон — Whisper слышит контекст через шов, hard-cut не рвёт
слово; дедуп пад-зон по midpoint в `_trim_to_core` внутри transcribe_chunk,
оффсет стича = `pad_starts[i]`) → параллельный `Transcriptor.transcribe_chunk.spawn()`
на нескольких A10G → **глобальная кластеризация спикеров** → стич (offset
таймстемпов + релейбл local→global + re-merge) → `{segments, vocab_additions}`.
Прогресс "chunk k/N" в modal.Dict.

**Per-chunk resilience (ISS-2):** каждый `call.get()` в try/except — упавший
после Modal-ретраев чанк логируется и пропускается, в транскрипт вставляется
локализованный gap-маркер (`SPEAKER_UNKNOWN`, "[~N мин аудио не удалось
обработать]"), прогресс отдаёт `chunks_failed`. Падают ВСЕ чанки → RuntimeError.

**Сшивание спикеров (ключевое и хрупкое):**
- Каждый `transcribe_chunk` возвращает до `EMB_PER_SPEAKER` (6) **L2-нормированных
  embedding'ов на локального спикера** (`_speaker_centroids`, wespeaker-модель) —
  несколько точек на голос устойчивее одного центроида к шумным сегментам.
- Оркестратор: **собственная агломеративка** `_cluster_speaker_embeddings`
  (average linkage по всем парам векторов, numpy, sklearn выкинут) с
  **cannot-link констрейнтом**: два локальных спикера ОДНОГО чанка — заведомо
  разные люди (pyannote разделил их в общем контексте) и не сливаются никогда.
  Это структурно блокирует склейку похожих голосов на звонках 1-на-1.
- **Phantom-escape (критично для auto-режима):** cannot-link НЕ абсолютен —
  если два локальных спикера одного чанка ближе `GLOBAL_SPK_PHANTOM_DIST`
  (**0.40**), это не два человека, а pyannote over-сегментировал один голос;
  такие сливаются даже внутри чанка. Без этого в auto-режиме (юзер не задал
  Speakers, force-merge фаза не работает) каждая внутричанковая
  over-сегментация навсегда оставалась лишним глобальным спикером — реальный
  2-спикерный звонок 1.5ч выдавал 5 «спикеров» (регресс MYK-12, чинён 2026-06-15).
- Дистанции между спикерами считаются по **центроиду** набора эмбеддингов
  (среднее → норм.), а не по average-linkage всех пар — усреднение гасит
  шум сегментов, иначе «тот же человек на разных чанках» раздувался выше
  порога → дубли на швах.
- Если `num_speakers` задан юзером → сливаем до k; когда cannot-link не даёт
  дойти (фантомный локальный спикер) — наименьшие кластеры вливаются в
  ближайший принудительно (лог "force-merging phantom").
- **Порог:** `GLOBAL_SPK_THRESHOLD` (**0.68**). История: 0.7 склеивал похожие
  голоса → 0.55 разделял, но плодил ДУБЛИ одного человека на швах чанков →
  с cannot-link порог снова поднят, швы сшиваются. Логи дают `[long]
  global_speakers=N centroid_cos_dist min=X` — если `min < 0.3`, голоса почти
  неразличимы для embedding-модели (overlap/похожие/телефон) — задать Speakers.
- **Диагностика в логах:** `[long] speakers-with-embeddings=N
  per-chunk-speakers=[...]`, `global_speakers`, `centroid_cos_dist min/mean/max`.
- Юнит-тесты: `tests/test_speaker_clustering.py`.

**Gotchas:**
- **wespeaker embedding model** грузится в `load_models` с `cache_dir` на Volume
  (иначе перекачка на каждом из 12 параллельных cold start'ов). Тот же
  embedding что пайплайн тянет внутри — без нового HF-гейтинга.
- **Modal body limit ~250МБ** — прямой аплоад длинного файла может упереться;
  тогда нужен resumable upload (Phase 4 long-recording в ROADMAP, условный).
- Per-chunk Gemini correction (каждый чанк ~20мин → один вызов, параллельно).
- **Протестировано:** польский подкаст (3 чанка) — спикеры сшились верно.
  Cannot-link кластеризация + порог 0.68 + multi-embeddings (2026-06-10) —
  юнит-тесты зелёные, ждёт деплоя и верификации на реальном звонке 1-на-1.
- Тест дёшево: временно `CHUNK_LEN_S=120` + `LONG_AUDIO_THRESHOLD_S=90` → короткий
  файл режется на чанки. Откатить после.

## Personal Vocabulary (auto-learned terminology)

**Цель:** научить Whisper твоей специфической лексике без участия юзера. Не Wispr Flow-стиль "юзер правит → словарь" — наш подход умнее: **Gemini правит → словарь**.

### Pipeline (wrong→right correction memory)

1. Юзер записывает созвон, Gemini correction исправляет "пожика" → "по ЖК"
2. `_extract_vocab_pairs` (в `modal_app.py`) через `difflib` выравнивает orig↔corrected по словам, из `replace`-блоков выцепляет **пару** `{wrong, right}` — где правая часть содержит аббревиатуру (2+ CAPS, в т.ч. 2-буквенную ЖК/AI), имя собственное (Capitalized 4+) или содержательное слово 5+ букв (ловит строчные доменные термины: дебіторська, алерти). Короткие грамм-фиксы (≤4 букв) и длинные перефразирования (>3 слов) игнорируются.
3. Возвращается в `vocab_additions` — **list of dicts** `{wrong, right}` (раньше был list of strings)
4. Flask polling → `_save_vocabulary_additions(user_id, additions, language)` → upsert в `user_profiles.vocabulary` (JSONB array of `{term, wrong?, freq, lang, last_seen}`, term=right). Терпит и старый str-формат для in-flight джоб.
5. На следующем `/api/transcribe` Flask тянет vocab и строит ДВЕ вещи:
   - `_build_vocab_prompt` — топ-30 правых форм → Whisper `initial_prompt` (как раньше; распознаёт термин с первой попытки)
   - `_build_correction_hints` — топ-20 пар `wrong → right` (только элементы с полем `wrong`) → передаётся в Modal как `correction_hints`
6. `correction_hints` пробрасывается через `transcribe_full`/`transcribe_long`/`transcribe_chunk` → `_correct_segments_gemini`, где вставляется в Gemini-промпт блоком "known corrections for THIS user" → Gemini контекстно (не слепо) применяет известные исправления

### Лимиты

- **VOCAB_MAX_ITEMS=100** — топ-100 терминов на юзера. Старые редкие выбывают (sort by freq desc).
- **VOCAB_PROMPT_TOP=30** — сколько правых форм в Whisper initial_prompt.
- **VOCAB_HINTS_TOP=20** — сколько пар wrong→right в Gemini correction hints.
- Casing обновляется если новый вариант "выглядит правильнее" (CAPS или первая заглавная). `wrong` обновляется на свежую ошибочную форму.

### Что НЕ попадает в словарь

- Короткие грамматические фиксы (правая форма ≤4 букв и не аббревиатура) — отсеиваются в `_extract_vocab_pairs`
- Длинные перефразирования / boundary-fix (>3 слов в блоке) — не term-уровень
- Изменения регистра — игнорируются (`right.lower() == wrong.lower()`)
- Слова из оригинала которые не изменились — только `replace`-блоки difflib

### Подход (НЕ Wispr Flow)

Не "юзер правит → словарь" — наш умнее: **Gemini правит → словарь пар wrong→right**, который дальше работает на ДВУХ уровнях: Whisper (распознать сразу) + Gemini hint (починить увереннее). Детерминированную find/replace замену НЕ делаем (риск ложных правок).

### Ручное управление словарём (реализовано)
Доступно в **двух местах**:

1. **Settings → Vocabulary tab** (основное место, 2026-06-29): редактируемые чипы, hover → ✎ rename inline / × delete, поле "+ Add a term" (freq=10 → в топ Whisper prompt). Изменения оптимистичны + персист через `POST /api/vocabulary` (service role).

2. **Insights дашборд** (`#dashboardModal`): блок "TOP RECOGNIZED TERMS" — то же самое. Свёрнуто до 18 чипов, кнопка "Show all (N)".

`currentVocabulary` приходит из `/api/profile`. Это закрыло «ручное поле мои термины» из роадмапа.

### Gotchas

- **Coverage 70%** — если Gemini вернул мусор (структура сломана), `_correct_segments_gemini` возвращает `None` → fallback на Qwen → vocab additions пустой. Это нормально.
- **Vocab сохраняется по `user_id` из job tracking** (`_job_user[job_id]`), не из текущего request — потому что polling может прийти из другого session/контекста.
- **Без миграции 002** (`vocabulary` column) сохранение молча падает с warning в логах — транскрипция не ломается.

---

## PostHog Analytics

**Setup:** EU instance, reverse proxy через `skriptly.io/ingest/*` для обхода adblock'ов.

### Project key
- Hardcoded в `templates/index.html`: `phc_yXYdbAQoySKp6BaHbpkZ3kawiByFRjERMYo5VBNMyvFE`
- Это public client-side key — безопасно держать в HTML

### Reverse proxy (важно!)
Без этого ~30-40% юзеров не отправляют ивенты (uBlock / AdGuard / Brave / Privacy Badger режут `*.posthog.com`).

Конфиг в `landing/next.config.mjs`:
```js
{ source: "/ingest/static/:path*", destination: "https://eu-assets.i.posthog.com/static/:path*" },
{ source: "/ingest/:path*",        destination: "https://eu.i.posthog.com/:path*" },
```

В `posthog.init` → `api_host: location.origin + '/ingest'` на проде, `https://eu.i.posthog.com` на localhost (rewrites не работают в Next dev).

`ui_host: 'https://eu.posthog.com'` — для toolbar и правильных ссылок в UI.

### User identification
В `onAuthStateChange` после login делаем:
```js
posthog.identify(session.user.id, {
  email, plan, minutes_used, minutes_limit,
  has_workspace, workspace_role, ui_lang,
});
posthog.setPersonProperties(props);
```
На sign-out → `posthog.reset()` чтобы не наследовать identity.

### Tracked events (custom)
| Event | Когда | Properties |
|---|---|---|
| `sign_in` | После Supabase SIGNED_IN | `method` (google/email) |
| `transcription_started` | Spawn job | `language`, `duration_sec` |
| `transcription_completed` | Job done | `segments`, `language` |
| `transcription_failed` | Job error | `error`, `duration_sec`, `has_recovery` |
| `summary_generated` / `actions_generated` | AI panel done | `template` |
| `export_clicked` | Download .md button | `format`, `segments` |
| `speaker_renamed` | Rename inline | `raw_label`, `name_length` |
| `recording_recovered` | IDB recovery accepted | `size_mb`, `chunks` |
| `recording_recovery_dismissed` | IDB recovery rejected | `size_mb` |
| `upgrade_prompt_shown` | Free hit limit / AI gate | `reason` (minutes_limit / ai_tools), `template` |
| `payment_started` | Stripe checkout начат | `plan`, `billing` |
| `workspace_invite_sent` | Owner пригласил | `status` (invited/active) |
| `workspace_invite_accepted` | Member принял | `workspace_name` |
| `best_quality_toggled` | Max включает large-v3 | `enabled` (bool) |
| `privacy_mode_toggled` | Max/Team toggle Privacy Mode | `enabled` (bool) |
| `settings_tab_viewed` | Открыли таб в Settings | `tab`, `plan` |
| `plan_card_clicked` | Клик по plan-card в Settings | `target_plan`, `current_plan`, `billing` |
| `content_tab_clicked` | Switch Transcript/Summary/Actions | `tab` |
| `team_upgrade_started` | Owner начал Stripe Checkout для Team | `billing` |
| `referral_link_copied` | Copy кнопка на реф-ссылке | — |
| `referral_redeemed` | Юзер пришёл по чужому коду | `bonus` |
| `demo_transcript_loaded` | Демо показалось новому юзеру | — |
| `demo_dismissed` | Закрыли демо | `action` (try_own / close / start_recording) |
| `welcome_modal_shown` / `welcome_modal_dismissed` | Onboarding modal | `action` |
| `notion_connect_started` / `notion_sent` / `notion_disconnected` | Notion integration | — |
| `transcription_cancelled` | Cancel button во время processing | `duration_sec` |
| `lab_compare_ran` | Admin Lab сравнение | `task`, `models`, `wall_ms` |
| `dashboard_opened` | Открыли Insights дашборд | — |
| `file_uploaded` | Загрузили аудио/видео файл для транскрипции | `type`, `size_mb`, `duration_sec` |

### Autocapture + Error tracking (включён)
- `autocapture: true` — pageviews + все клики/inputs автоматом. Дополняет наши named events базовой engagement-картой без instrumentation каждой кнопки.
- `capture_exceptions: true` — uncaught JS errors + unhandled promise rejections автоматом в PostHog → Error tracking. Заменяет нужду в Sentry для нашего объёма.

### Session Replay (включён, БЕЗ маскировки)
`posthog.init` в `landing/app/app/page.tsx`: `session_recording: { maskAllInputs: false, maskTextSelector: null }` — в replay виден весь текст, включая транскрипты. **Решение владельца от 2026-09-23** (работа над ошибками; все пользователи — его знакомые, никто не платит). Пароли маскируются дефолтом rrweb. Маскировку всего текста ещё можно включить на уровне проекта в PostHog UI (Settings → Session replay) — там должна быть выключена.

**Раскрыто в Privacy Policy 2026-09-26** (решение владельца: оставить и честно описать; возражение против реплеев — письмом, исключаем вручную). Не возвращать маскировку молча — сначала спросить владельца.

### Настроенные dashboards / insights (в PostHog UI)
- **Activation funnel**: `sign_in → transcription_started → transcription_completed → summary_generated|export_clicked` (24h window)
- **Conversion funnel**: `sign_in → transcription_completed → upgrade_prompt_shown → payment_started` (30d)
- **Retention** на `transcription_completed`, weekly — показывает W1/W2/... retention
- **Dashboard "Skriptly Operations"**: new users/day, transcriptions/day, failures/day (красный), upgrade prompts breakdown, best_quality usage breakdown

### Что НЕ настроено (TODO)
- **Server-side events** из Stripe webhook (`subscription_activated`, `subscription_cancelled`) — для PostHog funnel. Сейчас они идут только в Telegram админу.
- **Cohorts**: Active free, Pro near limit, Workspace owners — создать вручную в PostHog UI

### Admin Telegram notifications (отдельный канал)

Дополнительно к PostHog для **операционных** алертов — Telegram bot пингует админу:
- 🎉 **New signup** — email + user_id + referral code
- 💰 **New subscription** (Pro/Max/Team) — сумма, валюта, billing период, email, **промокод** если был применён
- ⚠️ **Subscription cancelled** — user/workspace id

Реализовано в `_notify_admin(text)` в `app.py`. Best-effort: если Telegram упал, операция не прерывается. Креды в `admin-secrets` Modal Secret.

---

## Ink & Halftone Studio (`/app`) — production app

**Production с 2026-06-14** (после Sprint 7 Cutover). Все файлы в `landing/`.

### Файловая структура

```
landing/
├── app/app/
│   ├── layout.tsx     ← root layout: HTML lang, theme bootstrap
│   ├── page.tsx       ← главный экран: монтирует все ink-компоненты,
│   │                    управляет глобальным состоянием (auth, job, history)
│   ├── ink.css        ← все стили под .i-* namespace (НЕ пересекается с landing)
│   └── v2.css         ← legacy-compat файл (не используется, можно удалить)
├── components/ink/
│   ├── DotField.tsx   ← canvas-фон: анимированное поле из халфтон-точек
│   │                    + mouse-spring физика + cloud sinusoid дыхание
│   ├── InkSidebar.tsx ← левый сайдбар: история записей (Supabase), search
│   ├── InputCard.tsx  ← карточка управления: запись / upload / processing
│   ├── LoginScreen.tsx← экран логина (Supabase Auth overlay)
│   ├── ResultView.tsx ← транскрипт + табы (Transcript / Summary / Actions / Custom)
│   ├── SettingsModal.tsx ← модалка настроек (7 табов — см. ниже)
│   └── UpgradeCard.tsx← апгрейд-промпт при достижении лимита / AI-гейте
└── lib/ink/
    ├── api.ts         ← клиент к Flask-бэку на Modal (authFetch + все эндпоинты)
    ├── audio.ts       ← запись: СТЕРЕО (L=микрофон, R=звук вкладки) через ChannelMerger,
    │                    микрофон следует за активным устройством (devicechange/ended),
    │                    предупреждения о пропаже/тишине звука вкладки, CaptureStats
    │                    (→ capture_stats). Шумодав/автогромкость — дефолты браузера
    ├── config.ts      ← API_BASE (Modal URL или '' для localhost)
    ├── db.ts          ← Supabase CRUD (raw REST через _sbFetch, не PostgrestClient)
    ├── idb.ts         ← IndexedDB autosave чанков (audio safety net)
    ├── keepalive.ts   ← tab keep-alive: silent audio + Wake Lock + OS Notifications
    ├── settings.ts    ← localStorage-шорткаты (lang, numSpeakers, aiDetail)
    └── supabase.ts    ← createClient() + export sb
```

### SettingsModal — табы и поведение

| Таб | Содержимое |
|-----|------------|
| Account | email, план, использование минут (прогресс-бар) |
| Subscription | карточки планов Free/Pro/Max + Privacy Mode toggle. Upgrade → `createStripeCheckout()`. Downgrade/manage → `createStripePortal()` (Customer Portal). |
| Vocabulary | **Редактируемые чипы терминов** из `currentVocabulary`. Hover → ✎ rename inline / × delete; поле "+ Add a term" (freq=10). Сохраняется через `POST /api/vocabulary`. Данные приходят из `/api/profile`. |
| Workspace | создать / посмотреть команду, инвайты, покинуть. Create кнопка активна при любом непустом имени; без Team-плана → upsell-баннер + подсветка Team-карточки. |
| Integrations | Notion OAuth (connect / disconnect / change default page) |
| Invite friends | реф-ссылка, бонусные минуты (+60 обоим) |
| Preferences | язык интерфейса, число спикеров по умолчанию, тема |
| Danger zone | удаление данных истории + удаление аккаунта (GDPR) |

**Размер модалки:** `.i-modal.i-modal-wide` → `width: 880px; max-width: 95vw; height: 580px`. Левый нав `width: 180px`. Контент `padding: 32px`. Мобайл ≤640px — колапсируется в одну колонку.

### Billing flow (важно — два разных пути)

- **Upgrade** (Free→Pro, Free/Pro→Max): `createStripeCheckout(plan, billing)` → Stripe Checkout Session → `window.location.href`
- **Downgrade / manage** (Max→Pro, любой→Free, отмена): `createStripePortal()` → Stripe Customer Portal → `window.location.href`
- Состояния: `checkoutPlan: string | null` (блокирует кнопки апгрейда пока redirect), `loadingPortal: boolean` (блокирует Portal-кнопки)
- **НЕ смешивать** — Checkout создаёт новую подписку, Portal управляет существующей. Downgrade через Checkout не работает.

### DotField — физика (Sprint 8)

| Константа | Значение | Описание |
|-----------|----------|----------|
| `MOUSE_R` | 185 | Радиус влияния курсора (было 150, +23%) |
| `MOUSE_DISP` | 6 | Максимальное смещение точки (было 4) |
| `MOUSE_SPRING` | 0.12 | Жёсткость пружины для позиции курсора |
| `MOUSE_DAMP` | 0.78 | Затухание пружины (даёт упругий overshoot) |

Физика курсора: velocity-based spring вместо простого lerp:
```ts
mouse.vx = (mouse.vx + (mouse.tx - mouse.x) * MOUSE_SPRING) * MOUSE_DAMP;
mouse.vy = (mouse.vy + (mouse.ty - mouse.y) * MOUSE_SPRING) * MOUSE_DAMP;
mouse.x += mouse.vx; mouse.y += mouse.vy;
```
На первом входе курсора (act < 0.01) — телепорт без пружины (vx/vy = 0), чтобы не было snap с края экрана.

Cloud sinusoid t-multipliers увеличены ~35% — точки «дышат» заметно даже без движения мыши.

### CSS ключевые классы (ink.css)

| Класс | Описание |
|-------|----------|
| `.i-modal.i-modal-wide` | Основная модалка настроек 880×580px |
| `.i-plan-cta` | CTA-кнопка планов (primary, accent fill) |
| `.i-plan-cta.i-plan-cta-down` | Ghost-вариант для Downgrade (рамка, нет fill) |
| `.i-plan-card.team-upsell-glow` | Пульсирующий glow на карточке при team-upsell |
| `.i-team-upsell-banner` | Баннер «Workspace requires Team plan» со slide-in |
| `.i-danger-del-btn` | Кнопка «Видалити акаунт» в Danger zone |
| `.i-danger-del-btn.confirming` | Состояние подтверждения (красный, scale-pulse) |
| `.i-cook.i-cook-ghost` | Ghost-кнопка (обводка, нет fill) — «Both ↓» в AI-панели |
| `.i-pmodal-chips` | Flex-wrap ряд чипов-примеров в модалке создания пресета |
| `.i-spk-hint` | Иконка ✎ подсказки hover на имени спикера |
| `.i-md h4` | `font-size: 12px; font-weight: 600` — Gemini генерирует `####` подзаголовки |

Все новые анимации имеют `@media (prefers-reduced-motion)` overrides.

### Delete Account (GDPR)

`Danger zone → Видалити акаунт`:
1. Первый клик → `deleteConfirm = true` + 3с auto-reset таймер, кнопка становится красной «Підтвердити видалення?»
2. Второй клик → `apiDeleteAccount()` (DELETE /api/profile) → `sb.auth.signOut()` → `window.location.href = "/"`
3. Если любой шаг упал — кнопка возвращается в нейтральное состояние

`deleteAccount()` в `lib/ink/api.ts`: `authFetch(${API_BASE}/api/profile, { method: "DELETE" })`.

### Sprint 8 changelog (2026-06-14)

- **Fix 1 — Downgrade buttons**: Разделены Checkout (upgrade) и Portal (downgrade). `openPortal()` отдельная функция с `loadingPortal` state.
- **Fix 2 — Workspace Create**: Кнопка активна при непустом имени. Без Team → upsell-баннер + Team-карточка с glow.
- **Fix 3 — Modal sizing**: 880×580px desktop, responsive mobile collapse.
- **Fix 4 — Delete account**: Самостоятельное удаление аккаунта (GDPR) с двойным подтверждением.
- **Fix 5 — DotField physics**: Spring/velocity для курсора, MOUSE_R 150→185, MOUSE_DISP 4→6, cloud +35% скорость.

### Sprint 9 changelog (2026-06-29)

- **Audio preprocessing**: ffmpeg filter chain перед Whisper — `highpass=f=80, lowpass=f=12000, anlmdn, loudnorm, acompressor`. Lowpass 12kHz (было 8kHz — регрессия на английских согласных: "pitch deck" → "page-теку", "IRR" → "АРР"). Работает в `transcribe_full` и `transcribe_long` (передаётся в каждый чанк через WAV).
- **num_speakers fix в чанках**: `transcribe_long` теперь пробрасывает `num_speakers` юзера в каждый `transcribe_chunk.spawn()`. Раньше спикер-каунт игнорировался для длинных записей.
- **Speaker rename fix**: `editingSpk` теперь хранит индекс сегмента (`number | null`) вместо speaker label. Старая логика (по label) давала race: все строки одного спикера одновременно рендерили `<input>`, каждый терял фокус через blur → onRename → reset, нажатие ни к чему не приводило.
- **Speaker rename ✎ hint**: `.i-spk-hint` иконка появляется при hover на имени спикера.
- **Em dash removed**: `stripDash()` в ResultView убирает ведущее `—` из реплик транскрипта.
- **Notes tab removed**: вкладка Notes (локальные заметки) удалена из ResultView. Tab type: `"transcript" | "summary" | "actions" | "custom"`. Keyboard shortcut `4` → notes удалён из page.tsx.
- **"Both ↓" button**: кнопка-гоуст рядом с Generate в AI-панели. `runBoth()` генерирует Summary, дожидается, затем Actions. Второй patch передаёт обе части явно (stale closure guard: `{ ...entry.aiResults, summary: summaryText, actions: actionsText }`).
- **Casual preset UX**: модалка создания пресета — label "What should the AI do with this call?", чипы-примеры (Summarize for my manager / Find all objections / Extract decisions / Write follow-up email), `<<TRANSCRIPT_TEXT>>` добавляется автоматически если нет.
- **Preset security**: frontend strip control chars + auto-append placeholder в `submit()`; backend `_sanitize_preset_prompt()` в `app.py` (strip \x00-\x1F + auto-append + обрезка до PRESET_PROMPT_MAX). Python format-injection невозможен — `CUSTOM_PRESET_HARD_RULES` использует `.replace()` не `.format()`.
- **h4 markdown**: `renderMd` в ResultView теперь обрабатывает `####` (Gemini генерирует подзаголовки h4). CSS: `.i-md h4 { font-size:12px; font-weight:600 }`.
- **Vocabulary section in Settings**: вкладка Vocabulary добавлена в SettingsModal (редактируемые чипы терминов, + Add, × delete). Раньше был только в Insights дашборде.


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
# Backend (Modal). PYTHONUTF8=1 обязателен на Windows.
$env:PYTHONUTF8 = "1"
modal deploy modal_app.py

# Frontend landing — автоматом из GitHub push в main
git push origin main  # Vercel сразу собирает и катит на skriptly.io
```

**После добавления новой миграции:** выполнить SQL вручную в Supabase SQL Editor (project `bmonakhktbaliwgobrxv`). Текущие миграции:
- `migrations/001_workspace.sql` — workspaces + workspace_members + transcripts.visibility
- `migrations/002_vocabulary.sql` — user_profiles.vocabulary JSONB
- `migrations/003_referrals.sql` — referral_code + referred_by + bonus_minutes
- `migrations/004_team_billing.sql` — workspaces.plan/stripe/seats/billing
- `migrations/005_notion.sql` — user_profiles Notion OAuth credentials
- `migrations/006_signup_notified.sql` — signup_notified_at TIMESTAMPTZ
- `migrations/007_privacy_mode.sql` — user_profiles.privacy_mode BOOLEAN
- `migrations/008_vocabulary_pairs.sql` — vocabulary item format: adds `wrong` field
- `migrations/009_custom_presets.sql` — user_profiles.presets + workspaces.presets JSONB
- `migrations/010_speaker_names.sql` — transcripts.speaker_names JSONB
- `migrations/011_capture_stats.sql` — capture_stats (телеметрия захвата)
- `migrations/012_recordings.sql` — recordings (индекс архива аудио в R2)
- `migrations/013_recordings_corrections.sql` — recordings.corrections + channel_mode
- `migrations/014_user_emails.sql` — email-колонки рядом с user_id (триггеры из auth.users)
- `migrations/015_dictation_usage.sql` — учёт секунд диктовки (Windows-приложение) в общем лимите
- `migrations/016_plans_v2.sql` — тарифы v2: своя квота диктовки, пул минут Team, Max → Pro

Миграции **не идемпотентны через какой-то фреймворк** — каждая написана с `IF NOT EXISTS` чтобы безопасно перезапустить, но фиксить руками тоже окей.

См. `ROADMAP.md` для дальнейших шагов.

## Constraints

- Modal A10G GPU — pay-per-use, idle = 0. Один пользователь за раз с быстрой обработкой; параллельные транскрипции спавнят новые контейнеры (Modal auto-scales).
- **VRAM 24GB на A10G** держит две модели Whisper + pyannote + wespeaker embedding + Qwen 4-bit одновременно (~13GB used). Если добавим что-то ещё (например Qwen без quantization) — пересмотреть.
- **Длинные записи** спавнят несколько A10G параллельно (transcribe_chunk на чанк). Стоимость ≈ та же суммарная GPU-минута что serial, но wall-clock сжат. Платим только за реальное время.
- Supabase free tier: 500MB DB, 50K MAU, 4 magic link emails/hour.
- **Gemini API**: Pro/Flash в Modal Secret `GEMINI_API_KEY`. Коррекция Flash ≈ $0.05/час записи (замер 2026-09-24: ~21k токенов/ч). Саммари — GPT-6 Luna ≈ $0.005.
- **Soniox**: batch $0.10/ч за дорожку (стерео = 2 дорожки), real-time $0.12/ч за поток (диктовка; живой транскрипт выключен). Лимит 300 мин/файл, 1000 файлов / 2000 транскрипций на аккаунт (удаляем сразу).
- **PostHog free tier**: 1M events/month + 5K session replays. На наших объёмах хватит надолго.
- Web-only frontend. Mobile via responsive design, native не планируется.
- Только NVIDIA GPU в local mode (CUDA).
