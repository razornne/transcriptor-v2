# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## What this is

**Transcriptor v2** — локальная версия транскриптора. Whisper и pyannote крутятся прямо на пользовательском ПК с NVIDIA GPU, данные никуда не уходят. В отличие от v1 (которая лежит в `C:\projects\transcriptor\` и крутится на Railway через OpenAI API), здесь:

- **faster-whisper-medium** локально (CUDA, float16) вместо OpenAI API
- **pyannote-3.1** для разделения по спикерам, тоже на CUDA
- Сервер запускается на ноуте, фронт — там же; план перевести фронт на Vercel + Cloudflare Tunnel на ноут для бэка
- **Двухступенчатый поток обработки:**
  - Во время записи: каждые 3 минуты чанк уходит на `/api/transcribe-chunk` (только whisper) → live-текст без спикеров появляется по ходу созвона
  - По нажатию Стоп: полная запись уходит на `/api/transcribe` (whisper + pyannote + merge) → live-текст заменяется на блоки со спикерами

v1 продолжает работать параллельно — это **намеренно**. Не пытаться слить версии обратно.

## Common commands

```powershell
# Setup
python -m venv venv
.\venv\Scripts\Activate.ps1
pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu124
pip install -r requirements.txt
pip install nvidia-cudnn-cu12 nvidia-cublas-cu12

# Cudnn fix — критически важно, см. подробности в README
cd venv\Lib\site-packages\torch\lib
Get-ChildItem cudnn*.dll | ForEach-Object { Rename-Item $_.FullName -NewName ($_.Name + ".bak") }
Copy-Item ..\..\nvidia\cudnn\bin\cudnn*.dll .
cd ..\..\..\..\..

# .env с HF_TOKEN — обязательно (без него pyannote не загрузится)
Copy-Item .env.example .env

# Run
python app.py  # → http://localhost:5000

# Публичный URL (для теста с другого устройства)
cloudflared tunnel --url http://localhost:5000
```

Нет тестов, нет линтера, нет билд-шага.

## Architecture

Четыре питон-файла:

- **`transcriber.py`** — `transcribe(path, language, prompt)`. Грузит faster-whisper-medium на GPU при первом вызове, держит модель в памяти (`_model` глобально). Возвращает список `{start, end, text}` — секунды от начала аудио. Включён встроенный `vad_filter=True` (Silero VAD внутри faster-whisper) — отсекает тишину до обработки, сильно сокращает галлюцинации.

- **`diarizer.py`** — `diarize(path, num_speakers)`. Грузит pyannote/speaker-diarization-3.1 (требует `HF_TOKEN` в env и принятых условий модели на HF). Переносит на CUDA если доступна. **Аудио читаем сами через `soundfile`** и передаём как `{waveform: tensor, sample_rate: int}` — torchcodec на Windows не работает со static-ffmpeg, поэтому обходим. Возвращает `{start, end, speaker}` где speaker = "SPEAKER_00", "SPEAKER_01"... `num_speakers` — необязательная подсказка, если известно точное число. В pyannote 4.x результат лежит в `.speaker_diarization` (а не на верхнем уровне).

- **`merger.py`** — `merge(transcript_segments, speaker_turns)`. Три шага:
  1. Для каждого whisper-сегмента — speaker по максимальному overlap с pyannote-турнами
  2. **Smoothing**: короткий сегмент (`< MIN_SEGMENT_DURATION_S = 2.0s`), зажатый между двумя одинаковыми спикерами, переназначается на их спикера. Лечит мелкие огрехи диаризации (например, односекундные реакции прилипают не туда)
  3. Склеивание подряд идущих сегментов одного спикера в блоки

- **`app.py`** — Flask + flask-cors. Два маршрута:
  - `POST /api/transcribe-chunk` — быстрый, только whisper. Принимает `audio`/`language`/`prompt`, возвращает `{"text": "..."}`. Используется фронтом для live-текста во время записи.
  - `POST /api/transcribe` — полный пайплайн. Принимает `audio`/`language`/`num_speakers`/`prompt`, гоняет whisper → pyannote → merge, возвращает `{"segments": [{speaker, start, end, text}]}`. Используется после Стоп.
  - `_webm_to_wav(path)` — обязательная конвертация через ffmpeg subprocess (для pyannote, см. ниже).
  - Маршрут `GET /` отдаёт `index.html` для локалки; когда фронт переедет на Vercel — можно удалить.

**Фронт `templates/index.html`** — single-file (CSS+JS inline), английский UI. Ключевые куски:
- Wide display-шрифт Bricolage Grotesque (variable wdth axis) + JetBrains Mono для таймингов. Загрузка с Google Fonts.
- **Theme toggle** (light/dark) через `data-theme` атрибут на `<html>`, сохраняется в localStorage. Inline-скрипт в `<head>` применяет тему до paint — без flash-of-wrong-theme.
- **Два параллельных MediaRecorder'а** на одном `dest.stream` (микс mic + getDisplayMedia через AudioContext):
  - `chunkRecorder` стопается/перезапускается каждые `CHUNK_INTERVAL_MS = 3 мин` → каждый чанк уходит на `/api/transcribe-chunk` → текст накапливается в `liveTextParts`
  - `fullRecorder` пишет всё непрерывно → на Стопе отправляется на `/api/transcribe` для финальной диаризации
- **Speaker rename**: клик по `.speaker-name` → inline-input → Enter сохраняет в `currentSpeakerNames[rawLabel]` → ре-рендер. Имена сохраняются в записи истории.
- **localStorage**: `transcriptor_settings` (lang + numSpeakers), `transcriptor_history` (segments + speakerNames per entry, MAX 20), `theme`.
- `prefers-reduced-motion` уважается, есть `prefers-color-scheme` fallback для первого визита.

## Non-obvious things future-Claude will trip on

- **Whisper и pyannote НЕЛЬЗЯ заменить на API-варианты в этом проекте.** Вся идея v2 — приватность через локальные модели. Если нужен API — это v1.

- **CUDA install — отдельно от requirements.txt.** PyTorch с CUDA ставится `pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu124` (или cu121). Если просто `pip install torch` — поставится CPU-версия и всё будет работать в 10 раз медленнее без ошибок. Незаметно но больно.

- **cuDNN-конфликт PyTorch vs CTranslate2 на Windows.** PyTorch 2.6+cu124 несёт cuDNN 9.1.0 в `torch/lib/`. CTranslate2 4.7+ (внутри faster-whisper) собран против cuDNN 9.2+ и требует символ `cudnnGetLibConfig` (добавлен в 9.2). Без фикса крэш `Could not load symbol cudnnGetLibConfig. Error code 127` при первой GPU-операции — Python падает целиком без traceback. **Фикс:** ставим `nvidia-cudnn-cu12` (9.22), переименовываем `torch/lib/cudnn*.dll` в `.bak`, копируем туда же DLL из `nvidia/cudnn/bin/`. Минорные версии cuDNN backward-compatible, торч этого не замечает. Подробности — в README.

- **torchcodec на Windows со static-ffmpeg не работает.** При импорте pyannote сыпет длинным warning'ом про libtorchcodec_core*.dll. Это безопасно потому что в `diarizer.py` мы НЕ передаём pyannote путь к файлу — мы сами читаем через `soundfile` и отдаём как dict с тензором. **Не пытаться "починить" torchcodec** установкой ffmpeg-shared — никакой выгоды, только новые проблемы. Текущая схема рабочая.

- **pyannote 4.x API изменился.** `Pipeline.from_pretrained(..., token=...)` (а не `use_auth_token`). Результат `pipeline()` — `DiarizeOutput` объект, диаризация внутри `.speaker_diarization` (Annotation). Старый код `result.itertracks(...)` упадёт.

- **ffmpeg в PATH обязателен** для `_webm_to_wav` (subprocess.run) и faster-whisper (внутри). Это системная зависимость, не Python.

- **`HF_TOKEN` обязателен.** Без него pyannote `from_pretrained` упадёт. И токен бесполезен пока не принять условия на ОБОИХ страницах: https://huggingface.co/pyannote/speaker-diarization-3.1 И https://huggingface.co/pyannote/speaker-diarization-community-1 (новая зависимость в 4.x).

- **Модели держатся в памяти между запросами.** Первый вызов медленный (~10 сек загрузки), последующие быстрые. Не сбрасывать `_model` / `_pipeline` без причины.

- **VRAM 8 GB — впритык для large-v3 + pyannote вместе.** На RTX 3070 ставим `medium` (умолчание, ~3.5 GB). Если очень нужен large-v3 — через `WHISPER_MODEL=large-v3` env, но придётся следить за `nvidia-smi`.

- **Диаризация требует полное аудио целиком** — поэтому два MediaRecorder'а (см. Architecture). Метки спикеров между независимыми чанками не совпали бы. Не пытаться диаризовать каждый chunk отдельно.

- **При первой /api/transcribe могут пройти несколько /api/transcribe-chunk параллельно** (Flask dev server однопоточный, но запросы могут перекрыться по идее). На практике это ок т.к. модели shared в памяти, GIL сериализует. Если переводить на gunicorn — `--workers 1` обязателен (модели не делятся между процессами через fork).

- **`speakerName()` в JS** превращает "SPEAKER_00" → "Speaker 1" (zero-indexed → 1-indexed), но СНАЧАЛА проверяет `currentSpeakerNames[rawLabel]` — переопределения через UI-rename. pyannote всегда начинает с 00.

- **`CORS(app, resources={r"/api/*": {"origins": "*"}})`** — открыто всем для dev. В проде заменить на список доменов через ENV. Без CORS Vercel-фронт не сможет ходить на бэк.

- **`recordings/` ephemeral.** Файлы удаляются сразу после обработки (и для chunk, и для full). На сервере ничего не хранится — это часть приватности.

- **История в localStorage хранит `segments` целиком + `speakerNames`** (не flat-текст). Это позволяет восстановить раскраску и переименования при клике на запись истории. Не ломать формат без миграции.

## Deployment

Сейчас: запускается локально, Cloudflare Tunnel для публичного доступа.

Планируется:
- Frontend → Vercel
- Backend → продолжает на ноуте (для personal use) или переезд на GPU VPS / Modal (для commercial)

## Constraints

- Только NVIDIA GPU (CUDA). MPS на Mac не пробовал, ROCm не пробовал.
- Один пользователь за раз (Flask + одна модель в памяти). Многопользовательность — отдельная задача (multi-instance или queue).
- 8 GB VRAM минимум для medium + pyannote одновременно. На 6 GB лучше small/base + pyannote.
- v2 features ещё впереди: auth + multi-user, БД, шеринг между юзерами, поиск по транскриптам.
