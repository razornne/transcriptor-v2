# Transcriptor v2

Локальная версия транскриптора с **разделением по спикерам**. Запускается на ПК с NVIDIA GPU, данные не уходят в облако.

**Стек:** faster-whisper (локально) + pyannote-3.1 (диаризация) + Flask + Cloudflare Tunnel.

---

## Что отличается от v1

| | v1 | v2 |
|---|---|---|
| Whisper | OpenAI API | Локально (faster-whisper) |
| Диаризация | ❌ | ✅ pyannote-3.1 |
| Данные | Уходят к OpenAI | Всё на твоём ПК |
| Где работает | Railway (облако) | Твой ноут + Cloudflare Tunnel |
| Стоимость | $0.006/мин (API) | $0 (GPU твой) |
| Скорость на 1ч аудио | ~30 сек | ~3-6 мин (RTX 3070) |
| Live-текст во время записи | ✅ | ❌ (полная обработка после Стоп) |

---

## Системные требования

- **NVIDIA GPU с 6+ GB VRAM** (RTX 3060 / 3070 / 4060 и выше)
- **CUDA 12.1** + свежие драйверы NVIDIA
- **ffmpeg** в PATH (для конвертации WebM → WAV под pyannote)
- **Python 3.10+**
- **~10 GB места** под модели

---

## Установка (Windows)

### 1. ffmpeg
```powershell
# Через scoop:
scoop install ffmpeg

# Или скачать с https://www.gyan.dev/ffmpeg/builds/ и добавить в PATH
```

### 2. HuggingFace токен
1. Создать токен на https://huggingface.co/settings/tokens (тип Read)
2. Принять условия модели: https://huggingface.co/pyannote/speaker-diarization-3.1
3. Создать `.env` из шаблона:
   ```powershell
   Copy-Item .env.example .env
   # отредактировать .env, вставить токен
   ```

### 3. Python venv + зависимости
```powershell
python -m venv venv
.\venv\Scripts\Activate.ps1

# PyTorch с CUDA — ставить ОТДЕЛЬНО с правильным index URL:
pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu121

# Остальное:
pip install -r requirements.txt
```

### 4. Проверить что CUDA видна
```powershell
python -c "import torch; print('CUDA:', torch.cuda.is_available()); print('GPU:', torch.cuda.get_device_name(0))"
```

Должно вывести `CUDA: True` и название твоей GPU.

### 5. ⚠️ Фикс cuDNN-конфликта (обязательно для GPU)

PyTorch несёт свой cuDNN 9.1, а CTranslate2 (внутри faster-whisper) собран против cuDNN 9.2+ и требует функцию `cudnnGetLibConfig` которой в 9.1 нет. Без этого фикса будет крэш `Could not load symbol cudnnGetLibConfig. Error code 127`.

Ставим cuDNN 9.22 и заменяем им торчовый:

```powershell
pip install nvidia-cudnn-cu12 nvidia-cublas-cu12

# Бэкап старого cuDNN от PyTorch
cd venv\Lib\site-packages\torch\lib
Get-ChildItem cudnn*.dll | ForEach-Object { Rename-Item $_.FullName -NewName ($_.Name + ".bak") }

# Копируем новый
Copy-Item ..\..\nvidia\cudnn\bin\cudnn*.dll .
cd ..\..\..\..\..
```

### 6. Первый запуск
```powershell
python app.py
```

Открыть http://localhost:5000. При первом запуске Whisper и pyannote скачают модели (~3 GB суммарно), потом всё закешируется.

---

## Cloudflare Tunnel (чтобы давать ссылку другим)

```powershell
# Скачать cloudflared.exe с https://github.com/cloudflare/cloudflared/releases
cloudflared tunnel --url http://localhost:5000
```

Выдаст URL вида `https://xyz-abc.trycloudflare.com` — этот URL можно открывать с любого устройства, пока твой ноут включён и Flask работает.

---

## Использование

1. Открыть URL (локальный или через Cloudflare Tunnel)
2. Выбрать язык (если знаешь — лучше явно)
3. Опционально: указать число спикеров (улучшает диаризацию)
4. Нажать **«Начать запись»** → разрешить микрофон → выбрать вкладку/экран и включить «Поделиться звуком»
5. Провести созвон
6. **«Стоп»** → ждать обработку (30 сек – 3 мин)
7. Получить транскрипт с метками **Спикер 1, Спикер 2…**

Скопировать или скачать как `.md`.

---

## Известные ограничения

- **Ноут должен быть включён** и Flask запущен пока сервис нужен
- **Закрытие крышки или сон ПК** = сервис ложится
- **Первая запись после старта медленнее** — модели подгружаются в VRAM
- **Нет live-текста** во время записи — обработка идёт после «Стоп»

---

## Структура

```
app.py               — Flask, маршруты, CORS
transcriber.py       — faster-whisper, сегменты с таймингами
diarizer.py          — pyannote-3.1, спикер-турны
merger.py            — совмещение таймингов
templates/index.html — UI с отображением спикеров
recordings/          — временные WebM (gitignored)
```

---

## Когда переезжать на Vercel + VPS

Текущая схема (ноут + Cloudflare Tunnel) — для personal use или демо.

Для команды / агентства потом:
- Frontend → Vercel (статика, бесплатно)
- Backend → VPS с GPU (Hetzner GEX44, RunPod, или Modal/Replicate per-use)
- Auth + multi-user + БД для транскриптов
