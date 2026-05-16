# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## What this is

**Transcriptor v2** — локальная версия транскриптора. Whisper и pyannote крутятся прямо на пользовательском ПК с NVIDIA GPU, данные никуда не уходят. В отличие от v1 (которая лежит в `C:\projects\transcriptor\` и крутится на Railway через OpenAI API), здесь:

- **faster-whisper** локально (CUDA, float16) вместо OpenAI API
- **pyannote-3.1** для разделения по спикерам
- Сервер запускается на ноуте, фронт ходит через Cloudflare Tunnel (планируется вынос фронта на Vercel)
- Поток обработки: записал → стоп → ждёшь полный пайплайн → текст со спикерами

v1 продолжает работать параллельно — это **намеренно**. Не пытаться слить версии обратно.

## Common commands

```powershell
# Setup
python -m venv venv
.\venv\Scripts\Activate.ps1
pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu121
pip install -r requirements.txt

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

- **`diarizer.py`** — `diarize(path, num_speakers)`. Грузит pyannote/speaker-diarization-3.1 (требует `HF_TOKEN` в env и принятых условий модели на HF). Переносит на CUDA если доступна. Возвращает `{start, end, speaker}` где speaker = "SPEAKER_00", "SPEAKER_01"... `num_speakers` — необязательная подсказка, если известно точное число.

- **`merger.py`** — `merge(transcript_segments, speaker_turns)`. Для каждого whisper-сегмента ищет pyannote-турн с максимальным overlap по времени → присваивает speaker. Потом склеивает подряд идущие сегменты одного спикера в блоки.

- **`app.py`** — Flask + flask-cors. Один основной маршрут `POST /api/transcribe`: принимает multipart с `audio`/`language`/`num_speakers`/`prompt`, гоняет через whisper → pyannote → merge, возвращает `{"segments": [{speaker, start, end, text}]}`. Маршрут `GET /` отдаёт `index.html` для локалки (когда фронт переедет на Vercel — можно удалить).

Фронт `templates/index.html` — копия v1 с правками: убрано чанкование, добавлено отображение спикеров блоками, добавлено поле `numSpeakers`, конст `API_BASE` для конфигурации URL бэка (пустая = тот же origin).

## Non-obvious things future-Claude will trip on

- **Whisper и pyannote НЕЛЬЗЯ заменить на API-варианты в этом проекте.** Вся идея v2 — приватность через локальные модели. Если нужен API — это v1.

- **CUDA install — отдельно от requirements.txt.** PyTorch с CUDA ставится `pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu124` (или cu121). Если просто `pip install torch` — поставится CPU-версия и всё будет работать в 10 раз медленнее без ошибок. Незаметно но больно.

- **cuDNN-конфликт PyTorch vs CTranslate2 на Windows.** PyTorch 2.6+cu124 несёт cuDNN 9.1.0 в `torch/lib/`. CTranslate2 4.7+ (внутри faster-whisper) собран против cuDNN 9.2+ и требует символ `cudnnGetLibConfig` (добавлен в 9.2). Без фикса крэш `Could not load symbol cudnnGetLibConfig. Error code 127` при первой GPU-операции — Python падает целиком без traceback. **Фикс:** ставим `nvidia-cudnn-cu12` (9.22), переименовываем `torch/lib/cudnn*.dll` в `.bak`, копируем туда же DLL из `nvidia/cudnn/bin/`. Минорные версии cuDNN backward-compatible, торч этого не замечает. Подробности — в README.

- **pyannote требует ffmpeg в PATH** для конвертации WebM из браузера. Без ffmpeg — `pipeline(path)` упадёт на чтении файла. faster-whisper тоже использует ffmpeg внутри. Это системная зависимость, не Python.

- **`HF_TOKEN` обязателен.** Без него pyannote `from_pretrained` упадёт. И токен бесполезен пока не принять условия модели на странице https://huggingface.co/pyannote/speaker-diarization-3.1 (одноразовый клик).

- **Модели держатся в памяти между запросами.** Первый вызов медленный (~10 сек загрузки), последующие быстрые. Не сбрасывать `_model` / `_pipeline` без причины.

- **VRAM 8 GB — впритык для large-v3 + pyannote вместе.** На RTX 3070 ставим `medium` (умолчание). Если очень нужен large-v3 — можно через `WHISPER_MODEL=large-v3` env, но придётся следить за `nvidia-smi`.

- **Диаризация требует полное аудио целиком.** Чанкование как в v1 здесь не работает — спикер-метки между чанками не совпадут. Это архитектурное ограничение. Если хочется live-текста, нужно либо два параллельных MediaRecorder'a (один для chunked whisper, второй накапливает для финальной диаризации), либо отказаться от live-текста.

- **`speakerName()` в JS** превращает "SPEAKER_00" → "Спикер 1" (zero-indexed → 1-indexed). pyannote всегда начинает с 00.

- **`CORS(app, resources={r"/api/*": {"origins": "*"}})`** — открыто всем для dev. В проде заменить на список доменов через ENV. Без CORS Vercel-фронт не сможет ходить на бэк.

- **`recordings/` ephemeral.** Файлы удаляются сразу после обработки. На сервере ничего не хранится — это часть приватности.

## Deployment

Сейчас: запускается локально, Cloudflare Tunnel для публичного доступа.

Планируется:
- Frontend → Vercel
- Backend → продолжает на ноуте (для personal use) или переезд на GPU VPS / Modal (для commercial)

## Constraints

- Только NVIDIA GPU (CUDA). MPS на Mac не пробовал, ROCm не пробовал.
- Один пользователь за раз (Flask + одна модель в памяти). Многопользовательность — отдельная задача (multi-instance или queue).
- 8 GB VRAM минимум для medium + pyannote одновременно. На 6 GB лучше small/base + pyannote.
- v2 features в работе: лайв-текст с диаризацией (требует двух MediaRecorder), auth, БД, шеринг между юзерами.
