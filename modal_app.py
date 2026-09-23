"""Modal app для transcriptor-v2.

Запускает тяжёлый ML-пайплайн на облачном GPU (A10G):
  - faster-whisper large-v3  — транскрипция
  - pyannote-3.1             — диаризация (кто говорит когда)
  - aya-expanse-8b           — LLM: title, summary, action items, correction

Flask остаётся тонким прокси: принимает аудио → шлёт в Modal → polling.

Деплой:
    modal deploy modal_app.py

Первый запуск контейнера (~60-90 сек):
    скачает модели в Volume (~12 GB суммарно), дальше грузит из кэша.

Переменные окружения (Modal Secrets → "transcriptor-secrets"):
    HF_TOKEN   — для pyannote/speaker-diarization-3.1 (принять условия на HF)
    HF_TOKEN нужен и для aya-expanse-8b (Cohere требует логин)
"""

import re
import subprocess
import tempfile
import os
import time

import modal

# ── App + infrastructure ─────────────────────────────────────────

app = modal.App("transcriptor-v2")

# Shared Dict для real-time прогресса транскрипции.
# transcribe_full пишет сюда по мере прохождения этапов;
# flask_app читает при polling и включает в ответ фронту.
progress_store = modal.Dict.from_name("transcription-progress", create_if_missing=True)


class _PipelineProgress:
    """Честный трекер стадий пайплайна для real-time UI-мониторинга.

    Пишет в progress_store[progress_key] структуру:
      {
        "pipeline_steps": {
          "container":     {"status": "completed", "duration_sec": 4.0},
          "audio_split":   {"status": "completed", "duration_sec": 2.1},
          "transcription": {"status": "running",   "started_ts": 1718.., "elapsed_sec": 0},
          "diarization":   {"status": "pending"},
          "ai_formatting": {"status": "pending"},
        },
        "stage": "<имя текущего шага>",   # legacy back-compat
        "chunks_total"?: N, "chunks_done"?: K, "chunks_failed"?: F,
        "ts": <epoch>,
      }

    Каждый шаг проходит pending → running → completed. duration_sec фиксируется
    честно по реальному времени между start() и done(). started_ts даёт Flask'у
    считать живой elapsed на каждом polling'е (часы контейнеров Modal NTP-синхр.).

    Best-effort: любая ошибка записи проглатывается — мониторинг НИКОГДА не
    должен валить транскрипцию.
    """
    STEPS = ("container", "audio_split", "transcription", "diarization", "ai_formatting")

    def __init__(self, progress_key, container_sec: float = 0.0):
        self.key = progress_key
        self.steps = {s: {"status": "pending"} for s in self.STEPS}
        self._t: dict = {}
        self.extra: dict = {}
        # Контейнер уже готов к моменту, когда метод реально исполняется —
        # фиксируем его как completed с измеренным временем cold start (или ~0 на тёплом).
        self.steps["container"] = {"status": "completed", "duration_sec": round(max(0.0, container_sec), 1)}
        self._flush("container")

    def start(self, step: str, **extra):
        self._t[step] = time.time()
        self.steps[step] = {"status": "running", "started_ts": self._t[step], "elapsed_sec": 0}
        if extra:
            self.extra.update(extra)
        self._flush(step)

    def update(self, step: str, **extra):
        """Освежает live-метрики бегущего шага (напр. chunks_done) без смены статуса."""
        st = self.steps.get(step)
        if st and st.get("status") == "running":
            st["elapsed_sec"] = round(time.time() - self._t.get(step, time.time()), 1)
        if extra:
            self.extra.update(extra)
        self._flush(step)

    def done(self, step: str, **extra):
        dur = time.time() - self._t.get(step, time.time())
        self.steps[step] = {"status": "completed", "duration_sec": round(max(0.0, dur), 1)}
        if extra:
            self.extra.update(extra)
        self._flush(step)

    def fail(self, step: str, **extra):
        """Помечает текущий шаг как упавший (UI покажет красным), не валит джобу."""
        dur = time.time() - self._t.get(step, time.time())
        self.steps[step] = {"status": "failed", "duration_sec": round(max(0.0, dur), 1)}
        if extra:
            self.extra.update(extra)
        self._flush(step)

    def _flush(self, stage: str):
        if not self.key:
            return
        try:
            progress_store[self.key] = {
                "pipeline_steps": {k: dict(v) for k, v in self.steps.items()},
                "stage": stage,
                "ts": time.time(),
                **self.extra,
            }
        except Exception as e:
            print(f"[progress] flush failed: {e}", flush=True)

# Persistent Volume — модели кэшируются между запусками.
# Первый запуск скачает всё (~12 GB), последующие грузят за секунды.
volume = modal.Volume.from_name("transcriptor-models", create_if_missing=True)
MODELS_DIR = "/models"

# Modal Secret с HF_TOKEN (создать: modal secret create transcriptor-secrets HF_TOKEN=hf_...)
hf_secret = modal.Secret.from_name("transcriptor-secrets")
# Separate secret for Notion integration so we don't have to --force the
# main secret every time we add an OAuth integration. Optional — if missing,
# Notion endpoints return 503 'not configured'.
notion_secret = modal.Secret.from_name("notion-secrets", required_keys=[
    "NOTION_OAUTH_CLIENT_ID", "NOTION_OAUTH_CLIENT_SECRET",
])
# Telegram bot creds for admin signup notifications. Same pattern as
# notion-secrets — isolated so the main transcriptor-secrets is never
# touched when we add operational integrations.
admin_secret = modal.Secret.from_name("admin-secrets", required_keys=[
    "TELEGRAM_BOT_TOKEN", "TELEGRAM_ADMIN_CHAT_ID",
])
# Cloudflare R2 (S3 API) — архив аудио всех записей для работы над ошибками.
r2_secret = modal.Secret.from_name("r2-secrets", required_keys=[
    "R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET",
])
# Stripe live-mode credentials. Kept separate from transcriptor-secrets so we
# can rotate keys without --force-replacing the whole core secret.
stripe_secret = modal.Secret.from_name("stripe-secrets", required_keys=[
    "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET",
    "STRIPE_PRO_MONTHLY_PRICE", "STRIPE_PRO_ANNUAL_PRICE",
    "STRIPE_MAX_MONTHLY_PRICE", "STRIPE_MAX_ANNUAL_PRICE",
    "STRIPE_TEAM_MONTHLY_PRICE", "STRIPE_TEAM_ANNUAL_PRICE",
])

# Образ контейнера — собирается один раз, кэшируется Modal'ом.
# Используем CUDA 12.4 base image чтобы libcublas.so.12 и libcudnn были
# доступны системно — без этого torch/ctranslate2 падают с "library not found".
image = (
    modal.Image.from_registry(
        "nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04",
        add_python="3.11",
    )
    .apt_install("ffmpeg", "build-essential")  # build-essential: C compiler for Triton JIT (gpt-oss MoE)
    .pip_install(
        # Whisper
        "faster-whisper==1.1.1",
        # Pyannote (4.x API: result.speaker_diarization)
        "pyannote.audio",
        "soundfile",
        # Torch — ставим явно cu124 чтобы совпало с base image
        "torch",
        "torchaudio",
        # LLM (transformers + 4-bit quantization)
        # >=4.55 for gpt-oss harmony chat template + native MXFP4 quantization
        "transformers>=4.55.0",
        "accelerate",
        "bitsandbytes",
        "huggingface_hub",
        # MXFP4 kernels for gpt-oss native 4-bit (otherwise dequantizes to bf16
        # which means 40GB instead of 12GB — wastes VRAM, slower)
        "kernels>=0.12.0",
        # Utils
        "numpy",
        "requests",
    )
    # Локальные модули с чистой Python-логикой без GPU-deps
    .add_local_python_source("merger", "channels")
)

# Отдельный лёгкий image для Flask-обёртки (без torch/CUDA) — экономит cold start.
# Flask тут ничего не считает, только шлёт .spawn() в основной Transcriptor.
web_image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install(
        "flask",
        "flask-cors",
        "python-dotenv",
        "requests",
        "pyjwt[crypto]",  # для валидации Supabase JWT (включая asymmetric ES256/RS256)
        "stripe",
        "boto3",  # S3 API клиента для архива записей в Cloudflare R2
    )
    .add_local_python_source("app")
    # Cutover (2026-06-14): фронт переехал на Next.js /app, GET / теперь 301-редирект.
    # templates/index.html заархивирован в legacy/ — Flask его больше не рендерит,
    # поэтому каталог templates/ не монтируется (его и нет в корне).
)

# Лёгкий CPU образ для оркестратора длинных записей (transcribe_long).
# Режет аудио (ffmpeg), фанит GPU-воркеров transcribe_chunk, глобально
# кластеризует спикеров (собственная constrained-агломеративка на numpy,
# sklearn больше не нужен) и сшивает. Без torch/CUDA — дёшево,
# почти всё время ждёт GPU-воркеров (I/O bound).
orchestrator_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg")
    .pip_install(
        "soundfile",
        "numpy",
    )
    .add_local_python_source("merger", "channels")
)

# Длина чанка для длинных записей (сек). 1200 = 20 мин — базовая цель;
# реальная длина растягивается _plan_chunk_boundaries так, чтобы все чанки
# влезли в одну параллельную волну (см. MAX_PARALLEL_CHUNKS).
CHUNK_LEN_S = int(os.environ.get("CHUNK_LEN_S", "1200"))
# Лимит параллельных GPU-контейнеров на аккаунте Modal. Чанков больше этого
# числа — вторая волна и ~2x wall-clock. Поэтому планировщик чанков целится
# в ≤ MAX_PARALLEL_CHUNKS чанков, удлиняя каждый (та же суммарная GPU-минута,
# сжатый wall-clock).
MAX_PARALLEL_CHUNKS = int(os.environ.get("MAX_PARALLEL_CHUNKS", "10"))
# Жёсткий кап длины одного чанка: 1800с аудио обрабатывается за ~10-15 мин
# даже на best-quality — укладывается в таймаут Transcriptor (2400с) с запасом.
MAX_CHUNK_LEN_S = int(os.environ.get("MAX_CHUNK_LEN_S", "1800"))
# Нахлёст чанков (сек с каждой стороны). Резы идут по тишине, но при жёстком
# фоллбэке (тишины рядом нет) слово рвалось пополам, и Whisper терял контекст
# на границе. Пад даёт дослушать фразу через шов; дедуп — в transcribe_chunk
# по midpoint Whisper-сегмента в core-диапазон (_trim_to_core), поэтому один
# и тот же кусок речи в финальный транскрипт попадает ровно один раз.
CHUNK_PAD_S = float(os.environ.get("CHUNK_PAD_S", "3.0"))


def _trim_to_core(segments: list[dict], lead_s: float, core_len_s: float,
                  is_last: bool) -> list[dict]:
    """Отбрасывает Whisper-сегменты из пад-зон чанка (ISS-13/стыки).

    Сегмент принадлежит чанку, если СЕРЕДИНА сегмента лежит в core-диапазоне
    [lead_s, lead_s + core_len_s). Соседние чанки покрывают пады друг друга,
    midpoint-правило разбивает речь на шве детерминированно: один и тот же
    сегмент (одна середина) остаётся ровно в одном чанке. Для последнего
    чанка правая граница открыта (хвост записи).

    Вызывается ДО merge со спикер-турнами — на мелких Whisper-сегментах
    (≤30с), пока спикер-блоки не склеились в многоминутные.
    """
    out = []
    for seg in segments:
        mid = (float(seg["start"]) + float(seg["end"])) / 2.0
        if mid < lead_s:
            continue
        if not is_last and mid >= lead_s + core_len_s:
            continue
        out.append(seg)
    return out


# Предобработка перед Whisper. lowpass 12kHz, не 8kHz: 8kHz срезал согласные
# в английских терминах ("pitch deck" → "page-теку").
_PREPROC_AF = ("highpass=f=80,lowpass=f=12000,anlmdn,loudnorm=I=-16:TP=-1.5:LRA=11,"
               "acompressor=threshold=-20dB:ratio=4:attack=5:release=50")


def _merge_same_speaker(segments: list[dict]) -> list[dict]:
    """Склеивает соседние сегменты одного спикера (после boundary-fix Gemini)."""
    out: list[dict] = []
    for seg in segments:
        if out and out[-1]["speaker"] == seg["speaker"]:
            out[-1]["end"] = seg["end"]
            out[-1]["text"] += " " + seg["text"]
        else:
            out.append(dict(seg))
    return out


def _tmp_path(suffix: str) -> str:
    fd, path = tempfile.mkstemp(suffix=suffix)
    os.close(fd)
    return path


def _prepare_audio(src_path: str) -> tuple[str, list[str]]:
    """Декод + предобработка в 16k mono WAV. Возвращает (mode, wav_paths):
      'dual'                    → [mic_wav, call_wav] — каналы веб-рекордера по отдельности
      'left_only'/'right_only'  → [wav] — звучит только один канал, берём его
      'mono'                    → [wav] — даунмикс как раньше (моно-файл или dual-mono)
    Удалять файлы — забота вызывающего.
    """
    import soundfile as sf
    from channels import ChannelStats

    def extract(pan: str | None) -> str:
        out = _tmp_path(".wav")
        af = f"{pan},{_PREPROC_AF}" if pan else _PREPROC_AF
        subprocess.run(["ffmpeg", "-y", "-i", src_path, "-af", af, "-ar", "16000", "-ac", "1", out],
                       check=True, capture_output=True)
        return out

    stereo = _tmp_path(".wav")
    try:
        subprocess.run(["ffmpeg", "-y", "-i", src_path, "-ar", "16000", "-ac", "2", stereo],
                       check=True, capture_output=True)
        stats = ChannelStats()
        for block in sf.blocks(stereo, blocksize=16000 * 30, dtype="float32", always_2d=True):
            stats.feed(block[:, 0], block[:, 1])
        mode = stats.verdict()
        print(f"[audio] channels={mode} corr={stats.correlation():.2f} "
              f"active_l={stats.active_l}/{stats.frames} active_r={stats.active_r}/{stats.frames}", flush=True)
    finally:
        try:
            os.remove(stereo)
        except OSError:
            pass

    if mode == "dual":
        return mode, [extract("pan=mono|c0=c0"), extract("pan=mono|c0=c1")]
    if mode == "left_only":
        return mode, [extract("pan=mono|c0=c0")]
    if mode == "right_only":
        return mode, [extract("pan=mono|c0=c1")]
    return mode, [extract(None)]


# Порог cosine-расстояния для глобальной кластеризации спикеров между чанками.
# Точка EER wespeaker-эмбеддингов (граница "тот же/другой спикер") ~0.5 distance.
# Меньше → больше спикеров (дробит, дубли на швах), больше → меньше (сливает).
# История: 0.7 склеивал похожие голоса на звонках 1-на-1 → опустили до 0.55 →
# полезли ДУБЛИ одного человека на швах чанков (ISS-8). Теперь кластеризация
# работает с cannot-link констрейнтом (спикеры одного чанка не сливаются —
# pyannote их уже разделил в общем контексте), который структурно блокирует
# старый фейл со склейкой, поэтому порог можно держать выше — 0.68 лечит швы.
# Используется только если num_speakers не задан. Тюнится через env.
GLOBAL_SPK_THRESHOLD = float(os.environ.get("GLOBAL_SPK_THRESHOLD", "0.68"))
# Escape-порог для cannot-link: если два локальных спикера ОДНОГО чанка
# оказались на cosine-расстоянии меньше этого — это НЕ два разных человека,
# а pyannote over-сегментировал одного голоса на два (фантом). Такие пары
# сливаются ДАЖЕ внутри чанка. Иначе (regression из MYK-12, auto-режим без
# num_speakers, где force-merge фаза не работает) каждая внутричанковая
# over-сегментация навсегда оставалась отдельным глобальным спикером —
# 2-спикерный звонок выдавал 5 «спикеров». 0.40 ниже EER (~0.5): реально
# разные (пусть похожие) голоса (~0.5+) cannot-link держит раздельно, а
# фантом одного голоса (типично 0.15-0.35) сливается обратно.
GLOBAL_SPK_PHANTOM_DIST = float(os.environ.get("GLOBAL_SPK_PHANTOM_DIST", "0.40"))
# Сколько embedding'ов на локального спикера передаёт transcribe_chunk
# оркестратору. Несколько векторов (вместо одного центроида) делают
# average-linkage устойчивее к шумным сегментам (overlap, телефонное сжатие).
EMB_PER_SPEAKER = int(os.environ.get("EMB_PER_SPEAKER", "6"))

# Language prompts — зеркало из transcriber.py
_LANG_PROMPTS: dict[str, str] = {
    "ru": (
        "Запись деловой беседы или интервью на русском языке. "
        "— Добрый день, рад вас видеть. — Взаимно, давайте обсудим. "
        "Обсуждаем бизнес, маркетинг, YouTube, медиа, технологии, стартапы."
    ),
    "uk": (
        "Запис ділової розмови або інтерв'ю українською мовою. "
        "— Добрий день, радий вас бачити. — Взаємно, давайте обговоримо. "
        "Обговорюємо бізнес, маркетинг, YouTube, медіа, технології, стартапи."
    ),
    "en": (
        "Recording of a business conversation or interview in English. "
        "— Good morning, great to meet you. — Likewise, let's get started. "
        "Topics: business, marketing, YouTube, media, technology, startups."
    ),
    "pl": (
        "Nagranie rozmowy biznesowej, wykładu lub warsztatu w języku polskim. "
        "— Dzień dobry, miło mi państwa widzieć. — Również, zaczynajmy. "
        "Tematy: biznes, marketing, technologia, sztuczna inteligencja, startupy, edukacja."
    ),
    "cs": (
        "Nahrávka pracovního hovoru, schůzky nebo rozhovoru v češtině. "
        "— Dobrý den, rád vás vidím. — Také, pojďme začít. "
        "Témata: byznys, marketing, technologie, umělá inteligence, startupy, vzdělávání."
    ),
}

_CORRECTION_INSTRUCTIONS: dict[str, str] = {
    "ru": (
        "Исправь ТОЛЬКО очевидные фонетические ошибки распознавания речи (STT). "
        "НЕ меняй смысл, стиль, порядок слов, пунктуацию, регистр. "
        "НЕ добавляй и НЕ удаляй слова. Язык оставляй русским. "
        "Если не уверен — оставь как есть."
    ),
    "uk": (
        "Виправ ЛИШЕ очевидні фонетичні помилки розпізнавання мовлення (STT). "
        "НЕ змінюй зміст, стиль, порядок слів, пунктуацію, регістр. "
        "НЕ додавай і НЕ видаляй слова. Мова залишається українською. "
        "Суржик і свідомі російські слова мовця ('сделать', 'апрель') — це "
        "нормальне живе мовлення, залишай їх БЕЗ змін; НЕ перекладай їх "
        "українською. Виправляй лише безглузді фонетичні артефакти. "
        "Якщо не впевнений — залиш як є."
    ),
    "en": (
        "Fix ONLY obvious phonetic speech-to-text (STT) errors. "
        "Do NOT change meaning, style, word order, punctuation, or capitalization. "
        "Do NOT add or remove words. If unsure, leave as is."
    ),
    "pl": (
        "Popraw TYLKO oczywiste fonetyczne błędy rozpoznawania mowy (STT). "
        "NIE zmieniaj sensu, stylu, szyku wyrazów, interpunkcji ani wielkości liter. "
        "NIE dodawaj i NIE usuwaj słów. Język pozostaw polski. "
        "Jeśli nie masz pewności — zostaw bez zmian."
    ),
    "cs": (
        "Oprav POUZE zjevné fonetické chyby rozpoznávání řeči (STT). "
        "NEMĚŇ smysl, styl, slovosled, interpunkci ani velikost písmen. "
        "NEPŘIDÁVEJ a NEODSTRAŇUJ slova. Jazyk ponech český, včetně diakritiky. "
        "Anglické termíny, které mluvčí skutečně použil, ponech. "
        "Pokud si nejsi jistý, ponech beze změny."
    ),
}

# Анти-галлюцинация Whisper: при подозрении на галлюцинацию (по таймстемпам
# слов) пропускать тихие участки длиннее порога (сек). Требует
# word_timestamps=True (у нас включён). Лечит мультиязычную кашу на сильно
# повторяющемся контенте — Whisper зацикливается и начинает выдумывать (ISS-9).
HALLUCINATION_SILENCE_S = float(os.environ.get("HALLUCINATION_SILENCE_S", "2.0"))

# Gemini correction model. Flash дешёвый и быстрый — дефолт для всех.
# Pro даёт лучшее качество на длинных контекстах — можно включать для Max
# юзеров (override через env CORRECTION_MODEL=gemini-2.5-pro).
GEMINI_CORRECTION_MODEL = os.environ.get("CORRECTION_MODEL", "gemini-2.5-flash")


# ── Main class ───────────────────────────────────────────────────

@app.cls(
    gpu="A10G",           # 24 GB VRAM: whisper(3) + pyannote(2) + aya-8b-4bit(5) ≈ 10 GB
    image=image,
    volumes={MODELS_DIR: volume},
    secrets=[hf_secret],
    timeout=2400,                 # 40 мин макс: монолит до 30 мин аудио + запас
                                  # на best-quality (large-v3 ~3x медленнее turbo)
                                  # и на удлинённые чанки long-пайплайна
    scaledown_window=150,         # было 300: после длинной джобы 10 GPU-контейнеров
                                  # висели тёплыми по 5 мин = ~50 GPU-мин idle-хвоста
                                  # (~30% стоимости 4ч джобы). 150с хватает для
                                  # follow-up run_llm (title стартует сразу после
                                  # транскрипции) и повторной записи подряд
    retries=modal.Retries(max_retries=2, backoff_coefficient=1),  # retry on code-level exceptions
)
class Transcriptor:

    @modal.enter()
    def load_models(self):
        """Загружается один раз при старте контейнера."""
        import torch
        from faster_whisper import WhisperModel
        from pyannote.audio import Pipeline
        from transformers import AutoTokenizer, AutoModelForCausalLM, BitsAndBytesConfig

        # Замер cold start (загрузка моделей) — honest «container» step в UI.
        # _served=0 → первый запрос на этом контейнере платит за boot; тёплые
        # переиспользования показывают container ~0с.
        _boot0 = time.time()
        self._served = 0

        hf_token = os.environ["HF_TOKEN"]

        # large-v3-turbo — дефолт: ~3-4x быстрее large-v3, чуть слабее на UA/RU
        whisper_fast_model = os.environ.get("WHISPER_MODEL", "large-v3-turbo")
        print(f"[modal] loading whisper {whisper_fast_model} (fast)...", flush=True)
        self.whisper = WhisperModel(
            whisper_fast_model,
            device="cuda",
            compute_type="float16",
            download_root=f"{MODELS_DIR}/whisper",
        )
        print("[modal] whisper fast ready", flush=True)

        # large-v3 — для Max плана ("Best Quality" toggle). Грузим только если
        # отличается от fast и LOAD_BEST_QUALITY=true. На A10G 24GB обе модели
        # вместе с pyannote и Qwen-4bit влезают (~13GB total).
        whisper_best_model = os.environ.get("WHISPER_BEST_MODEL", "large-v3")
        self.whisper_best = None
        if whisper_best_model != whisper_fast_model and os.environ.get("LOAD_BEST_QUALITY", "true").lower() == "true":
            print(f"[modal] loading whisper {whisper_best_model} (best)...", flush=True)
            try:
                self.whisper_best = WhisperModel(
                    whisper_best_model,
                    device="cuda",
                    compute_type="float16",
                    download_root=f"{MODELS_DIR}/whisper",
                )
                print("[modal] whisper best ready", flush=True)
            except Exception as e:
                print(f"[modal] whisper best failed to load: {e} — falling back to fast for all requests", flush=True)
                self.whisper_best = None

        print("[modal] loading pyannote/speaker-diarization-3.1...", flush=True)
        self.pyannote = Pipeline.from_pretrained(
            "pyannote/speaker-diarization-3.1",
            token=hf_token,
            cache_dir=f"{MODELS_DIR}/pyannote",
        )
        self.pyannote.to(torch.device("cuda"))
        print("[modal] pyannote ready", flush=True)

        # Speaker embedding model — для глобального сшивания спикеров между
        # чанками в transcribe_long. Это та же wespeaker-модель, которую
        # diarization-пайплайн уже тянет внутри (никакого нового HF-гейтинга).
        # Грузим отдельно как Inference(window="whole") чтобы считать
        # centroid каждого локального спикера по его сегментам.
        # Версионно-независимо — не полагаемся на нестабильный return_embeddings.
        self.embedding_inference = None
        try:
            from pyannote.audio import Model, Inference
            emb_name = os.environ.get(
                "EMBEDDING_MODEL", "pyannote/wespeaker-voxceleb-resnet34-LM"
            )
            print(f"[modal] loading embedding model {emb_name}...", flush=True)
            # cache_dir на Volume (тот же что у pyannote-пайплайна) — иначе
            # каждый cold start перекачивает модель. Критично т.к. long-pipeline
            # поднимает до 12 параллельных холодных контейнеров.
            emb_model = Model.from_pretrained(
                emb_name, token=hf_token, cache_dir=f"{MODELS_DIR}/pyannote",
            )
            self.embedding_inference = Inference(emb_model, window="whole")
            self.embedding_inference.to(torch.device("cuda"))
            print("[modal] embedding model ready", flush=True)
        except Exception as e:
            print(f"[modal] embedding model failed to load: {e} "
                  "— long-recording speaker stitching will degrade", flush=True)
            self.embedding_inference = None

        # Qwen2.5-7B-Instruct в 4-bit (~4 GB VRAM). Не гейтована, сильна на UA/RU/EN.
        # Альтернатива: Qwen/Qwen2.5-14B-Instruct (лучше, но ~8 GB VRAM)
        llm_model = os.environ.get("LLM_MODEL", "Qwen/Qwen2.5-7B-Instruct")
        print(f"[modal] loading {llm_model}...", flush=True)
        bnb_config = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_compute_dtype=torch.float16,
            bnb_4bit_quant_type="nf4",
        )
        self.llm_tokenizer = AutoTokenizer.from_pretrained(
            llm_model,
            cache_dir=f"{MODELS_DIR}/llm",
            token=hf_token,
        )
        self.llm_model = AutoModelForCausalLM.from_pretrained(
            llm_model,
            quantization_config=bnb_config,
            device_map="cuda",
            cache_dir=f"{MODELS_DIR}/llm",
            token=hf_token,
        )
        self.llm_model.eval()
        print(f"[modal] {llm_model} ready", flush=True)

        self._boot_secs = time.time() - _boot0
        print(f"[modal] container ready in {self._boot_secs:.1f}s", flush=True)

    # ── Transcription ────────────────────────────────────────────

    @modal.method()
    def transcribe_full(
        self,
        audio_bytes: bytes,
        language: str | None,
        num_speakers: int | None,
        prompt: str | None,
        progress_key: str | None = None,
        quality: str = "fast",
        privacy_mode: bool = False,
        correction_hints: str = "",
    ) -> dict:
        """Полный пайплайн: webm → whisper → pyannote → merge → LLM correction.

        privacy_mode=True forces correction through the local Qwen 7B path
        (no Gemini API call). Set by Privacy Mode users on Max/Team plans.

        Принимает сырой WebM/Opus blob, конвертирует через ffmpeg внутри.
        Возвращает dict:
          { "segments": [{speaker, start, end, text}, ...],
            "vocab_additions": [term1, term2, ...] }

        progress_key: если задан, пишем честные стадии (pipeline_steps) в
        modal.Dict progress_store через _PipelineProgress — фронт видит реальный
        прогресс с таймингами. Шаги: container → audio_split → transcription →
        diarization → ai_formatting (pending → running → completed).

        quality: "fast" (large-v3-turbo, default) | "best" (large-v3).
        Best качество доступно только для Max-юзеров (проверяется в Flask).
        """
        from merger import merge

        # Honest pipeline monitoring: container (cold start) уже позади — фиксируем
        # его реальную длительность на первом запросе контейнера, далее ~0 на тёплом.
        container_sec = getattr(self, "_boot_secs", 0.0) if getattr(self, "_served", 0) == 0 else 0.0
        self._served = getattr(self, "_served", 0) + 1
        pp = _PipelineProgress(progress_key, container_sec=container_sec)

        src_path = _tmp_path(".webm")
        wavs: list[str] = []
        try:
            with open(src_path, "wb") as f:
                f.write(audio_bytes)

            pp.start("audio_split")
            mode, wavs = _prepare_audio(src_path)
            pp.done("audio_split")  # decode + channel split + preprocessing done

            pp.start("transcription")
            tracks = [self._run_whisper(w, language, prompt, quality) for w in wavs]
            pp.done("transcription")
            if not any(tracks):
                return {"segments": [], "vocab_additions": []}

            pp.start("diarization")
            if mode == "dual":
                merged = self._label_dual(tracks[0], tracks[1], wavs[1], num_speakers)
            else:
                segments = tracks[0]
                if num_speakers:
                    # Юзер задал точное число — constrained clustering, качество резко лучше.
                    diar_kwargs = {"num_speakers": num_speakers}
                else:
                    # Bounds 1..6: pyannote не дробит одного спикера и не сливает двух.
                    diar_kwargs = {"min_speakers": 1, "max_speakers": 6}
                _, speaker_turns = self._diarize(wavs[0], **diar_kwargs)
                # При точном num_speakers порог сглаживания 1.0s → 0.4s: короткие
                # реплики миноритарного спикера ("Так", "Добре", <0.8s) не поглощаются.
                smooth_th = 0.4 if num_speakers else None
                merged = merge(segments, speaker_turns, smooth_threshold=smooth_th)
            for m in merged:
                m["start"]   = float(m["start"])
                m["end"]     = float(m["end"])
                m["speaker"] = str(m["speaker"])
            pp.done("diarization")

            # --- LLM correction ---
            pp.start("ai_formatting")
            merged, vocab_additions, corrections = self._correct_segments(
                merged, language, privacy_mode=privacy_mode, correction_hints=correction_hints,
                speakers_fixed=(mode == "dual"),
            )
            merged = _merge_same_speaker(merged)  # boundary-fix мог сделать соседей одного спикера
            pp.done("ai_formatting")

            return {"segments": merged, "vocab_additions": vocab_additions, "channel_mode": mode,
                    "corrections": corrections}

        finally:
            for p in [src_path, *wavs]:
                try:
                    os.remove(p)
                except OSError:
                    pass

    def _run_whisper(self, wav_path: str, language: str | None, prompt: str | None,
                     quality: str) -> list[dict]:
        """Whisper по одному 16k mono WAV → [{start, end, text, words}] (нативные float)."""
        lang_hint = _LANG_PROMPTS.get(language or "")
        effective_prompt = f"{lang_hint} {prompt}" if (lang_hint and prompt) else (lang_hint or prompt)

        # Best quality — large-v3 (~3x медленнее, заметно точнее вне ru/uk/en)
        whisper_model = self.whisper_best if (quality == "best" and getattr(self, "whisper_best", None)) else self.whisper
        segments_iter, _ = whisper_model.transcribe(
            wav_path,
            language=language,
            initial_prompt=effective_prompt,
            beam_size=3,
            best_of=3,
            temperature=(0.0, 0.2, 0.4, 0.6, 0.8, 1.0),
            compression_ratio_threshold=2.4,
            log_prob_threshold=-1.0,
            no_speech_threshold=0.6,
            hallucination_silence_threshold=HALLUCINATION_SILENCE_S,
            condition_on_previous_text=True,
            vad_filter=True,
            vad_parameters={
                "threshold": 0.45,
                "min_silence_duration_ms": 500,
                "speech_pad_ms": 200,
            },
            word_timestamps=True,  # для word-level alignment в merger и фильтра эха
        )
        # Нативные Python типы: faster-whisper отдаёт numpy.float32, а Flask-контейнер
        # без numpy падает на десериализации ("'numpy' is not available").
        return [
            {
                "start": float(s.start),
                "end":   float(s.end),
                "text":  s.text.strip(),
                "words": [
                    {"start": float(w.start), "end": float(w.end), "word": w.word}
                    for w in (s.words or [])
                ],
            }
            for s in segments_iter
            if s.text.strip()
        ]

    def _diarize(self, wav_path: str, **kwargs):
        """pyannote по WAV → (annotation, [{start, end, speaker}])."""
        import numpy as np
        import soundfile as sf
        import torch

        waveform, sample_rate = sf.read(wav_path, dtype="float32", always_2d=True)
        audio_input = {
            "waveform": torch.from_numpy(np.ascontiguousarray(waveform.T)),  # (channels, time)
            "sample_rate": sample_rate,
        }
        annotation = self.pyannote(audio_input, **kwargs).speaker_diarization
        turns = [
            {"start": float(turn.start), "end": float(turn.end), "speaker": str(speaker)}
            for turn, _, speaker in annotation.itertracks(yield_label=True)
        ]
        return annotation, turns

    def _label_dual(self, mic_segs: list[dict], call_segs: list[dict], call_wav: str,
                    num_speakers: int | None) -> list[dict]:
        """Двухканальная запись → один размеченный транскрипт.

        SPEAKER_00 — владелец микрофона (известен по каналу). Канал звонка
        диаризуется только если собеседников может быть больше одного
        (num_speakers не задан или > 2). num_speakers == 1 (Free, без
        диаризации) — всё одним спикером, но каналы всё равно распознаны
        раздельно (одновременная речь не теряется).
        """
        from channels import drop_echo, interleave, label, relabel, split_on_pauses
        from merger import merge

        mic_segs, call_segs = split_on_pauses(mic_segs), split_on_pauses(call_segs)
        mic_segs = drop_echo(mic_segs, call_segs)
        if num_speakers == 1:
            return interleave(label(mic_segs, "SPEAKER_00"), label(call_segs, "SPEAKER_00"))

        call_n = num_speakers - 1 if num_speakers else None
        if not call_segs or call_n == 1:
            call = label(call_segs, "SPEAKER_01")
        else:
            kwargs = {"num_speakers": call_n} if call_n else {"min_speakers": 1, "max_speakers": 5}
            _, turns = self._diarize(call_wav, **kwargs)
            call = relabel(
                merge(call_segs, turns, smooth_threshold=0.4 if call_n else None, consolidate=False),
                mapping_start=1,
            )
        return interleave(label(mic_segs, "SPEAKER_00"), call)

    # ── Chunked transcription (long recordings) ──────────────────

    @modal.method()
    def transcribe_chunk(
        self,
        wav_bytes: bytes,
        language: str | None,
        num_speakers: int | None = None,
        prompt: str | None = None,
        quality: str = "fast",
        privacy_mode: bool = False,
        correction_hints: str = "",
        core_lead_s: float = 0.0,
        core_len_s: float | None = None,
        is_last_chunk: bool = True,
        call_wav_bytes: bytes | None = None,
    ) -> dict:
        """Обрабатывает ОДИН чанк длинной записи (для transcribe_long).

        call_wav_bytes — канал звонка двухканальной записи (тогда wav_bytes —
        канал микрофона). Микрофонные сегменты помечаются channels.MIC_LABEL,
        единственный собеседник — CALL_LABEL; эмбеддинги — только по каналу звонка.

        Принимает уже сконвертированный 16kHz mono WAV — оркестратор делает
        ffmpeg один раз на весь файл и режет на куски. В отличие от
        transcribe_full:
          • не форсит num_speakers (в чанке может быть меньше спикеров) —
            если задан, используется как верхний предел (max_speakers) чтобы
            не было over-segmentation; глобальное число применяется при кластеризации;
          • дополнительно возвращает centroid-эмбеддинги каждого ЛОКАЛЬНОГО
            спикера, чтобы оркестратор глобально сшил спикеров между чанками;
          • таймстемпы chunk-relative (оркестратор сам добавит offset).

        core_lead_s / core_len_s / is_last_chunk — границы "ядра" чанка внутри
        паддед-аудио (оркестратор режет с нахлёстом CHUNK_PAD_S): Whisper
        слышит контекст через шов, но сегменты из пад-зон отбрасываются
        (_trim_to_core) — их отдаёт соседний чанк. Дефолты = трим выключен
        (обратная совместимость).

        Returns:
          { "segments": [{speaker, start, end, text}, ...],   # chunk-relative
            "embeddings": {"SPEAKER_00": [[float, ...], ...], ...},  # до EMB_PER_SPEAKER векторов
            "vocab_additions": [term, ...] }
        """
        from channels import CALL_LABEL, MIC_LABEL, drop_echo, interleave, label, split_on_pauses
        from merger import merge

        def core(segs: list[dict]) -> list[dict]:
            # Дедуп пад-зон: текст из нахлёста отдаёт соседний чанк
            if core_len_s is None:
                return segs
            return _trim_to_core(segs, core_lead_s, core_len_s, is_last_chunk)

        empty = {"segments": [], "embeddings": {}, "vocab_additions": []}
        wav_path = _tmp_path(".wav")
        paths = [wav_path]
        try:
            with open(wav_path, "wb") as f:
                f.write(wav_bytes)
            segments = core(self._run_whisper(wav_path, language, prompt, quality))

            if call_wav_bytes is None:
                if not segments:
                    return empty
                # Не форсим точное число — в чанке может говорить меньше спикеров;
                # num_speakers — верхний предел против over-segmentation.
                annotation, turns = self._diarize(wav_path, min_speakers=1, max_speakers=num_speakers or 6)
                embeddings = self._speaker_centroids(wav_path, annotation)
                merged = merge(segments, turns)
            else:
                call_path = _tmp_path(".wav")
                paths.append(call_path)
                with open(call_path, "wb") as f:
                    f.write(call_wav_bytes)
                call_segs = split_on_pauses(core(self._run_whisper(call_path, language, prompt, quality)))
                segments = split_on_pauses(segments)
                if not segments and not call_segs:
                    return empty
                mic = label(drop_echo(segments, call_segs), MIC_LABEL)
                embeddings = {}
                if num_speakers == 1:  # без диаризации (Free) — всё одним спикером
                    call = label(call_segs, MIC_LABEL)
                elif not call_segs or num_speakers == 2:
                    call = label(call_segs, CALL_LABEL)
                else:
                    call_max = num_speakers - 1 if num_speakers else 5
                    annotation, turns = self._diarize(call_path, min_speakers=1, max_speakers=call_max)
                    embeddings = self._speaker_centroids(call_path, annotation)
                    call = merge(call_segs, turns, consolidate=False)
                merged = interleave(mic, call)

            for m in merged:
                m["start"]   = float(m["start"])
                m["end"]     = float(m["end"])
                m["speaker"] = str(m["speaker"])

            # --- LLM correction (per-chunk; ~20мин транскрипт влезает в 1 Gemini-вызов) ---
            merged, vocab_additions, corrections = self._correct_segments(
                merged, language, privacy_mode=privacy_mode, correction_hints=correction_hints,
                speakers_fixed=call_wav_bytes is not None,
            )
            return {
                "segments": _merge_same_speaker(merged),
                "embeddings": embeddings,
                "vocab_additions": vocab_additions,
                "corrections": corrections,  # chunk-relative start
            }
        finally:
            for p in paths:
                try:
                    os.remove(p)
                except OSError:
                    pass

    def _speaker_centroids(self, wav_path: str, annotation) -> dict:
        """Embedding'и каждого локального спикера для глобального сшивания.

        Кропаем аудио по самым длинным сегментам спикера и возвращаем до
        EMB_PER_SPEAKER L2-нормированных векторов на спикера (НЕ один
        centroid): несколько точек на голос делают average-linkage
        кластеризацию в оркестраторе устойчивее к шумным сегментам —
        один забитый overlap'ом вектор не утащит всё сравнение (ISS-8).

        Возвращает {label: [[float, ...], ...]} (нативные Python float —
        Flask-контейнер без numpy не десериализует numpy типы).
        Версионно-независимо: не полагается на pyannote return_embeddings.
        """
        import numpy as np

        if self.embedding_inference is None:
            return {}

        out: dict[str, list[list[float]]] = {}
        for label in annotation.labels():
            timeline = annotation.label_timeline(label)
            segs = sorted(timeline, key=lambda s: s.duration, reverse=True)
            vecs: list[list[float]] = []
            for seg in segs[: EMB_PER_SPEAKER + 4]:  # запас на неудачные кропы
                if len(vecs) >= EMB_PER_SPEAKER:
                    break
                if seg.duration < 0.5:  # слишком короткие — embedding нестабилен
                    continue
                try:
                    emb = self.embedding_inference.crop(wav_path, seg)
                except Exception as e:
                    print(f"[modal] embedding crop failed for {label}: {e}", flush=True)
                    continue
                v = np.asarray(emb, dtype="float32").reshape(-1)
                norm = float(np.linalg.norm(v))
                if norm > 1e-8:
                    vecs.append([float(x) for x in v / norm])
            if vecs:
                out[label] = vecs
        return out

    def _correct_segments(self, segments: list[dict], language: str | None,
                          privacy_mode: bool = False,
                          correction_hints: str = "",
                          speakers_fixed: bool = False) -> tuple[list[dict], list[dict], list[dict]]:
        """_correct_segments_impl + список правок (было → стало) для архива —
        по нему видно, где коррекция испортила смысл. Кол-во и порядок
        сегментов коррекция не меняет, поэтому сравнение попарное."""
        corrected, vocab = self._correct_segments_impl(
            segments, language, privacy_mode=privacy_mode,
            correction_hints=correction_hints, speakers_fixed=speakers_fixed)
        changes = [
            {"start": float(b["start"]), "speaker_before": a["speaker"], "speaker_after": b["speaker"],
             "before": a["text"], "after": b["text"]}
            for a, b in zip(segments, corrected)
            if a["text"] != b["text"] or a["speaker"] != b["speaker"]
        ]
        return corrected, vocab, changes

    def _correct_segments_impl(self, segments: list[dict], language: str | None,
                               privacy_mode: bool = False,
                               correction_hints: str = "",
                               speakers_fixed: bool = False) -> tuple[list[dict], list[dict]]:
        """Главный correction pass.

        privacy_mode=True skips the Gemini call entirely — falls back to
        local Qwen on the same GPU. No data leaves Modal infra.

        Возвращает (corrected_segments, vocab_additions).
        vocab_additions — список терминов которые Gemini добавил при
        коррекции (аббревиатуры, имена собственные). Используется для
        пополнения персонального словаря юзера в Supabase.

        Стратегия:
        1. Пробуем Gemini 2.5 Flash — знание мира (ADHD, бренды, имена)
           + контекст 2M токенов + boundary fix.
        2. Если Gemini недоступен — фоллбэк на Qwen 7B на GPU.
           Qwen не даёт vocab additions (он только мелкие правки делает).
        """
        if not segments:
            return segments, []

        # Privacy Mode — skip Gemini entirely, stay on-device
        if privacy_mode:
            return self._correct_segments_qwen(segments, language), []

        # Try Gemini first if API key available
        if os.environ.get("GEMINI_API_KEY", "").strip():
            try:
                result = self._correct_segments_gemini(segments, language, correction_hints,
                                                       speakers_fixed=speakers_fixed)
                if result:
                    return result  # (segments, vocab_additions)
            except Exception as e:
                print(f"[modal] gemini correction failed, falling back to qwen: {e}", flush=True)

        return self._correct_segments_qwen(segments, language), []

    def _extract_vocab_terms(self, orig_text: str, corrected_text: str) -> list[str]:
        """Извлекаем "интересные" термины из разницы оригинал/коррекция.

        Идея: если Gemini заменил "рдух" на "ADHD" — это терминология
        пользователя, она должна попасть в его персональный словарь.
        Берём только: аббревиатуры (CAPS), имена собственные (Capitalized),
        длиннее 2 символов. Игнорируем мелкие правки регистра/пунктуации.
        """
        if orig_text == corrected_text:
            return []

        import string
        # Извлекаем слова из обоих текстов (без пунктуации)
        def words(t: str) -> set[str]:
            cleaned = "".join(c if c.isalnum() or c.isspace() else " " for c in t)
            return {w for w in cleaned.split() if len(w) > 2}

        orig_words = words(orig_text)
        new_words  = words(corrected_text)
        # Новые токены, которых не было в оригинале
        added = new_words - orig_words

        interesting: list[str] = []
        for w in added:
            # Аббревиатура: 2+ заглавных подряд (ADHD, CTR, FPV, ПТСР)
            if sum(1 for c in w if c.isupper()) >= 2 and any(c.isalpha() for c in w):
                interesting.append(w)
                continue
            # Имя собственное: первая заглавная + хотя бы 4 символа всего
            # (отфильтровывает обычные слова в начале предложения)
            if len(w) >= 4 and w[0].isupper() and w[1:].islower():
                interesting.append(w)
        return interesting

    @staticmethod
    def _vocab_is_interesting(w: str) -> bool:
        """Слово достойно словаря: аббревиатура (2+ CAPS, в т.ч. 2-буквенная
        как ЖК/AI/HR) или имя собственное (Capitalized, 4+)."""
        if len(w) < 2:
            return False
        if sum(1 for c in w if c.isupper()) >= 2 and any(c.isalpha() for c in w):
            return True
        if len(w) >= 4 and w[0].isupper() and w[1:].islower():
            return True
        return False

    def _extract_vocab_pairs(self, orig_text: str, corrected_text: str) -> list[dict]:
        """Извлекаем пары (wrong → right) из разницы оригинал/коррекция.

        В отличие от _extract_vocab_terms (только правая форма), сохраняем ЧТО
        именно было заменено: "пожика" → "по ЖК". Пары идут в персональный
        словарь и потом подаются Gemini как "known corrections" при будущей
        коррекции. Выравнивание — difflib по словам; берём replace-блоки, где в
        правой части есть "интересный" термин.
        """
        if orig_text == corrected_text:
            return []
        import difflib

        def tokenize(t: str) -> list[str]:
            cleaned = "".join(c if c.isalnum() or c.isspace() else " " for c in t)
            return cleaned.split()

        def worthy(w: str) -> bool:
            # Достойно пары: аббревиатура / имя собственное (как в Whisper-словаре)
            # ИЛИ содержательное слово 5+ букв — чтобы ловить строчные доменные
            # термины (дебіторська, алерти, формули), но не короткие
            # грамматические фиксы (він→вона).
            if self._vocab_is_interesting(w):
                return True
            return len(w) >= 5 and any(c.isalpha() for c in w)

        a = tokenize(orig_text)
        b = tokenize(corrected_text)
        sm = difflib.SequenceMatcher(a=a, b=b, autojunk=False)
        pairs: list[dict] = []
        for op, i1, i2, j1, j2 in sm.get_opcodes():
            if op != "replace":
                continue
            right_words = b[j1:j2]
            wrong_words = a[i1:i2]
            # Только короткие term-уровневые замены (не перефразирование/boundary fix)
            if not right_words or not wrong_words:
                continue
            if len(right_words) > 3 or len(wrong_words) > 3:
                continue
            if not any(worthy(w) for w in right_words):
                continue
            right = " ".join(right_words).strip()
            wrong = " ".join(wrong_words).strip()
            if right and wrong and right.lower() != wrong.lower():
                pairs.append({"wrong": wrong, "right": right})
        return pairs

    def _correct_segments_gemini(self, segments: list[dict], language: str | None,
                                 correction_hints: str = "",
                                 speakers_fixed: bool = False) -> tuple[list[dict], list[dict]] | None:
        """Gemini-based correction с boundary-fix capability.

        Передаём весь транскрипт с метками спикеров. Gemini может:
        - исправить STT-ошибки используя знание мира (рдух → ADHD)
        - переместить 1-3 слова в начале/конце реплики на соседнего
          спикера если грамматика явно указывает на pyannote-ошибку
        Возвращает обновлённые segments или None если ничего не вышло.
        """
        import requests

        api_key = os.environ["GEMINI_API_KEY"].strip()
        instruction = _CORRECTION_INSTRUCTIONS.get(language or "", _CORRECTION_INSTRUCTIONS["en"])

        # Персональные known corrections юзера (wrong → right из его прошлых
        # правок). Gemini применяет их контекстно, не слепой заменой.
        hints_block = ""
        if correction_hints:
            hints_block = (
                "\n\nKnown corrections for THIS specific user (their recurring "
                "domain terms, learned from past edits). When you see the LEFT form "
                "misrecognized, prefer the RIGHT form — but only when context fits:\n"
                f"{correction_hints}\n"
            )

        # Format: "N. [SPEAKER_XX] text"
        lines = [
            f"{i + 1}. [{seg['speaker']}] {seg['text']}"
            for i, seg in enumerate(segments)
        ]
        lines_in = "\n".join(lines)

        # Двухканальная запись: спикер известен по микрофону — переносить слова
        # между репликами/спикерами нельзя, это только испортит атрибуцию.
        boundary_task = (
            "2. Speaker labels come from separate microphones and are ALWAYS correct:\n"
            "   never move words between lines and never change a label.\n\n"
            if speakers_fixed else
            "2. Boundary fix: if you see a phrase clearly belonging to the NEXT or PREVIOUS speaker\n"
            "   (e.g. an answer's first words attached to the question), move those 1-5 words\n"
            "   across the speaker boundary. ONLY when grammar and semantics give clear evidence.\n\n"
        )
        prompt = (
            f"{instruction}{hints_block}\n\n"
            "Below is a numbered, speaker-diarized transcript. Each line is:\n"
            "  N. [SPEAKER_XX] text\n\n"
            "Your tasks (in this order of importance):\n"
            "1. Fix obvious phonetic STT errors using world knowledge:\n"
            "   - Acronyms transliterated wrong (e.g. рдух → ADHD, СДВГ; стіарар → CTR)\n"
            "   - Misrecognized names of people, brands, products\n"
            "   - Technical terms broken by phonetic recognition\n"
            f"{boundary_task}"
            "STRICT RULES:\n"
            "- Output ONLY the same numbered lines, same format: 'N. [SPEAKER_XX] text'\n"
            "- Keep numbering 1..N identical, no gaps\n"
            "- Keep speaker labels [SPEAKER_XX] unchanged\n"
            "- Do NOT add commentary, headers, explanations\n"
            "- Do NOT change meaning, style, punctuation, case\n"
            "- Word count per line: within ±20% of original (boundary moves can shift it more)\n"
            "- If unsure about a line — output it verbatim\n"
            "- Same language as input\n\n"
            "INPUT:\n"
            f"{lines_in}\n\n"
            "OUTPUT (numbered lines only, no preamble):"
        )

        endpoint = (
            f"https://generativelanguage.googleapis.com/v1beta/models/"
            f"{GEMINI_CORRECTION_MODEL}:generateContent"
        )
        # Cyrillic ≈ 1.5 chars/token → output ≈ len(lines_in)/1.5 tokens.
        # Old formula (× 2) assumed ASCII (4 chars/token) and overshot 3×, causing
        # 30k-token requests on medium transcripts → Gemini at ~100 tok/s →
        # exceeded the 180s timeout → silent fallback to Qwen (3.5min total).
        # thinkingBudget=0: correction is a character-substitution task, not
        # reasoning — adaptive thinking only adds latency, no quality benefit.
        max_out = min(16000, max(2000, len(lines_in)))
        body = {
            "contents": [{"role": "user", "parts": [{"text": prompt}]}],
            "generationConfig": {
                "temperature": 0.1,
                "maxOutputTokens": max_out,
                "thinkingConfig": {"thinkingBudget": 0},
            },
        }

        try:
            resp = requests.post(endpoint, params={"key": api_key}, json=body, timeout=240)
        except requests.RequestException as e:
            print(f"[modal] gemini request error: {e}", flush=True)
            return None

        if resp.status_code != 200:
            print(f"[modal] gemini {resp.status_code}: {resp.text[:200]}", flush=True)
            return None

        data = resp.json()
        candidates = data.get("candidates") or []
        if not candidates:
            print(f"[modal] gemini: no candidates ({data.get('promptFeedback')})", flush=True)
            return None
        parts = (candidates[0].get("content") or {}).get("parts") or []
        raw = "".join(p.get("text", "") for p in parts).strip()
        if not raw:
            return None

        # Parse: same format "N. [SPEAKER_XX] text"
        parsed: dict[int, tuple[str, str]] = {}
        line_re = re.compile(r'^\s*(\d+)\.\s*\[([A-Z_0-9]+)\]\s*(.+)$')
        for line in raw.splitlines():
            m = line_re.match(line)
            if not m:
                continue
            idx     = int(m.group(1)) - 1
            speaker = m.group(2)
            text    = m.group(3).strip()
            if 0 <= idx < len(segments):
                parsed[idx] = (speaker, text)

        # Coverage check — если Gemini вернул меньше 70% строк, что-то пошло
        # не так, лучше вообще не применять (избегаем частичной коррекции).
        coverage = len(parsed) / max(len(segments), 1)
        if coverage < 0.7:
            print(f"[modal] gemini parse coverage too low: {coverage:.0%}", flush=True)
            return None

        # Apply corrections with safety checks
        corrected = [dict(s) for s in segments]
        changes_count = 0
        speaker_changes = 0
        vocab_additions: list[dict] = []
        original_speakers = {s["speaker"] for s in segments}
        for idx, (new_speaker, new_text) in parsed.items():
            orig = corrected[idx]
            orig_text = orig["text"]

            # Length sanity: 50% (boundary moves can shift things)
            length_ratio = abs(len(new_text) - len(orig_text)) / max(len(orig_text), 1)
            if length_ratio > 0.5:
                continue

            # Latin/Cyrillic safety — не пускаем массовый переход в латиницу
            orig_latin = sum(1 for c in orig_text if c.isascii() and c.isalpha())
            new_latin  = sum(1 for c in new_text  if c.isascii() and c.isalpha())
            orig_cyr   = sum(1 for c in orig_text if 'Ѐ' <= c <= 'ӿ')
            # Allow some Latin (acronyms like ADHD, CTR), but not wholesale
            if orig_cyr > len(orig_text) * 0.5 and new_latin > orig_latin + 8:
                continue

            if new_text != orig_text:
                # Извлекаем пары (wrong → right) для персонального словаря
                vocab_additions.extend(self._extract_vocab_pairs(orig_text, new_text))
                corrected[idx]["text"] = new_text
                changes_count += 1
            # Speaker reassignment (boundary fix)
            if not speakers_fixed and new_speaker in original_speakers and new_speaker != orig["speaker"]:
                corrected[idx]["speaker"] = new_speaker
                speaker_changes += 1

        # Дедуплицируем по правой форме (сохраняем порядок появления)
        seen: set[str] = set()
        unique_vocab: list[dict] = []
        for p in vocab_additions:
            key = p["right"].lower()
            if key not in seen:
                seen.add(key)
                unique_vocab.append(p)

        print(
            f"[modal] gemini corrected {changes_count} texts, "
            f"reassigned {speaker_changes} segments, "
            f"vocab+{len(unique_vocab)} ({', '.join(p['right'] for p in unique_vocab[:8])}) "
            f"(coverage {coverage:.0%})",
            flush=True,
        )
        return corrected, unique_vocab

    def _correct_segments_qwen(self, segments: list[dict], language: str | None) -> list[dict]:
        """Фоллбэк: локальный Qwen 7B (4-bit) на GPU. Используется когда
        Gemini недоступен (нет ключа, сетевая ошибка, rate limit).
        Без boundary-fix — только фонетика, в батчах по 60 строк.
        """
        instruction = _CORRECTION_INSTRUCTIONS.get(language or "", _CORRECTION_INSTRUCTIONS["en"])
        batch_size  = 60
        corrected   = [dict(s) for s in segments]

        for batch_start in range(0, len(segments), batch_size):
            batch    = segments[batch_start:batch_start + batch_size]
            lines_in = "\n".join(f"{i + 1}. {seg['text']}" for i, seg in enumerate(batch))

            prompt = (
                f"{instruction}\n\n"
                "Return ONLY the same numbered lines with corrections applied. "
                "Keep numbering and format identical.\n\n"
                f"{lines_in}"
            )

            try:
                raw = self._llm_generate_raw(prompt, max_tokens=max(256, len(lines_in) // 2), temperature=0.0)

                for line in raw.splitlines():
                    m = re.match(r'^(\d+)\.\s+(.+)$', line.strip())
                    if not m:
                        continue
                    idx  = int(m.group(1)) - 1
                    text = m.group(2).strip()
                    if not (0 <= idx < len(batch)):
                        continue
                    orig = batch[idx]["text"]
                    if abs(len(text) - len(orig)) / max(len(orig), 1) > 0.4:
                        continue
                    orig_latin = sum(1 for c in orig  if c.isascii() and c.isalpha())
                    new_latin  = sum(1 for c in text  if c.isascii() and c.isalpha())
                    orig_cyr   = sum(1 for c in orig  if 'Ѐ' <= c <= 'ӿ')
                    if orig_cyr > len(orig) * 0.5 and new_latin > orig_latin + 1:
                        continue
                    corrected[batch_start + idx]["text"] = text

            except Exception as e:
                print(f"[modal] qwen correction batch {batch_start // batch_size} failed: {e}", flush=True)

        return corrected

    # ── LLM ──────────────────────────────────────────────────────

    @modal.method()
    def run_llm(self, prompt: str, max_tokens: int = 200, temperature: float = 0.4) -> str:
        """Публичный метод LLM — для title, summary, chat, action items."""
        return self._llm_generate_raw(prompt, max_tokens=max_tokens, temperature=temperature)

    def _llm_generate_raw(self, prompt: str, max_tokens: int, temperature: float) -> str:
        """Внутренний LLM inference через transformers."""
        import torch

        # В transformers 5.x apply_chat_template возвращает BatchEncoding (dict),
        # а не тензор — нужно передавать как **kwargs в generate().
        messages = [{"role": "user", "content": prompt}]
        try:
            result = self.llm_tokenizer.apply_chat_template(
                messages, tokenize=True, add_generation_prompt=True, return_tensors="pt"
            )
        except Exception:
            result = self.llm_tokenizer(prompt, return_tensors="pt")

        # Нормализуем: всегда работаем как BatchEncoding-dict на cuda
        if isinstance(result, torch.Tensor):
            encoded = {"input_ids": result.to("cuda")}
        else:
            encoded = {k: v.to("cuda") for k, v in result.items()}

        input_len = encoded["input_ids"].shape[-1]

        with torch.no_grad():
            output = self.llm_model.generate(
                **encoded,
                max_new_tokens=max_tokens,
                do_sample=temperature > 0,
                temperature=max(temperature, 1e-6) if temperature > 0 else 1.0,
                pad_token_id=self.llm_tokenizer.eos_token_id,
            )

        response = self.llm_tokenizer.decode(output[0][input_len:], skip_special_tokens=True)
        return response.strip()


# ── Long-recording orchestrator ─────────────────────────────────
#
# Для записей > LONG_AUDIO_THRESHOLD_S (роутинг в app.py) монолитный
# transcribe_full не подходит — 4ч обработки не влезут в таймаут, а один
# Gemini-вызов на весь транскрипт упрётся в лимиты. Оркестратор режет аудио
# на ~20-мин чанки, обрабатывает их ПАРАЛЛЕЛЬНО на нескольких A10G
# (Transcriptor.transcribe_chunk.spawn), глобально сшивает спикеров через
# embedding-кластеризацию и стичит. Контракт ответа идентичен transcribe_full
# чтобы Flask polling / job_id не менялись.

def _parse_silences(stderr: str) -> list[tuple[float, float]]:
    """Парсит вывод ffmpeg silencedetect → список (start, end) интервалов тишины."""
    silences: list[tuple[float, float]] = []
    cur_start: float | None = None
    for line in stderr.splitlines():
        if "silence_start:" in line:
            try:
                cur_start = float(line.split("silence_start:")[1].strip().split()[0])
            except (ValueError, IndexError):
                cur_start = None
        elif "silence_end:" in line and cur_start is not None:
            try:
                end = float(line.split("silence_end:")[1].strip().split()[0])
                silences.append((cur_start, end))
            except (ValueError, IndexError):
                pass
            cur_start = None
    return silences


def _plan_chunk_boundaries(duration: float, silences: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """Планирует границы чанков, привязывая разрезы к ближайшим точкам тишины
    (чтобы не резать посреди слова). Фоллбэк — жёсткий рез.

    Число чанков выбирается так, чтобы все они влезли в одну параллельную
    волну GPU (≤ MAX_PARALLEL_CHUNKS): для 4ч записи это ~24-мин чанки вместо
    12×20-мин в две волны → ~2x по wall-clock при той же суммарной GPU-минуте.
    Длина чанка не превышает MAX_CHUNK_LEN_S (кап под таймаут Transcriptor).
    """
    import math

    if duration <= CHUNK_LEN_S * 1.5:
        return [(0.0, duration)]

    n = math.ceil(duration / CHUNK_LEN_S)
    if n > MAX_PARALLEL_CHUNKS:
        # Меньше чанков, длиннее каждый — но не длиннее жёсткого капа.
        # Если даже с капом чанков больше лимита (5ч+) — принимаем 2 волны.
        n = max(MAX_PARALLEL_CHUNKS, math.ceil(duration / MAX_CHUNK_LEN_S))
    chunk_len = duration / n

    sil_mids = [(s + e) / 2 for s, e in silences]
    window = max(120.0, chunk_len * 0.25)  # окно поиска тишины вокруг цели
    cuts: list[float] = []
    # Цели фиксированы на i*chunk_len (не относительно прошлого реза) — drift
    # от снэппинга к тишине не накапливается, чанков выходит ровно n.
    for i in range(1, n):
        target = i * chunk_len
        lo = (cuts[-1] if cuts else 0.0) + 60.0  # минимум 60с от прошлого реза
        hi = duration - 60.0
        candidates = [m for m in sil_mids if abs(m - target) < window and lo < m < hi]
        cut = min(candidates, key=lambda m: abs(m - target)) if candidates else min(max(target, lo), hi)
        cuts.append(cut)

    points = [0.0] + cuts + [duration]
    return [(points[i], points[i + 1]) for i in range(len(points) - 1)]


def _cluster_speaker_embeddings(
    chunk_ids: list[int],
    vec_groups: list[list[list[float]]],
    num_speakers: int | None,
    threshold: float,
    phantom_dist: float = GLOBAL_SPK_PHANTOM_DIST,
) -> list[int]:
    """Агломеративная кластеризация локальных спикеров между чанками
    с cannot-link констрейнтом. Возвращает cluster_id для каждого элемента.

    chunk_ids[i]  — индекс чанка, из которого пришёл локальный спикер i.
    vec_groups[i] — его embedding'и (1+ векторов; нормализуются здесь).

    Cannot-link: два локальных спикера ОДНОГО чанка — обычно разные люди
    (pyannote разделил их, слыша обоих в общем контексте) — их кластеры не
    сливаются. Это структурно блокирует склейку похожих голосов (старый фейл
    на звонках 1-на-1, где оба спикера есть в каждом чанке). ИСКЛЮЧЕНИЕ
    (phantom_dist): если одночанковая пара ближе phantom_dist — это не два
    человека, а pyannote over-сегментировал один голос; такие сливаем, иначе
    в auto-режиме фантомы плодят лишних глобальных спикеров (2 → 5).
    Linkage: average по всем парам векторов двух кластеров.

    При заданном num_speakers сливаем до k; если cannot-link не даёт дойти
    до k, наименьшие кластеры вливаются в ближайший принудительно.
    """
    import numpy as np

    n = len(chunk_ids)
    if n == 0:
        return []
    if n == 1:
        return [0]

    # Центроид каждого локального спикера: среднее его L2-нормированных
    # векторов, затем снова нормируем. Усреднение гасит шум отдельных
    # сегментов (overlap, короткие реплики, телефонное сжатие) — иначе
    # average-linkage по всем шумным парам раздувал расстояние «тот же
    # человек на разных чанках» выше порога → дубли на швах (regression).
    cents = []
    for g in vec_groups:
        m = np.asarray(g, dtype="float64")
        m = m / np.clip(np.linalg.norm(m, axis=1, keepdims=True), 1e-8, None)
        c = m.mean(axis=0)
        c = c / max(float(np.linalg.norm(c)), 1e-8)
        cents.append(c)
    C = np.vstack(cents)
    D = 1.0 - (C @ C.T)
    np.fill_diagonal(D, 0.0)

    clusters: list[set[int]] = [{i} for i in range(n)]
    chunksets: list[set[int]] = [{chunk_ids[i]} for i in range(n)]

    def cdist(a: int, b: int) -> float:
        s = sum(D[i, j] for i in clusters[a] for j in clusters[b])
        return s / (len(clusters[a]) * len(clusters[b]))

    def best_allowed_pair() -> tuple[int | None, int | None, float]:
        best = (None, None, float("inf"))
        for a in range(len(clusters)):
            for b in range(a + 1, len(clusters)):
                d = cdist(a, b)
                if chunksets[a] & chunksets[b] and d >= phantom_dist:
                    continue  # cannot-link: общий чанк И не явный фантом
                if d < best[2]:
                    best = (a, b, d)
        return best

    def do_merge(a: int, b: int):
        clusters[a] |= clusters[b]
        chunksets[a] |= chunksets[b]
        del clusters[b]
        del chunksets[b]

    target_k = num_speakers if (num_speakers and num_speakers >= 1) else None
    while len(clusters) > (target_k or 1):
        a, b, d = best_allowed_pair()
        if a is None:
            break  # допустимых слияний не осталось
        if target_k is None and d >= threshold:
            break
        do_merge(a, b)

    # Форс-фаза для явного num_speakers: вливаем наименьшие кластеры в
    # ближайший, игнорируя cannot-link — лишние локальные спикеры в чанке
    # обычно фантомы pyannote с парой коротких сегментов.
    if target_k is not None:
        while len(clusters) > target_k:
            smallest = min(range(len(clusters)), key=lambda c: len(clusters[c]))
            others = [c for c in range(len(clusters)) if c != smallest]
            nearest = min(others, key=lambda c: cdist(smallest, c))
            print(f"[long] force-merging phantom cluster (size "
                  f"{len(clusters[smallest])}) to reach num_speakers={target_k}",
                  flush=True)
            a, b = sorted((smallest, nearest))
            do_merge(a, b)

    labels = [0] * n
    for cid, members in enumerate(clusters):
        for i in members:
            labels[i] = cid
    return labels


@app.function(
    image=orchestrator_image,
    secrets=[hf_secret],
    timeout=14400,               # 4ч с запасом — оркестратор почти всё время ждёт GPU;
                                 # при сериализации чанков (GPU-лимит) 4ч+ запись
                                 # может легко выйти за старые 2ч
    scaledown_window=60,
    min_containers=0,
)
def transcribe_long(
    audio_bytes: bytes,
    language: str | None,
    num_speakers: int | None,
    prompt: str | None = None,
    progress_key: str | None = None,
    quality: str = "fast",
    privacy_mode: bool = False,
    correction_hints: str = "",
) -> dict:
    """Оркестратор длинных записей. Контракт ответа = transcribe_full:
      { "segments": [{speaker, start, end, text}, ...], "vocab_additions": [...] }
    """
    import soundfile as sf
    import numpy as np

    # Честный мониторинг стадий (тот же контракт что у transcribe_full). Для
    # длинной записи per-chunk транскрипция+диаризация+коррекция идут параллельно
    # внутри «transcription»; «diarization» = глобальное сшивание спикеров,
    # «ai_formatting» = финальная агрегация. container_sec=0 (CPU-оркестратор).
    pp = _PipelineProgress(progress_key, container_sec=0.0)

    from channels import CALL_LABEL, MIC_LABEL

    src_path = _tmp_path(".bin")
    wavs: list[str] = []
    chunk_paths: list[str] = []
    try:
        with open(src_path, "wb") as f:
            f.write(audio_bytes)

        # 1. Декод → 16k mono wav (на диск, не в RAM). Двухканальная запись
        # веб-рекордера → два wav (микрофон, звонок), режутся по одним границам.
        pp.start("audio_split")
        mode, wavs = _prepare_audio(src_path)
        dual = mode == "dual"
        wav_path = wavs[0]
        duration = float(sf.info(wav_path).duration)

        # 2. Silence-aware split (для двух каналов — тишина в обоих, через amix)
        sil_cmd = (
            ["ffmpeg", "-i", wavs[0], "-i", wavs[1], "-filter_complex",
             "amix=inputs=2:normalize=0,silencedetect=noise=-30dB:d=0.5", "-f", "null", "-"]
            if dual else
            ["ffmpeg", "-i", wav_path, "-af", "silencedetect=noise=-30dB:d=0.5", "-f", "null", "-"]
        )
        sil_proc = subprocess.run(sil_cmd, capture_output=True, text=True)
        silences = _parse_silences(sil_proc.stderr)
        boundaries = _plan_chunk_boundaries(duration, silences)
        n = len(boundaries)
        pp.done("audio_split")  # decode + silence-aware split planned
        print(f"[long] duration={duration:.0f}s → {n} chunks (silences={len(silences)})", flush=True)

        # 3. Фан-аут: извлекаем чанк и сразу спавним воркер (память — один чанк за раз).
        # Каждый чанк вырезается с нахлёстом CHUNK_PAD_S с обеих сторон: Whisper
        # дослушивает фразу через шов (hard-cut больше не рвёт слово), а
        # transcribe_chunk отбрасывает сегменты из пад-зон (_trim_to_core) —
        # дубликатов на стыках нет. pad_starts[i] — глобальное время начала
        # ПАДДЕД-аудио чанка (нужно для оффсета при стиче).
        pp.start("transcription", chunks_total=n, chunks_done=0, chunks_failed=0)
        calls = []
        pad_starts: list[float] = []
        def cut(src: str, ss: float, dur: float, i: int) -> bytes:
            ch_path = _tmp_path(f".chunk{i}.wav")
            chunk_paths.append(ch_path)
            # -ss/-t (не -to): -t = длительность, однозначно во всех версиях
            # ffmpeg (в отличие от -to, который может быть абсолютным/относительным).
            subprocess.run(
                ["ffmpeg", "-y", "-ss", str(ss), "-t", str(dur),
                 "-i", src, "-ar", "16000", "-ac", "1", ch_path],
                check=True, capture_output=True,
            )
            with open(ch_path, "rb") as f:
                data = f.read()
            # Файл чанка больше не нужен — байты ушли в spawn. Чистим сразу,
            # иначе к концу джобы на диске лежит полный дубль записи в wav.
            try:
                os.remove(ch_path)
            except OSError:
                pass
            return data

        for i, (start, end) in enumerate(boundaries):
            ss = max(0.0, start - CHUNK_PAD_S)
            to = min(duration, end + CHUNK_PAD_S)
            pad_starts.append(ss)
            call = Transcriptor().transcribe_chunk.spawn(
                cut(wav_path, ss, to - ss, i), language, num_speakers, prompt, quality,
                privacy_mode, correction_hints,
                core_lead_s=start - ss,
                core_len_s=end - start,
                is_last_chunk=(i == n - 1),
                call_wav_bytes=cut(wavs[1], ss, to - ss, i) if dual else None,
            )
            calls.append((i, start, call))

        # 4. Сбор результатов (чанки крутятся параллельно на Modal).
        # Падение одного чанка (после Modal-ретраев) НЕ должно убивать всю
        # джобу: логируем, помечаем как gap и продолжаем — частичный транскрипт
        # 4ч записи ценнее, чем ничего (ISS-2).
        results: list[tuple[float, dict | None]] = [None] * n  # type: ignore
        done = 0
        failed_chunks: list[int] = []
        for i, start, call in calls:
            try:
                res = call.get()
            except Exception as e:
                print(f"[long] chunk {i + 1}/{n} FAILED after retries: {e}", flush=True)
                failed_chunks.append(i)
                res = None
            results[i] = (start, res)
            done += 1
            pp.update("transcription", chunks_total=n, chunks_done=done,
                      chunks_failed=len(failed_chunks))
        if len(failed_chunks) == n:
            pp.fail("transcription", chunks_total=n, chunks_done=done, chunks_failed=len(failed_chunks))
            raise RuntimeError(f"all {n} chunks failed — cannot produce a transcript")
        pp.done("transcription", chunks_total=n, chunks_done=done, chunks_failed=len(failed_chunks))

        # 5. Глобальная кластеризация спикеров по centroid-эмбеддингам
        pp.start("diarization")
        items: list[tuple[int, str]] = []   # (chunk_idx, local_label)
        groups: list[list[list[float]]] = []
        for i, (_start, res) in enumerate(results):
            if not res:
                continue  # упавший чанк — пропускаем (gap-маркер добавится при стиче)
            for label, vec in (res.get("embeddings") or {}).items():
                if not vec:
                    continue
                # Новый формат — список векторов на спикера; старый (in-flight
                # джобы во время деплоя) — один плоский вектор float'ов.
                group = vec if isinstance(vec[0], (list, tuple)) else [vec]
                items.append((i, label))
                groups.append(group)

        # diag: сколько локальных спикеров pyannote нашёл в каждом чанке
        per_chunk: dict[int, int] = {}
        for (ci, _lbl) in items:
            per_chunk[ci] = per_chunk.get(ci, 0) + 1
        print(f"[long] speakers-with-embeddings={len(items)} per-chunk-speakers={[per_chunk.get(i, 0) for i in range(n)]} num_speakers={num_speakers}", flush=True)

        label_map: dict[tuple[int, str], int] = {}
        if items:
            chunk_ids = [ci for ci, _ in items]
            # Для двух каналов эмбеддинги есть только у собеседников — их на одного меньше
            cluster_k = (num_speakers - 1 if num_speakers else None) if dual else num_speakers
            cluster_ids = _cluster_speaker_embeddings(
                chunk_ids, groups, cluster_k, GLOBAL_SPK_THRESHOLD,
            )
            label_map = {items[kk]: int(cluster_ids[kk]) for kk in range(len(items))}
            # diag: разделимость спикеров (off-diagonal cosine distance по
            # усреднённым векторам спикеров). Если min мал (<0.3) — голоса
            # почти неразличимы для embedding-модели (телефон/похожие голоса),
            # надёжнее задать num_speakers вручную.
            try:
                X = np.stack([np.asarray(g, dtype="float64").mean(axis=0) for g in groups])
                Xn = X / np.clip(np.linalg.norm(X, axis=1, keepdims=True), 1e-8, None)
                if len(X) > 1:
                    dist = 1.0 - (Xn @ Xn.T)
                    off = dist[~np.eye(len(X), dtype=bool)]
                    print(f"[long] global_speakers={len(set(cluster_ids))} "
                          f"centroid_cos_dist min={off.min():.2f} mean={off.mean():.2f} max={off.max():.2f} "
                          f"thr={GLOBAL_SPK_THRESHOLD}", flush=True)
            except Exception:
                pass
        else:
            print("[long] no speaker embeddings — falling back to per-chunk labels", flush=True)

        # 6. Стич: offset таймстемпов + релейбл local→global + сорт по времени.
        # Таймстемпы чанка относительны ПАДДЕД-аудио → оффсет = pad_starts[i]
        # (начало паддед-вырезки), не start ядра.
        all_segs: list[dict] = []
        for i, (start, res) in enumerate(results):
            if not res:
                continue
            offset = pad_starts[i] if i < len(pad_starts) else start
            for seg in (res.get("segments") or []):
                cluster = label_map.get((i, seg["speaker"]))
                if seg["speaker"] == MIC_LABEL:
                    key = "me"        # владелец микрофона — известен по каналу
                elif seg["speaker"] == CALL_LABEL:
                    key = "call"      # единственный собеседник — известен по каналу
                elif cluster is not None:
                    key = cluster
                else:
                    # Фоллбэк если эмбеддинга не было — уникальный per-chunk лейбл
                    key = f"c{i}_{seg['speaker']}"
                all_segs.append({
                    "start": float(seg["start"]) + offset,
                    "end":   float(seg["end"]) + offset,
                    "text":  seg["text"],
                    "_k":    key,
                })

        # Gap-маркеры за упавшие чанки: явная дыра в транскрипте честнее, чем
        # тихо пропавшие ~20 минут. Спикер — SPEAKER_UNKNOWN, в нумерацию
        # глобальных спикеров гэпы не попадают.
        _GAP_TEXTS = {
            "ru": "[~{m} мин аудио не удалось обработать]",
            "uk": "[~{m} хв аудіо не вдалося обробити]",
            "pl": "[~{m} min nagrania nie udało się przetworzyć]",
            "cs": "[~{m} min nahrávky se nepodařilo zpracovat]",
            "en": "[~{m} min of audio could not be processed]",
        }
        for i in failed_chunks:
            g_start, g_end = boundaries[i]
            tmpl = _GAP_TEXTS.get(language or "", _GAP_TEXTS["en"])
            all_segs.append({
                "start": g_start,
                "end":   g_end,
                "text":  tmpl.format(m=max(1, round((g_end - g_start) / 60))),
                "_k":    ("gap", i),
            })
        all_segs.sort(key=lambda s: s["start"])

        # Глобальная нумерация спикеров по времени первого появления;
        # у двухканальной записи владелец микрофона — всегда SPEAKER_00.
        order: dict = {"me": 0} if dual else {}
        for s in all_segs:
            if isinstance(s["_k"], tuple):
                continue  # gap-маркер — не спикер
            if s["_k"] not in order:
                order[s["_k"]] = len(order)

        # 7. Re-merge соседних сегментов одного (глобального) спикера
        final: list[dict] = []
        for s in all_segs:
            is_gap = isinstance(s["_k"], tuple)
            spk = "SPEAKER_UNKNOWN" if is_gap else f"SPEAKER_{order[s['_k']]:02d}"
            if not is_gap and final and final[-1]["speaker"] == spk:
                final[-1]["end"]   = s["end"]
                final[-1]["text"] += " " + s["text"]
            else:
                final.append({"speaker": spk, "start": s["start"], "end": s["end"], "text": s["text"]})

        pp.done("diarization")  # global speaker clustering + stitch + re-merge

        # 8. Агрегируем vocab_additions (list[dict] {wrong, right}, дедуп по right)
        pp.start("ai_formatting", chunks_total=n, chunks_done=n, chunks_failed=len(failed_chunks))
        vocab: list[dict] = []
        seen: set[str] = set()
        for _i, (_start, res) in enumerate(results):
            if not res:
                continue
            for p in (res.get("vocab_additions") or []):
                # tolerate старый формат (str) на случай in-flight несовместимости
                key = (p.get("right") if isinstance(p, dict) else p) or ""
                kl = key.lower()
                if kl and kl not in seen:
                    seen.add(kl)
                    vocab.append(p)

        pp.done("ai_formatting", chunks_total=n, chunks_done=n,
                chunks_failed=len(failed_chunks))
        print(f"[long] done: {len(final)} segments, {len(order)} speakers, "
              f"vocab+{len(vocab)}, failed_chunks={failed_chunks or 'none'}", flush=True)
        corrections: list[dict] = []
        for i, (start, res) in enumerate(results):
            if not res:
                continue
            offset = pad_starts[i] if i < len(pad_starts) else start
            for c in res.get("corrections") or []:
                corrections.append({**c, "start": float(c["start"]) + offset})
        return {"segments": final, "vocab_additions": vocab, "channel_mode": mode,
                "corrections": corrections}

    finally:
        for p in [src_path, *wavs, *chunk_paths]:
            try:
                os.remove(p)
            except OSError:
                pass


# ── Lab models — side-by-side quality comparison ────────────────
# Candidates for Privacy Mode (Max + Team gated feature) where we replace
# Gemini with a fully self-hosted LLM on Modal GPU. Each class loads ONE
# model and exposes a generic .generate(prompt) method so the comparison
# endpoint can hit them with identical prompts.
#
# Cost notes:
#  • All Lab classes use A10G — same GPU as production Transcriptor, no
#    new GPU type needed. Both quantized to 4-bit (bitsandbytes) so they
#    fit in 24 GB alongside Whisper + pyannote if we ever stack them.
#  • Scale-to-zero with scaledown_window=120 (shorter than prod 300 since
#    these are only used for testing, no need to keep warm).


def _llm_chat_generate(
    model, tokenizer, prompt: str, max_tokens: int, temperature: float,
    *, template_kwargs: dict | None = None, post_process=None,
) -> str:
    """Shared inference helper for any chat-tuned LLM loaded via transformers.
    Wraps prompt as a single user turn and runs greedy/sampled decode.
    Clears CUDA cache before generate to avoid OOM from cold-start fragmentation.

    template_kwargs: extra kwargs passed into apply_chat_template (e.g.
        reasoning_effort='low' for gpt-oss)
    post_process: optional callable(str) -> str applied to the decoded output
        before returning (e.g. strip gpt-oss analysis channel)
    """
    import torch, gc
    messages = [{"role": "user", "content": prompt}]
    tpl_kwargs = dict(
        tokenize=True, add_generation_prompt=True, return_tensors="pt",
    )
    if template_kwargs:
        tpl_kwargs.update(template_kwargs)
    try:
        result = tokenizer.apply_chat_template(messages, **tpl_kwargs)
    except Exception as e:
        print(f"[llm] chat template failed ({e}), falling back to raw tokenize", flush=True)
        result = tokenizer(prompt, return_tensors="pt")
    if isinstance(result, torch.Tensor):
        encoded = {"input_ids": result.to("cuda")}
    else:
        encoded = {k: v.to("cuda") for k, v in result.items()}
    input_len = encoded["input_ids"].shape[-1]
    gc.collect()
    torch.cuda.empty_cache()
    with torch.no_grad():
        output = model.generate(
            **encoded,
            max_new_tokens=max_tokens,
            do_sample=temperature > 0,
            temperature=max(temperature, 1e-6) if temperature > 0 else 1.0,
            pad_token_id=tokenizer.eos_token_id,
        )
    text = tokenizer.decode(output[0][input_len:], skip_special_tokens=True).strip()
    if post_process:
        text = post_process(text)
    return text


# Сентинел для подстановки текста транскрипта в готовые промпты
# generate_mapreduce. Flask собирает промпты сам (шаблон + языковые хинты +
# detail/focus), а текст подставляется уже в GPU-контейнере — str.replace
# вместо str.format, чтобы фигурные скобки в шаблонах не требовали
# экранирования.
MAPREDUCE_TEXT_SLOT = "<<TRANSCRIPT_TEXT>>"


def _split_text_windows(text: str, window_chars: int) -> list[str]:
    """Режет текст на окна ≤ window_chars по границам строк (реплик).

    Сверхдлинная одиночная строка (без переносов) режется жёстко.
    Пустой текст → одно пустое окно (вызывающий код не падает).
    """
    if len(text) <= window_chars:
        return [text]
    windows: list[str] = []
    cur: list[str] = []
    cur_len = 0
    for line in text.split("\n"):
        while len(line) > window_chars:
            if cur:
                windows.append("\n".join(cur))
                cur, cur_len = [], 0
            windows.append(line[:window_chars])
            line = line[window_chars:]
        if cur and cur_len + len(line) + 1 > window_chars:
            windows.append("\n".join(cur))
            cur, cur_len = [], 0
        cur.append(line)
        cur_len += len(line) + 1
    if cur:
        windows.append("\n".join(cur))
    return windows


def _strip_gpt_oss_analysis(text: str) -> str:
    """gpt-oss has two output channels (analysis + final) that the standard
    skip_special_tokens=True decoding flattens — leaving the analysis 'thinking'
    inline before the actual answer. The channel boundary is marked by the
    literal token text 'assistantfinal' once specials are stripped.

    Take everything after the LAST 'assistantfinal' (model might think
    multiple times in 'analysis' channel before committing)."""
    if not text:
        return text
    marker = "assistantfinal"
    idx = text.rfind(marker)
    if idx >= 0:
        return text[idx + len(marker):].lstrip()
    # Fallback: also try common alternative ending
    for alt in ("<|final|>", "final\n"):
        i = text.rfind(alt)
        if i >= 0:
            return text[i + len(alt):].lstrip()
    return text


# Both Lab models run on A100 80GB.
# Rationale: A10G (24GB) OOMs on long-context inference for 20-32B class
# models even with quantization. Attention KV cache + activations push past
# the budget when input is 30K+ tokens (a typical 30-60min transcript).
# A100 80GB has comfortable headroom. Scale-to-zero so we only pay when
# someone runs a Compare or a Privacy Mode generation.

# LabMamayLM9B (Gemma 2 9B UA fine-tune) удалён 2026-06-10: Lab-сравнение
# завершено, для Privacy Mode выбран gpt-oss-20b. Класс висел в деплое мёртвым
# грузом (A10G, большой GPU-образ). Вернуть при необходимости — git history.

@app.cls(
    image=image,
    gpu="L40S",                  # 48GB needed: 12GB model + eager-attn O(n²) on long ctx
    volumes={MODELS_DIR: volume},
    secrets=[hf_secret],
    timeout=2400,                # map-reduce на 4ч транскрипте — до ~25 последовательных
                                 # LLM-вызовов в одном контейнере (~20 мин worst case)
    scaledown_window=120,
    min_containers=0,
)
class LabGPTOSS20B:
    """OpenAI gpt-oss-20b — 21B MoE, ~5B active params per token.
    Strong reasoning, English-centric. Native MXFP4 (12GB) on A10G.

    Output post-processed to strip the 'analysis' channel (model's
    internal thinking) — only the 'final' channel reaches users.
    Chat template uses reasoning_effort='low' to keep thinking short."""

    @modal.enter()
    def load_model(self):
        import os, torch
        from transformers import AutoTokenizer, AutoModelForCausalLM
        from huggingface_hub import login

        hf_token = os.environ.get("HF_TOKEN")
        if hf_token:
            try: login(token=hf_token)
            except Exception: pass

        model_id = "openai/gpt-oss-20b"
        print(f"[lab/gptoss20b] loading {model_id}...", flush=True)
        self.tokenizer = AutoTokenizer.from_pretrained(
            model_id, cache_dir=f"{MODELS_DIR}/lab", token=hf_token,
        )
        self.model = AutoModelForCausalLM.from_pretrained(
            model_id,
            torch_dtype=torch.bfloat16,
            device_map="cuda",
            cache_dir=f"{MODELS_DIR}/lab",
            token=hf_token,
            attn_implementation="eager",   # SDPA not yet supported by GptOssForCausalLM
        )
        self.model.eval()
        print("[lab/gptoss20b] ready", flush=True)

    def _generate_once(self, prompt: str, max_tokens: int, temperature: float) -> str:
        return _llm_chat_generate(
            self.model, self.tokenizer, prompt, max_tokens, temperature,
            # gpt-oss specific: short thinking, then final answer
            template_kwargs={"reasoning_effort": "low"},
            post_process=_strip_gpt_oss_analysis,
        )

    @modal.method()
    def generate(self, prompt: str, max_tokens: int = 2048, temperature: float = 0.3) -> str:
        return self._generate_once(prompt, max_tokens, temperature)

    @modal.method()
    def generate_mapreduce(
        self,
        transcript_text: str,
        reduce_prompt: str,
        map_prompt: str,
        max_tokens: int = 4096,
        temperature: float = 0.3,
        window_chars: int = 12000,
    ) -> str:
        """Map-reduce генерация для длинных транскриптов (Privacy Mode, ISS-1).

        gpt-oss-20b в transformers поддерживает только eager attention —
        матрица внимания [heads × seq × seq] это O(n²) памяти. На 3-4ч
        транскрипте префилл пытается аллоцировать сотни ГБ → CUDA OOM.

        Лечение (модель-агностичное): транскрипт режется на окна
        ~window_chars, каждое сжимается в плотные заметки (map), финальный
        ответ генерируется по объединённым заметкам исходным шаблоном
        (reduce). Каждый отдельный контекст мал → нет O(n²) взрыва.

        reduce_prompt / map_prompt приходят из Flask готовыми, с
        MAPREDUCE_TEXT_SLOT на месте текста. Короткий транскрипт
        (≤ window_chars) идёт одним вызовом — поведение идентично generate().

        window_chars=12000 ≈ 8.5k токенов худшего случая (кириллица) —
        eager-матрица ~19ГБ transient, безопасно на L40S 48GB.
        """
        windows = _split_text_windows(transcript_text, window_chars)
        if len(windows) == 1:
            return self._generate_once(
                reduce_prompt.replace(MAPREDUCE_TEXT_SLOT, transcript_text),
                max_tokens, temperature,
            )

        print(f"[lab/gptoss20b] map-reduce: {len(transcript_text)} chars → "
              f"{len(windows)} windows", flush=True)
        t0 = time.time()
        notes: list[str] = []
        for k, win in enumerate(windows):
            part = self._generate_once(
                map_prompt.replace(MAPREDUCE_TEXT_SLOT, win),
                max_tokens=512, temperature=0.2,
            )
            notes.append(f"--- Part {k + 1}/{len(windows)} ---\n{part}")
            print(f"[lab/gptoss20b] map {k + 1}/{len(windows)} done "
                  f"({len(part)} chars, {time.time() - t0:.0f}s elapsed)", flush=True)
        combined = "\n\n".join(notes)

        # Заметки сами могут не влезть в безопасное окно (6-8ч записи) —
        # сжимаем рекурсивно тем же map-промптом.
        for _pass in range(3):
            if len(combined) <= window_chars:
                break
            re_windows = _split_text_windows(combined, window_chars)
            print(f"[lab/gptoss20b] collapse pass {_pass + 1}: "
                  f"{len(combined)} chars → {len(re_windows)} windows", flush=True)
            combined = "\n\n".join(
                self._generate_once(
                    map_prompt.replace(MAPREDUCE_TEXT_SLOT, w),
                    max_tokens=512, temperature=0.2,
                )
                for w in re_windows
            )
        # Последний рубеж против OOM: усечь, но не упасть
        if len(combined) > int(window_chars * 1.3):
            print(f"[lab/gptoss20b] notes still {len(combined)} chars after "
                  f"collapse — hard truncating", flush=True)
            combined = combined[: int(window_chars * 1.3)]

        return self._generate_once(
            reduce_prompt.replace(MAPREDUCE_TEXT_SLOT, combined),
            max_tokens, temperature,
        )


# ── External LLM (Gemini) ────────────────────────────────────────
#
# Лёгкая CPU-функция: тянет Gemini 2.5 Pro для длинных аналитических
# задач (summary / action items). Qwen на A10G справляется хуже —
# слабее на длинных контекстах и многомерной аналитике.
#
# Spawn-pattern такой же как у Transcriptor.run_llm: app.py делает
# .spawn() и сразу возвращает job_id фронту.

GEMINI_MODEL = "gemini-2.5-pro"
GEMINI_ENDPOINT = (
    f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent"
)


@app.function(
    image=web_image,            # тот же лёгкий CPU образ что и flask_app
    secrets=[hf_secret],        # GEMINI_API_KEY лежит в общем секрете
    timeout=600,                # до двух вызовов Gemini Pro (повтор при MAX_TOKENS)
    scaledown_window=60,
    min_containers=0,
)
def gemini_generate(prompt: str, max_output_tokens: int = 32768, temperature: float = 0.3) -> str:
    """Вызов Gemini 2.5 Pro REST API. Возвращает сгенерированный текст.
    Бросает RuntimeError с человекочитаемым сообщением при ошибке —
    оно проходит через Modal FunctionCall и доедет до фронта.

    maxOutputTokens у 2.5 Pro включает "thinking"-токены, а кириллица стоит
    ~1.5 символа на токен: длинное саммари на 8000 токенах обрывалось на
    полуслове. Поэтому thinking ограничен бюджетом, а при MAX_TOKENS —
    один повтор с максимальным лимитом модели.
    """
    import os
    import requests

    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY not configured")

    def call(limit: int) -> dict:
        body = {
            "contents": [{"role": "user", "parts": [{"text": prompt}]}],
            "generationConfig": {
                "temperature": temperature,
                "maxOutputTokens": limit,
                "thinkingConfig": {"thinkingBudget": 4096},
            },
        }
        try:
            return requests.post(GEMINI_ENDPOINT, params={"key": api_key}, json=body, timeout=280)
        except requests.RequestException as e:
            raise RuntimeError(f"gemini request failed: {e}") from e

    resp = call(max(max_output_tokens, 32768))
    if resp.status_code == 200:
        cand0 = (resp.json().get("candidates") or [{}])[0]
        if cand0.get("finishReason") == "MAX_TOKENS":
            print("[gemini_generate] hit MAX_TOKENS — retrying with 65536", flush=True)
            resp = call(65536)

    if resp.status_code != 200:
        # Gemini кладёт детали в JSON.error.message
        try:
            err = resp.json().get("error", {}).get("message") or resp.text[:300]
        except Exception:
            err = resp.text[:300]
        raise RuntimeError(f"gemini {resp.status_code}: {err}")

    data = resp.json()
    candidates = data.get("candidates") or []
    if not candidates:
        # Скорее всего сработал safety filter — детали в promptFeedback
        feedback = data.get("promptFeedback") or {}
        raise RuntimeError(f"gemini: no candidates (feedback={feedback})")

    cand = candidates[0]
    # finishReason: STOP / MAX_TOKENS / SAFETY / RECITATION / OTHER
    finish = cand.get("finishReason", "")
    parts = (cand.get("content") or {}).get("parts") or []
    text = "".join(p.get("text", "") for p in parts).strip()

    if not text:
        raise RuntimeError(f"gemini: empty response (finishReason={finish})")
    if finish == "MAX_TOKENS":
        print(f"[gemini_generate] still truncated at 65536 tokens ({len(text)} chars)", flush=True)

    return text


# ── Flask web endpoint ───────────────────────────────────────────
#
# Оборачиваем Flask-приложение в Modal как WSGI app. Получаем публичный
# URL вида https://razornne--transcriptor-v2-flask-app.modal.run
# Кастомный домен api.skriptly.io привязывается через Modal Dashboard.
#
# Контейнер лёгкий (CPU, без torch) — мгновенный cold start.
# Внутри Flask делает .spawn() в Transcriptor (см. app.py).

@app.function(
    image=web_image,
    # stripe_secret last so its STRIPE_* values override anything stale in
    # transcriptor-secrets from earlier --force runs (test-mode keys).
    secrets=[hf_secret, notion_secret, admin_secret, r2_secret, stripe_secret],
    timeout=900,                 # 15 min — почти все запросы моментальные через .spawn(),
                                 # но /api/lab/compare блокирует до завершения всех моделей
                                 # (3-5 мин cold start на A100 + до 60s генерации × N моделей)
    scaledown_window=60,         # держим тёплым 1 мин между запросами
    min_containers=0,            # скейл в ноль когда idle = бесплатно
)
@modal.wsgi_app()
def flask_app():
    """Публичный HTTP-endpoint. Flask внутри использует Modal SDK
    чтобы спавнить тяжёлый ML на отдельных GPU-контейнерах.
    """
    os.environ["USE_MODAL"] = "true"  # принудительно включаем Modal-режим
    from app import app as _flask
    return _flask
