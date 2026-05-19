# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## What this is

**Transcriptor v2** — локальная версия транскриптора. Whisper, pyannote и LLM (через Ollama) крутятся прямо на пользовательском ПК, данные никуда не уходят. В отличие от v1 (которая лежит в `C:\projects\transcriptor\` и крутится на Railway через OpenAI API), здесь:

- **faster-whisper large-v3** локально (CUDA, float16) вместо OpenAI API. С набором декодинг-параметров под максимальное качество на RU/UK.
- **pyannote-3.1** для разделения по спикерам, тоже на CUDA
- **Ollama + qwen2.5:3b** (CPU) для LLM-задач: title / summary / action items / templates / chat. Qwen лучше llama3.2 на славянских языках.
- Сервер запускается на ноуте, доступен публично через Cloudflare Tunnel (быстрый named-less tunnel)
- **Поток обработки:**
  - Во время записи фронт пишет `fullRecorder` с `timeslice=5s` и сохраняет каждый чанк в IndexedDB (autosave для recovery при краше вкладки). UI ничего не показывает — только статус «recording» и таймер.
  - По нажатию Стоп: полная запись уходит на `/api/transcribe` (whisper + pyannote + merge) → блоки со спикерами
  - После — фронт асинхронно дёргает `/api/title` за умным названием транскрипта от LLM (с индикатором ✨ thinking…)
  - Бэк-эндпоинт `/api/transcribe-chunk` остался в коде, но фронтом не вызывается — оставлен на случай возврата live-text фичи.

v1 продолжает работать параллельно — это **намеренно**. Не пытаться слить версии обратно.

## Common commands

```powershell
# Setup
python -m venv venv
.\venv\Scripts\Activate.ps1
pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu124
pip install -r requirements.txt
pip install nvidia-cudnn-cu12 nvidia-cublas-cu12

# cuDNN fix — критически важно, см. подробности в README
cd venv\Lib\site-packages\torch\lib
Get-ChildItem cudnn*.dll | ForEach-Object { Rename-Item $_.FullName -NewName ($_.Name + ".bak") }
Copy-Item ..\..\nvidia\cudnn\bin\cudnn*.dll .
cd ..\..\..\..\..

# Ollama (для LLM-фич)
winget install Ollama.Ollama
ollama pull qwen2.5:3b  # дефолтная модель

# ffmpeg в PATH (через winget или вручную)
winget install Gyan.FFmpeg

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

- **`transcriber.py`** — `transcribe(path, language, prompt)`. Грузит faster-whisper-large-v3 (захардкоженный дефолт, override через `WHISPER_MODEL` env) на GPU при первом вызове, держит модель в памяти (`_model` глобально). Параметры подобраны под качество: `temperature=(0,0.2,...,1.0)` fallback, `compression_ratio_threshold=2.4`, `log_prob_threshold=-1.0`, `no_speech_threshold=0.6`, `condition_on_previous_text=True`, `beam_size=5`, `best_of=5`. Возвращает список `{start, end, text}` — секунды от начала аудио. Включён встроенный `vad_filter=True` (Silero VAD внутри faster-whisper) — отсекает тишину до обработки.

- **`diarizer.py`** — `diarize(path, num_speakers)`. Грузит pyannote/speaker-diarization-3.1 (требует `HF_TOKEN` в env и принятых условий модели на HF). Переносит на CUDA если доступна. **Аудио читаем сами через `soundfile`** и передаём как `{waveform: tensor, sample_rate: int}` — torchcodec на Windows не работает со static-ffmpeg, поэтому обходим. Возвращает `{start, end, speaker}` где speaker = "SPEAKER_00", "SPEAKER_01"... `num_speakers` — необязательная подсказка, если известно точное число. В pyannote 4.x результат лежит в `.speaker_diarization` (а не на верхнем уровне).

- **`merger.py`** — `merge(transcript_segments, speaker_turns)`. Три шага:
  1. Для каждого whisper-сегмента — speaker по максимальному overlap с pyannote-турнами
  2. **Smoothing**: короткий сегмент (`< MIN_SEGMENT_DURATION_S = 2.0s`), зажатый между двумя одинаковыми спикерами, переназначается на их спикера. Лечит мелкие огрехи диаризации (например, односекундные реакции прилипают не туда)
  3. Склеивание подряд идущих сегментов одного спикера в блоки

- **`app.py`** — Flask + flask-cors. Эндпоинты:
  - **Async с polling** (долгие операции, обходят 100-сек таймаут Cloudflare Quick Tunnel):
    - `POST /api/transcribe` — принимает аудио, возвращает `{job_id, status}`. Обработка (whisper + pyannote + merge) в фоновом потоке. Результат через polling.
    - `POST /api/generate` — LLM-обработка транскрипта по шаблону. Принимает `{segments, speakerNames?, template, language?}`. `language` инжектится через `LANG_HINTS` в промпт (qwen2.5 без явного указания склонен отвечать по-английски). Возвращает `{job_id}`.
    - `POST /api/chat` — вопрос-ответ по транскрипту. Принимает `{segments, speakerNames?, messages, question, language?}`. Промпт: системный + транскрипт + последние 10 сообщений из истории + новый вопрос. Возвращает `{job_id}`.
    - `GET /api/jobs/<job_id>` — статус задачи. Поля: `status` (`queued` | `processing` | `done` | `error`), `progress` (для transcribe — `converting/transcribing/diarizing/merging`), плюс результат при `done` (`segments` / `result` / `answer`) или `error` при ошибке.
  - **Sync** (быстрые операции):
    - `POST /api/transcribe-chunk` — быстрый, только whisper. Возвращает `{"text": "..."}`. **Фронтом сейчас не используется** (live-text отключён), но эндпоинт оставлен на случай возврата фичи.
    - `POST /api/title` — LLM-генерация заголовка (~5-10 с). JSON-вход `{text, language?}`, возвращает `{"title": "..."}`. Sync т.к. короткий.
    - `POST /api/tags` — LLM-генерация 2-4 тегов категории (всегда на английском для надёжной фильтрации). Sync, ~5-10 с. JSON-вход `{segments, speakerNames?}`, возвращает `{"tags": [...]}`. **Фронт не использует** пока (FEATURE_TAGS=false).
  - **Internals**:
    - `JOBS` dict + `JOBS_LOCK` — реестр async-задач. TTL 30 минут, чистится при каждом GET /api/jobs.
    - `_create_job(kind)` → `_update_job(id, **fields)` → `_get_job(id)` — thread-safe helpers.
    - `_webm_to_wav(path)` — обязательная конвертация через ffmpeg subprocess (для pyannote, см. ниже).
    - `_ollama_generate(prompt, *, max_tokens, temperature, timeout)` — обёртка над Ollama HTTP API через `requests`. Передаёт `temperature` и `num_predict` в options.
    - `GENERATE_TEMPLATES` dict — шаблоны промптов для summary/actions/sales_call/one_on_one/standup. Каждый ожидает `{text}` и `{lang_hint}` placeholders.
    - `LANG_HINTS` dict — `{ru: "Write the entire response in Russian.", uk: "...", en: "..."}`. Инжектится в промпт чтобы LLM не отвечал по-английски когда транскрипт на украинском/русском.
  - Маршрут `GET /` отдаёт `index.html` для локалки; когда фронт переедет на Vercel — можно удалить.

**Фронт `templates/index.html`** — single-file (CSS+JS inline), английский UI. Inline SVG favicon (микрофон). Ключевые куски:

### Базовые UI-механизмы
- Wide display-шрифт Bricolage Grotesque (variable wdth axis) + JetBrains Mono для таймингов. Загрузка с Google Fonts.
- **Theme toggle** (light/dark) через `data-theme` атрибут на `<html>`, сохраняется в localStorage. Inline-скрипт в `<head>` применяет тему до paint — без flash-of-wrong-theme.
- **Async job polling** — `submitJob(url, body, isFormData)` отправляет запрос и получает `{job_id}`, затем `pollJob(jobId, onProgress)` опрашивает `/api/jobs/<id>` каждые 2 секунды до `status: done | error`. `onProgress` колбэк получает строку прогресса (`transcribing`, `diarizing`, etc.) и обновляет статус-индикатор в UI. `safeJson(res)` парсит ответ через `.text() → JSON.parse()` чтобы детектировать HTML-ошибки от Cloudflare/прокси и показывать осмысленный текст вместо `Unexpected token '<'`.
- **Markdown renderer** — собственный мини-парсер `renderMarkdown()` (~70 строк). Поддерживает: `#`/`##`/`###` headings, `**bold**`/`*italic*`/`_italic_`/` `code` `, `-`/`*` списки, `1.` нумерованные, `- [ ]`/`- [x]` task checkboxes (рендерятся как стилизованные чекбоксы с псевдоэлементами). Не нужно тащить marked.js.

### Запись
- **Один MediaRecorder** (`fullRecorder`) на `dest.stream` (микс mic + getDisplayMedia через AudioContext). `start(5000)` timeslice → `ondataavailable` срабатывает каждые 5 сек, каждый кусок пишется в IndexedDB (см. Audio safety net). На Стопе склеенный blob отправляется на `/api/transcribe` для финальной диаризации.
- Во время записи UI ничего не показывает кроме статуса/таймера — live-текст был намеренно убран (создавал лишнюю GPU-нагрузку на ноуте во время созвона без реальной пользы).

### Tab keep-alive trics (важно для долгих созвонов с background-вкладкой)
- **Silent audio playback** — на старте создаётся `OscillatorNode` с gain=0.0001, подключённый к `audioCtx.destination`. Браузер видит «играет звук» → не дискардит вкладку даже когда юзер на других окнах. Самый мощный трюк, без него Chrome убивает вкладку через ~5 минут в фоне.
- **Wake Lock API** — `navigator.wakeLock.request('screen')` на старте, release на стопе. Re-acquire на `visibilitychange` (браузер auto-release при hide).
- **OS Notifications** — `Notification.requestPermission()` на первом старте, потом `notify(title, body)` для «Recording started» / «Transcription ready» / «Transcription failed». Детальный console.log в `[notify] ...` для дебага. После grant сразу шлёт тестовое уведомление чтобы юзер увидел работают ли они вообще.
- **Battery warning** — на старте `navigator.getBattery()`, если не charging + level<40% → confirm перед записью.
- **Visibility re-acquire** — при возврате фокуса проверяет `wakeLock` и пересоздаёт если нужно.

### Audio safety net (3 уровня)
- **`lastRecordingBlob`** — после Stop сохраняем blob в памяти до успешной транскрипции. Если /api/transcribe вернул ошибку → показываем `#recoveryBox` с кнопками **Retry transcription**, **Download .webm**, **Discard**. Юзер не теряет запись даже при сетевых сбоях.
- **`beforeunload` warning** — если `lastRecordingBlob` не пустой, браузер спросит «Are you sure you want to leave?» при закрытии.
- **IndexedDB autosave** — `idbCreateSession() / idbAppendChunk() / idbDeleteSession()`. Каждый chunk fullRecorder'а (timeslice=5сек) сохраняется в IDB. Если вкладка/Chrome крашнется → при следующем открытии `idbGetOrphanedSessions()` находит незавершённые → confirm `Found unfinished recording from {date}, recover?` → восстанавливает blob через `new Blob(chunks, {type: 'audio/webm'})`, выставляет `lastRecordingBlob`, показывает recovery box. Сессии старше 24ч удаляются тихо.

### Переименования и UI
- **Speaker rename**: клик по `.speaker-name` (внутри `.speaker-pill`) → inline-input → Enter сохраняет в `currentSpeakerNames[rawLabel]` → ре-рендер. Имена сохраняются в записи истории.
- **Transcript rename + auto-title + progressive UI**: над текстом отдельный заголовок (`#transcriptTitle`). После транскрипции `autoSuggestTitle()` мгновенно ставит placeholder из первых ~6 слов первого сегмента, флаг `currentTitleIsAuto = true`. Параллельно `requestLLMTitle()` устанавливает `titleIsGenerating = true` → в `renderTranscriptTitle()` рядом с placeholder появляется анимированный `✨ thinking…`. Когда LLM ответил → `currentTitle` обновляется, `titleIsGenerating = false`, ре-рендер. Если юзер кликнет на заголовок и переименует руками — `currentTitleIsAuto = false`, LLM-результат не перетирает его. `renderTranscriptTitle()` идемпотентен: всегда пересобирает блок с нуля через `innerHTML = ''` + новый span. `finish()` защищён флагом `done` против двойного срабатывания keydown+blur.
- **Inline edit транскрипта** — двойной клик на `.speaker-text` ИЛИ hover-кнопка `✎ edit`. Заменяется на textarea (auto-sized 2-8 строк по длине). Enter без Shift — save, Shift+Enter — перенос, Esc — отмена, blur — save. `seg.text` обновляется, добавляется флаг `seg.edited` → рендерится мелкая пометка `edited` рядом с таймингом. Space внутри textarea не триггерит shortcut (через stopPropagation + isTypingTarget в глобальном handler).

### Контент-секции
- **Notes section** (`#notesSection`) — textarea между транскриптом и AI-блоком. Видна не только когда есть транскрипт, но и **во время записи** + при наличии live-текста. `currentNotes` персистится в записи истории. При вводе — дебаунс 600ms перед сохранением.
- **AI tools section** (`#aiSection`) — рендерится только когда есть транскрипт. Кнопки `Summary` / `Action items` + dropdown с другими шаблонами (`sales_call`, `one_on_one`, `standup`). Результаты кешируются в `currentAIResults[template]` (и в записи истории через `entry.aiResults`), `__loading__` плейсхолдер пока идёт запрос. Каждая карточка результата имеет actions: `copy`, `regenerate`, `×` (remove).

### Поиск и фильтр
- **History search** — input над списком History. `filterHistory(history, query)` ищет по title / тексту любого сегмента / именам спикеров / дате / языку.
- **Search highlight + jump** — при клике на запись истории с активным search query → транскрипт открывается, совпадения подсвечены `<mark>`, страница скроллит к первому совпадению. Превью в самой плашке истории показывает фрагмент текста где найдено совпадение (~80 символов вокруг + ellipsis).

### Keyboard shortcuts
- Глобальный `keydown` handler с `isTypingTarget()` проверкой. `Space` → Start/Stop (только не в полях ввода), `Ctrl/Cmd+K` → open History + focus search, `Ctrl/Cmd+S` → download .md, `Ctrl/Cmd+D` → toggle theme, `/` → focus search, `Esc` → close modal или blur поля, `?` → modal со списком шорткатов. На macOS "Ctrl" в kbd-метках автоматически меняется на `⌘` (detected via `navigator.platform`).

### Feature flags (отложенные фичи)
- `FEATURE_CHAT = false` — Chat with transcript секция. Код функциональный, но скрыт. Включается одной правкой в начале JS.
- `FEATURE_TAGS = false` — Auto-tags. Endpoint `/api/tags` работает, UI чипов под заголовком + tag-фильтр в History — всё скрыто. Включается одной правкой.
- Соответствующие функции (`renderTags`, `requestLLMTags`, `renderTagFilters`) рано выходят если flag = false.

### Persistence
- **localStorage**: `transcriptor_settings` (lang + numSpeakers), `transcriptor_history` (segments + speakerNames + title + titleIsAuto + notes + aiResults + chatHistory + tags per entry, MAX 20), `theme`. Старые записи без новых полей не ломаются — все обращения через `entry.X || default`.
- **IndexedDB** (`transcriptor_recordings` → `sessions` store): для autosave чанков во время записи. Удаляется после успешной транскрипции.
- `prefers-reduced-motion` уважается, есть `prefers-color-scheme` fallback для первого визита.

## Non-obvious things future-Claude will trip on

- **Whisper и pyannote НЕЛЬЗЯ заменить на API-варианты в этом проекте.** Вся идея v2 — приватность через локальные модели. Если нужен API — это v1.

- **CUDA install — отдельно от requirements.txt.** PyTorch с CUDA ставится `pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu124` (или cu121). Если просто `pip install torch` — поставится CPU-версия и всё будет работать в 10 раз медленнее без ошибок. Незаметно но больно.

- **cuDNN-конфликт PyTorch vs CTranslate2 на Windows.** PyTorch 2.6+cu124 несёт cuDNN 9.1.0 в `torch/lib/`. CTranslate2 4.7+ (внутри faster-whisper) собран против cuDNN 9.2+ и требует символ `cudnnGetLibConfig` (добавлен в 9.2). Без фикса крэш `Could not load symbol cudnnGetLibConfig. Error code 127` при первой GPU-операции — Python падает целиком без traceback. **Фикс:** ставим `nvidia-cudnn-cu12` (9.22), переименовываем `torch/lib/cudnn*.dll` в `.bak`, копируем туда же DLL из `nvidia/cudnn/bin/`. Минорные версии cuDNN backward-compatible, торч этого не замечает. Подробности — в README.

- **torchcodec на Windows со static-ffmpeg не работает.** При импорте pyannote сыпет длинным warning'ом про libtorchcodec_core*.dll. Это безопасно потому что в `diarizer.py` мы НЕ передаём pyannote путь к файлу — мы сами читаем через `soundfile` и отдаём как dict с тензором. **Не пытаться "починить" torchcodec** установкой ffmpeg-shared — никакой выгоды, только новые проблемы.

- **pyannote 4.x API.** `Pipeline.from_pretrained(..., token=...)` (а не `use_auth_token`). Результат `pipeline()` — `DiarizeOutput` объект, диаризация внутри `.speaker_diarization` (Annotation). Старый код `result.itertracks(...)` упадёт.

- **ffmpeg в PATH обязателен** для `_webm_to_wav` (subprocess.run) и faster-whisper (внутри). Это системная зависимость, не Python.

- **`HF_TOKEN` обязателен.** Без него pyannote `from_pretrained` упадёт. И токен бесполезен пока не принять условия на ОБОИХ страницах: https://huggingface.co/pyannote/speaker-diarization-3.1 И https://huggingface.co/pyannote/speaker-diarization-community-1 (новая зависимость в 4.x).

- **Ollama должна быть запущена** (фоновый сервис, слушает `http://localhost:11434`). Дефолтная модель `qwen2.5:3b` (`OLLAMA_MODEL` env). Если Ollama не запущена — `/api/title` и `/api/generate` вернут 503/connection error, фронт молча оставит placeholder из эвристики или покажет error в карточке.

- **Модели держатся в памяти между запросами.** Первый вызов медленный (~10 сек загрузки), последующие быстрые. Не сбрасывать `_model` / `_pipeline` без причины.

- **VRAM 8 GB на RTX 3070** хватает с запасом для large-v3 + pyannote. Whisper large-v3 float16 ≈ 3 GB, pyannote ≈ 2 GB — суммарно ~5 GB, остаётся буфер. Если на другой машине упрётся — fallback на `WHISPER_MODEL=large-v3-turbo` (быстрее, чуть хуже) или `medium` (заметно хуже на UA/RU).

- **Whisper параметры подобраны под качество, не скорость.** `temperature` с fallback от 0 до 1.0, `best_of=5`, `beam_size=5`, `condition_on_previous_text=True`. На длинных созвонах это даёт ~2-3x slowdown vs дефолтов. Не убирать без причины.

- **Диаризация требует полное аудио целиком.** Метки спикеров между независимыми чанками не совпали бы. Не пытаться диаризовать chunk отдельно.

- **Async jobs vs Cloudflare 100s timeout.** Cloudflare Quick Tunnel убивает запросы дольше 100 секунд → HTML 524 страница. Длинные операции (transcribe, generate, chat) переведены на async с polling — каждый GET /api/jobs быстрый, никогда не упирается. **Не возвращать назад в sync для этих эндпоинтов.**

- **Silent audio (keep-alive) НЕ ОПЦИОНАЛЕН.** Без него Chrome дискардит вкладку через ~5 мин в фоне → MediaRecorder останавливается → запись теряется. Это эмпирически подтверждено фидбеком от пользователей.

- **`speakerName()` в JS** превращает "SPEAKER_00" → "Speaker 1" (zero-indexed → 1-indexed), но СНАЧАЛА проверяет `currentSpeakerNames[rawLabel]` — переопределения через UI-rename. pyannote всегда начинает с 00.

- **`CORS(app, resources={r"/api/*": {"origins": "*"}})`** — открыто всем для dev. В проде заменить на список доменов через ENV. Без CORS Vercel-фронт не сможет ходить на бэк.

- **`recordings/` ephemeral.** Файлы удаляются сразу после обработки (и для chunk, и для full). На сервере ничего не хранится — это часть приватности.

- **История в localStorage хранит `segments` целиком + всю мета** (не flat-текст). Это позволяет восстановить раскраску, переименования, AI-результаты, чат, теги при клике на запись истории. Не ломать формат без миграции.

- **Markdown экспорт** (`segmentsToMarkdown`) использует `currentTitle` как H1 заголовок (fallback "Call transcript") и как имя файла (через slug — оставляем буквы/цифры через unicode regex `\p{L}\p{N}`, остальное в дефисы, обрезаем до 60 символов). Также включает Notes (если есть) и все AI-результаты под отдельными секциями перед самим транскриптом.

- **OS Notifications API не показывает баннеры в Focus Mode / Do Not Disturb.** Уведомление создаётся (Notification object возвращается), но ОС его глушит. Console.log в `[notify] fired:` подтверждает что отправилось — если юзер не видит, проблема на стороне OS. Дать инструкции про Settings → Notifications → Chrome.

## Deployment

Сейчас: запускается локально, Cloudflare Tunnel для публичного доступа.

Дальнейший план — см. `ROADMAP.md`.

## Constraints

- Только NVIDIA GPU (CUDA). MPS на Mac не пробовал, ROCm не пробовал.
- Один пользователь за раз (Flask + одна модель в памяти). Многопользовательность — отдельная задача (multi-instance или queue).
- 8 GB VRAM минимум для large-v3 + pyannote одновременно.
- Web-only. Electron / native — на будущее, когда уйдут реальные проблемы с background-вкладками которые не закрыли keep-alive трюки.
