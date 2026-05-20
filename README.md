# Skriptly (transcriptor-v2)

Облачный сервис транскрипции созвонов со **спикер-разделением** и **AI-инструментами**. Работает на serverless GPU (Modal), аутентификация и хранение — Supabase. Ноут юзера не нужен.

**Стек:**
- **Modal** A10G GPU: faster-whisper (large-v3-turbo) + pyannote-3.1 + Qwen2.5-7B-Instruct (4-bit)
- **Supabase** Auth (Google OAuth + magic link) + Postgres с Row-Level Security
- **Flask** на Modal как `@modal.wsgi_app()` — тонкий прокси
- **Frontend** — single-file HTML/JS (на пути к Vercel + Next.js лендинг)

🔗 **Текущий URL:** https://razornne--transcriptor-v2-flask-app.modal.run
🎯 **Будет:** https://skriptly.io

---

## Возможности

- 🔐 **Аутентификация** — Google OAuth или email magic link через Supabase
- 🎙 **Запись через браузер** — mic + системный звук вкладки (Meet / Teams / Zoom)
- 📝 **Транскрипция** — Whisper large-v3-turbo с языковыми prompt'ами под качество UA / RU / EN
- 👥 **Разделение по спикерам** — pyannote-3.1 + word-level alignment в merger (правильно режет быстрый диалог)
- ✨ **LLM correction** — Qwen2.5 вычищает фонетические ошибки распознавания после транскрипции
- 🤖 **AI-инструменты**: Summary, Action items, Sales call / 1-on-1 / Stand-up templates
- 🏷 **Авто-заголовок** — LLM генерирует название по содержанию
- ✎ **Inline edit** транскрипта, **переименование спикеров**
- 📝 **Notes** прямо во время созвона
- 💾 **Auto-save в IndexedDB** + recovery на крэш вкладки
- 🔁 **Retry** на сетевой сбой — запись остаётся в браузере, не теряется
- 🔍 **Поиск по истории** с подсветкой
- 🎨 Light / Dark тема, keyboard shortcuts (`?` чтобы посмотреть)
- 📦 Export в Markdown
- ☁️ **История синхронизируется между устройствами** через Supabase Postgres

---

## Архитектура

```
Browser
  │ JWT (Supabase Auth)
  ▼
Flask @modal.wsgi_app()  ←→  Supabase JWKS (validate JWT)
  │ Modal.spawn()
  ▼
Transcriptor @modal.cls (A10G)
  ├── whisper large-v3-turbo
  ├── pyannote-3.1
  └── Qwen2.5-7B-Instruct (4-bit)

Supabase Postgres
  └── public.transcripts (RLS, owner-only)
```

Бэк stateless: ничего не хранит, только обрабатывает аудио и валидирует токены. Все данные юзера — в Supabase.

---

## Что отличается от v1

| | v1 | v2 |
|---|---|---|
| Whisper | OpenAI API | Modal A10G (large-v3-turbo) |
| LLM | OpenAI API | Modal A10G (Qwen2.5-7B-Instruct) |
| Диаризация | ❌ | ✅ pyannote-3.1 + word alignment |
| Аутентификация | ❌ | Supabase Auth (Google + magic link) |
| Хранение истории | localStorage | Supabase Postgres (sync между устройствами) |
| Хостинг | Railway | Modal serverless (pay-per-use, idle = $0) |
| Стоимость на час аудио | ~$0.30 | ~$0.05-0.10 |
| Качество на UA/RU | хорошее | очень хорошее |
| AI-фичи (саммари, action items, chat) | ❌ | ✅ |
| Custom domain | — | skriptly.io (готовится) |

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

Modal Secret (один раз):
```powershell
modal secret create transcriptor-secrets HF_TOKEN=hf_... SUPABASE_URL=https://YOUR_PROJECT.supabase.co --force
```

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
app.py               — Flask backend: эндпоинты, JWT validation, async jobs
transcriber.py       — local mode: faster-whisper wrapper
diarizer.py          — local mode: pyannote wrapper
merger.py            — word-level speaker alignment (общий)
templates/index.html — UI (single-file, ~3000 строк)
requirements.txt
.env.example
ROADMAP.md           — план следующих шагов
CLAUDE.md            — техническая документация для Claude / future-devs
```

---

## Ограничения

- **Поддерживается только GPU** в production (Modal A10G). Локальный режим — только NVIDIA CUDA.
- **Supabase free tier**: 500 MB БД, 50K MAU, 4 magic link emails в час (custom SMTP снимает лимит).
- **Google OAuth в testing mode**: только добавленные test users могут логиниться через Google (max 100). Для широкой публики — нужно publish app в Google Cloud Console.
- **Web-only frontend**. Native (Electron / iOS / Android) — на будущее, когда уйдут проблемы с background-вкладками.

---

## Что дальше — см. [ROADMAP.md](./ROADMAP.md)
