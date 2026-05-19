# Transcriptor v2

Локальная версия транскриптора созвонов с **разделением по спикерам** и **AI-фичами**. Запускается на ПК с NVIDIA GPU — аудио не уходит ни к OpenAI, ни в Cloudflare, ни на сторонние API.

**Стек:** faster-whisper (large-v3) + pyannote-3.1 (диаризация) + Ollama (qwen2.5:3b для LLM) + Flask + Cloudflare Tunnel.

---

## Возможности

- 🎙 **Запись через браузер** — mic + системный звук вкладки (Meet / Teams / Zoom), без установки приложений
- 📝 **Транскрипция** — Whisper large-v3 с параметрами под качество русско/украинской речи
- 👥 **Разделение по спикерам** — pyannote-3.1 с smoothing коротких реплик; можно переименовать «Speaker 1» → «Лиза»
- ⚡ **Live-текст** — во время записи каждые 3 минуты появляется текст (без спикеров); финальный с диаризацией приходит после «Стоп»
- ✨ **AI-инструменты** через локальную LLM: Summary, Action items, Sales call / 1-on-1 / Stand-up templates
- 🏷 **Авто-заголовок** — LLM генерирует название созвона по теме
- ✎ **Inline edit** — двойной клик по реплике → правишь текст
- 📝 **Notes** — заметки прямо во время созвона
- 💾 **Auto-save в IndexedDB** — если вкладка крашнется, можно восстановить
- 🔁 **Recovery** — если транскрипция упадёт, запись остаётся в браузере, есть Retry / Download
- 🔍 **Поиск по истории** — с подсветкой и переходом к фразе
- 🎨 **Light/Dark тема**, **keyboard shortcuts** (`?` чтобы посмотреть)
- 📦 **Export в Markdown** с заметками, AI-результатами, разметкой спикеров
- 🌐 **Cloudflare Tunnel** — публичный URL для шеринга с другими людьми, без хостинга

---

## Что отличается от v1

| | v1 | v2 |
|---|---|---|
| Whisper | OpenAI API | Локально (large-v3) |
| LLM (саммари и т.п.) | OpenAI API | Локально (qwen2.5:3b) |
| Диаризация | ❌ | ✅ pyannote-3.1 |
| Live-текст во время записи | ✅ | ✅ (через chunking) |
| Данные | Уходят к OpenAI | Всё на твоём ПК |
| Где работает | Railway (облако) | Твой ноут + Cloudflare Tunnel |
| Стоимость API | $0.006/мин | $0 |
| Скорость на 1ч аудио | ~30 сек | ~5-15 мин (RTX 3070) |
| Качество на UA/RU | хорошее | очень хорошее |
| AI-фичи (саммари, action items, chat) | ❌ | ✅ |

---

## Системные требования

- **NVIDIA GPU с 6+ GB VRAM** (RTX 3060 / 3070 / 4060 и выше). На 8 GB всё работает с запасом.
- **CUDA 12.1+** + свежие драйверы NVIDIA
- **ffmpeg** в PATH (для конвертации WebM → WAV под pyannote)
- **Python 3.10+**
- **~10 GB места** под модели (Whisper + pyannote + qwen2.5)

---

## Установка (Windows)

### 1. ffmpeg
```powershell
# Через winget:
winget install Gyan.FFmpeg

# Или через scoop:
scoop install ffmpeg
```

### 2. Ollama (LLM)
```powershell
winget install Ollama.Ollama
ollama pull qwen2.5:3b  # ~2 GB, дефолтная модель для саммари/чата
```

Ollama стартует как фоновый сервис автоматически.

### 3. HuggingFace токен (для pyannote)
1. Создать токен на https://huggingface.co/settings/tokens (тип Read)
2. Принять условия моделей:
   - https://huggingface.co/pyannote/speaker-diarization-3.1
   - https://huggingface.co/pyannote/speaker-diarization-community-1 (новая зависимость в pyannote 4.x)
3. Создать `.env`:
   ```powershell
   Copy-Item .env.example .env
   # отредактировать .env, вставить HF_TOKEN=hf_...
   ```

### 4. Python venv + зависимости
```powershell
python -m venv venv
.\venv\Scripts\Activate.ps1

# PyTorch с CUDA — ОТДЕЛЬНО с правильным index URL:
pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu124

# Остальное:
pip install -r requirements.txt
pip install nvidia-cudnn-cu12 nvidia-cublas-cu12
```

### 5. Проверить что CUDA видна
```powershell
python -c "import torch; print('CUDA:', torch.cuda.is_available()); print('GPU:', torch.cuda.get_device_name(0))"
```

Должно вывести `CUDA: True` и название GPU.

### 6. ⚠️ Фикс cuDNN-конфликта (обязательно для GPU)

PyTorch несёт cuDNN 9.1, а CTranslate2 (внутри faster-whisper) собран против cuDNN 9.2+ и требует функцию `cudnnGetLibConfig` которой в 9.1 нет. Без фикса крэш `Could not load symbol cudnnGetLibConfig. Error code 127` при первой GPU-операции, Python падает целиком.

Заменяем torch'овые DLL на из nvidia-cudnn-cu12:

```powershell
cd venv\Lib\site-packages\torch\lib
Get-ChildItem cudnn*.dll | ForEach-Object { Rename-Item $_.FullName -NewName ($_.Name + ".bak") }
Copy-Item ..\..\nvidia\cudnn\bin\cudnn*.dll .
cd ..\..\..\..\..
```

### 7. Первый запуск
```powershell
python app.py
```

Открыть http://localhost:5000. На первой транскрипции скачаются модели (~3 GB Whisper large-v3, ~1.5 GB pyannote-3.1), потом всё закешируется.

---

## Cloudflare Tunnel (публичный URL)

Чтобы дать ссылку другим людям без хостинга:

```powershell
winget install Cloudflare.cloudflared
cloudflared tunnel --url http://localhost:5000
```

Выдаст URL вида `https://xyz-abc.trycloudflare.com`. URL живёт пока `cloudflared` запущен. **Ноут должен быть включён** и Flask работать.

---

## Использование

1. Открыть URL (локальный или через tunnel)
2. Выбрать язык (можно auto-detect, но явно — лучше)
3. Опционально: указать число спикеров (улучшает диаризацию)
4. Нажать **«Start recording»** → разрешить микрофон → выбрать вкладку/экран и включить «Поделиться звуком»
5. Записать созвон — текст постепенно появляется по чанкам
6. **«Stop»** → ждать обработку (5-15 мин на 1 час аудио на RTX 3070)
7. Получить транскрипт с метками **Speaker 1, Speaker 2…** + автоматический заголовок
8. Опционально — сгенерить Summary / Action items / выбрать template
9. Скопировать или скачать как `.md`

**Подсказки:**
- Pin tab + отключить Memory Saver для сайта = записи не теряются в фоне
- `?` показывает все горячие клавиши
- Двойной клик по реплике — редактировать
- Клик на «Speaker 1» — переименовать

---

## Известные ограничения

- **Ноут должен быть включён** и Flask запущен пока сервис нужен
- **Закрытие крышки** = всё ложится (это OS, не браузер)
- **Первая запись после старта медленнее** — модели подгружаются в VRAM
- **На батарее** долгие записи могут страдать (есть warning при <40%)
- **Mobile carriers иногда блокируют QUIC** → Cloudflare Tunnel не доступен. Workaround: дать локальный IP в пределах WiFi

---

## Структура

```
app.py               — Flask, маршруты, CORS, job-queue, Ollama wrapper
transcriber.py       — faster-whisper, параметры под качество
diarizer.py          — pyannote-3.1, speaker turns
merger.py            — совмещение whisper + pyannote с smoothing
templates/index.html — UI (single-file, всё inline)
requirements.txt
.env.example
recordings/          — временные WebM (gitignored)
ROADMAP.md           — что в планах
CLAUDE.md            — техническая документация для Claude / future-devs
```

---

## Что дальше — см. [ROADMAP.md](./ROADMAP.md)
