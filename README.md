# Skriptly (transcriptor-v2)

Облачный сервис транскрипции созвонов со **спикер-разделением** и **AI-инструментами**. Работает на serverless GPU (Modal), аутентификация и хранение — Supabase, лендинг — Vercel/Next.js.

**Стек:**
- **Modal** A10G GPU: faster-whisper (large-v3-turbo + опционально large-v3 для Max) + pyannote-3.1 + Qwen2.5-7B-Instruct (4-bit) + Gemini 2.5 (Flash/Pro REST API)
- **Supabase** Auth (Google OAuth + magic link) + Postgres (transcripts, user_profiles с vocabulary JSONB, workspaces)
- **Flask** на Modal как `@modal.wsgi_app()` — тонкий прокси с JWT валидацией
- **Vercel** Next.js 15 landing на `skriptly.io`, проксирует `/app` на Modal + `/ingest/*` на PostHog (reverse proxy для обхода adblock'ов)
- **PostHog EU** — product analytics (events + funnels + retention + session replay)
- **Frontend приложения** — single-file HTML/JS с tabs UI (Transcript/Summary/Actions), отдаётся Flask, доступен на `skriptly.io/app`

🔗 **Production:** https://skriptly.io
🛠 **Direct Modal endpoint:** https://razornne--transcriptor-v2-flask-app.modal.run

---

## Возможности

- 🔐 **Аутентификация** — Google OAuth или email magic link через Supabase
- 🎙 **Запись через браузер** — mic + системный звук вкладки (Meet / Teams / Zoom)
- 📝 **Транскрипция** — Whisper large-v3-turbo (default) или **large-v3 (Best Quality для Max)** с языковыми prompt'ами UA / RU / EN / **PL (польский)**
- ⏱ **Длинные созвоны (3-4ч)** — chunked pipeline: аудио режется на ~20-мин чанки, обрабатывается параллельно на нескольких GPU, спикеры глобально сшиваются через embedding-кластеризацию
- 📤 **Загрузка файлов** — кнопка Upload: любой аудио/видео файл (mp3/m4a/wav/mp4/…) → та же транскрипция; длинные файлы автоматом в chunked pipeline
- 👥 **Разделение по спикерам** — pyannote-3.1 + hybrid merger (majority-vote для коротких сегментов, word-level split для длинных, iterative smoothing)
- ✨ **Gemini STT correction** — Gemini 2.5 Flash правит фонетические ошибки используя knowledge мира (рдух → ADHD), может переносить слова через границы спикеров (boundary fix). Fallback на Qwen если Gemini недоступен.
- 📚 **Персональный словарь (wrong→right)** — авто-обучается: пары «что распознано ошибочно → что должно быть» из Gemini-правок сохраняются; правые формы идут в Whisper prompt, пары — в Gemini как «known corrections» на будущих записях
- 🤖 **AI-инструменты**: Summary, Action items (Gemini 2.5 Pro) с **настройкой детальности (Short/Medium/Detailed) + полем Focus**
- 📊 **Insights дашборд** — записей/часов всего и за месяц, использование лимита, активность по дням, языки, топ-термины
- 📑 **Tabs UI** — Transcript / Summary / Actions табы вместо длинного скролла
- 🏷 **Авто-заголовок** — LLM генерирует название по содержанию
- ✎ **Inline edit** транскрипта, **переименование спикеров**
- 📝 **Notes** прямо во время созвона
- 👥 **Workspace collaboration** — owner приглашает members, transcripts можно расшарить workspace-wide
- 💾 **Auto-save в IndexedDB** + recovery на крэш вкладки
- 🔁 **Retry** на сетевой сбой — запись остаётся в браузере, не теряется
- 🔍 **Поиск по истории** с подсветкой
- 🎨 Light / Dark тема, keyboard shortcuts: `?` (список), `⌘B` (sidebar), `⌘L` (UI lang), `⌘K` (search), `⌘S` (download)
- 📦 Export в Markdown
- ☁️ **История синхронизируется между устройствами** через Supabase Postgres
- 📊 **PostHog analytics** — events tracking, funnels, retention, session replay (через reverse proxy для обхода adblock'ов)

---

## Архитектура

```
Browser
  │ load skriptly.io
  ▼
Vercel (Next.js landing)
  ├─ /        → static landing (EN/UA, light/dark, glass design)
  ├─ /app     → rewrite to Modal Flask `/` (serves templates/index.html)
  └─ /api/*   → rewrite to Modal Flask (fallback; frontend bypasses)

Browser JS on /app
  │ JWT в Authorization header
  │ fetch напрямую на Modal (CORS, обходит Vercel 4MB body limit)
  ▼
Flask @modal.wsgi_app()  ←→  Supabase JWKS (validate JWT)
  │ Modal.spawn()
  ▼
Transcriptor @modal.cls (A10G GPU, scale-to-zero после 5 мин idle)
  ├── whisper large-v3-turbo
  ├── pyannote-3.1
  └── Qwen2.5-7B-Instruct (4-bit, для title / summary / correction)

Supabase Postgres
  └── public.transcripts (RLS, owner-only)
```

Бэк stateless: ничего не хранит, только обрабатывает аудио и валидирует токены. Все данные юзера — в Supabase.

---

## Планы и биллинг

| План | Цена | Минуты/мес | Диаризация | AI tools |
|------|------|-----------|-----------|---------|
| **Free** | $0 | 60 мин | ❌ | ❌ |
| **Pro** | $15/мес | 600 мин | ✅ | ✅ |
| **Max** | $29/мес | 2000 мин | ✅ | ✅ + Best Quality (Whisper large-v3) + **Privacy Mode** |
| **Team** | $14/seat/мес | 600 мин/seat | ✅ | ✅ + **Privacy Mode** (per-seat billing) |

**Privacy Mode** (Max/Team only) — toggle в Settings отключает Gemini API: вся транскрипция и AI-генерация идут через self-hosted модели на нашем Modal GPU (gpt-oss-20b + Qwen). Данные не покидают нашу инфру.

Минуты считаются по реальной длительности аудио. Сбрасываются 1-го числа каждого месяца.
Биллинг через Stripe. Подробнее — см. **[BILLING.md](./BILLING.md)**.

---

## Что отличается от v1

| | v1 | v2 |
|---|---|---|
| Whisper | OpenAI API | Modal A10G (large-v3-turbo + large-v3) |
| LLM | OpenAI API | Qwen2.5-7B (title) + Gemini 2.5 Flash/Pro |
| STT correction | ❌ | ✅ Gemini 2.5 Flash (world knowledge + boundary fix) |
| Диаризация | ❌ | ✅ pyannote-3.1 + word-level alignment |
| Авто-словарь | ❌ | ✅ авто-обучается из Gemini corrections |
| Аутентификация | ❌ | ✅ Supabase Auth (Google + magic link) |
| Хранение истории | localStorage | Supabase Postgres (sync между устройствами) |
| Хостинг | Railway | Modal serverless (pay-per-use, idle = $0) |
| Лендинг | ❌ | ✅ Next.js на skriptly.io (Vercel) |
| Аналитика | ❌ | ✅ PostHog (events + funnels + session replay) |
| Биллинг | ❌ | ✅ Stripe (Pro / Max подписки) |
| Стоимость на час аудио | ~$0.30 | ~$0.05-0.10 |
| Качество на UA/RU | хорошее | очень хорошее |

---

## Использование (для конечного юзера)

1. Открыть https://razornne--transcriptor-v2-flask-app.modal.run
2. Залогиниться через Google или magic link на email
3. Выбрать язык (auto-detect или конкретный)
4. Опционально: указать число спикеров
5. **Start recording** → разрешить микрофон → выбрать вкладку и включить «Поделиться звуком»
6. **Stop** → подождать обработки (~1-2 мин на час аудио)
7. Получить транскрипт со спикерами + авто-заголовок
8. Опционально: Summary / Action items / выбрать template
9. Copy или Download `.md`

**Подсказки:**
- Pin tab + отключить Memory Saver для сайта = записи не теряются в фоне
- `?` показывает все горячие клавиши
- Двойной клик по реплике — редактировать
- Клик на «Speaker 1» — переименовать
- История синхронизируется через Supabase — открой с любого устройства

---

## Установка / локальный dev

### Production deploy (Modal)

Сервис уже задеплоен. Чтобы пушить изменения:

```powershell
.\venv\Scripts\Activate.ps1
modal deploy modal_app.py
```

Modal Secret (все ключи разом, `--force` заменяет целиком):
```powershell
modal secret create transcriptor-secrets `
  HF_TOKEN=hf_... `
  SUPABASE_URL=https://bmonakhktbaliwgobrxv.supabase.co `
  SUPABASE_SERVICE_ROLE_KEY=eyJ... `
  GEMINI_API_KEY=AIza... `
  STRIPE_SECRET_KEY=sk_live_... `
  STRIPE_WEBHOOK_SECRET=whsec_... `
  STRIPE_PRO_MONTHLY_PRICE=price_... `
  STRIPE_PRO_ANNUAL_PRICE=price_... `
  STRIPE_MAX_MONTHLY_PRICE=price_... `
  STRIPE_MAX_ANNUAL_PRICE=price_... `
  --force
```

См. `.env.example` — полный список переменных с комментариями.

### Локальный dev (без Modal)

Для разработки можно запустить весь пайплайн локально. Понадобятся:

- **NVIDIA GPU с 6+ GB VRAM** (RTX 3060 / 3070 / 4060+)
- **CUDA 12.1+** + свежие драйверы
- **ffmpeg** в PATH
- **Python 3.10+**
- **Ollama** для LLM
- **~10 GB места** под модели

```powershell
# 1. ffmpeg
winget install Gyan.FFmpeg

# 2. Ollama
winget install Ollama.Ollama
ollama pull qwen2.5:3b

# 3. HuggingFace токен (для pyannote)
#    Создать на https://huggingface.co/settings/tokens (Read)
#    Принять условия:
#      https://huggingface.co/pyannote/speaker-diarization-3.1
#      https://huggingface.co/pyannote/speaker-diarization-community-1

# 4. Python venv
python -m venv venv
.\venv\Scripts\Activate.ps1
pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu124
pip install -r requirements.txt
pip install nvidia-cudnn-cu12 nvidia-cublas-cu12

# 5. cuDNN fix (см. ниже)

# 6. .env
Copy-Item .env.example .env
# HF_TOKEN=hf_... (обязательно)

# 7. Запуск
python app.py  # → http://localhost:5000
```

### ⚠️ cuDNN-конфликт PyTorch vs CTranslate2 на Windows

PyTorch несёт cuDNN 9.1, CTranslate2 (внутри faster-whisper) собран против cuDNN 9.2+ и требует `cudnnGetLibConfig`. Без фикса крэш `Could not load symbol cudnnGetLibConfig. Error code 127`.

```powershell
cd venv\Lib\site-packages\torch\lib
Get-ChildItem cudnn*.dll | ForEach-Object { Rename-Item $_.FullName -NewName ($_.Name + ".bak") }
Copy-Item ..\..\nvidia\cudnn\bin\cudnn*.dll .
cd ..\..\..\..\..
```

### Использование Modal backend из локального Flask

Если хочется UI локально, а тяжёлый ML — на Modal:

```powershell
$env:USE_MODAL = "true"
python app.py
```

Тогда `app.py` будет вызывать задеплоенный `Transcriptor` через Modal SDK.

---

## Структура проекта

```
modal_app.py         — Modal app: Transcriptor cls (A10G GPU) + flask_app wsgi
app.py               — Flask backend: эндпоинты, JWT validation, async jobs,
                       Stripe биллинг, usage tracking, language detection
transcriber.py       — local mode: faster-whisper wrapper
diarizer.py          — local mode: pyannote wrapper
merger.py            — word-level speaker alignment (общий)
templates/index.html — UI приложения (single-file, ~5200 строк)

landing/             — Next.js лендинг на skriptly.io (Vercel)
├── app/             — App Router (layout, page, globals.css)
├── components/      — Nav, Hero, Features, Pricing, и т.д.
├── lib/             — content.ts (EN/UA), hooks.ts
└── next.config.mjs  — Vercel rewrites на Modal + PostHog reverse proxy

requirements.txt
.env.example         — все env переменные с комментариями
ROADMAP.md           — план следующих шагов
BILLING.md           — планы, лимиты, Stripe flow, usage tracking
CLAUDE.md            — техническая документация для Claude / future-devs
```

---

## Ограничения

- **Поддерживается только GPU** в production (Modal A10G). Локальный режим — только NVIDIA CUDA.
- **Supabase free tier**: 500 MB БД, 50K MAU, 4 magic link emails в час (custom SMTP снимает лимит).
- **Google OAuth** опубликован — любой Google-юзер может войти.
- **Stripe**: тестовые карты `4242 4242 4242 4242` для dev, live ключи для прода.
- **Web-only frontend**. Native (Electron / iOS / Android) — на будущее.

---

## Что дальше — см. [ROADMAP.md](./ROADMAP.md)
