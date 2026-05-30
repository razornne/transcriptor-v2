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
    # Включаем локальный merger.py в образ — чистая Python-логика без GPU-deps
    .add_local_python_source("merger")
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
    )
    .add_local_python_source("app")
    # Шаблон index.html и статика подгружаются как файлы (Flask их ищет рядом с app.py)
    .add_local_dir("templates", remote_path="/root/templates")
)

# Лёгкий CPU образ для оркестратора длинных записей (transcribe_long).
# Режет аудио (ffmpeg), фанит GPU-воркеров transcribe_chunk, глобально
# кластеризует спикеров (scikit-learn) и сшивает. Без torch/CUDA — дёшево,
# почти всё время ждёт GPU-воркеров (I/O bound).
orchestrator_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg")
    .pip_install(
        "soundfile",
        "numpy",
        "scikit-learn",
    )
)

# Длина чанка для длинных записей (сек). 1200 = 20 мин — каждый чанк-джоб
# укладывается в таймаут Transcriptor (1200с) с большим запасом.
CHUNK_LEN_S = int(os.environ.get("CHUNK_LEN_S", "1200"))
# Порог cosine-расстояния для глобальной кластеризации спикеров между чанками.
# ~0.7 типично для wespeaker-эмбеддингов. Меньше → больше спикеров (дробит),
# больше → меньше (сливает). Используется только если num_speakers не задан.
GLOBAL_SPK_THRESHOLD = float(os.environ.get("GLOBAL_SPK_THRESHOLD", "0.7"))

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
}

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
    timeout=1200,                 # 20 мин макс (длинные созвоны)
    scaledown_window=300,         # держать тёплым 5 мин после последнего вызова
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
    ) -> dict:
        """Полный пайплайн: webm → whisper → pyannote → merge → LLM correction.

        privacy_mode=True forces correction through the local Qwen 7B path
        (no Gemini API call). Set by Privacy Mode users on Max/Team plans.

        Принимает сырой WebM/Opus blob, конвертирует через ffmpeg внутри.
        Возвращает dict:
          { "segments": [{speaker, start, end, text}, ...],
            "vocab_additions": [term1, term2, ...] }

        progress_key: если задан, пишем этапы в modal.Dict progress_store
        чтобы фронт видел реальный прогресс.
        Этапы: "convert" → "transcribe" → "diarize" → "merge" → "correct"

        quality: "fast" (large-v3-turbo, default) | "best" (large-v3).
        Best качество доступно только для Max-юзеров (проверяется в Flask).
        """
        import soundfile as sf
        import numpy as np
        import torch
        from merger import merge

        def _report(stage: str):
            if progress_key:
                try:
                    progress_store[progress_key] = {"stage": stage, "ts": time.time()}
                    print(f"[modal] progress → {stage}", flush=True)
                except Exception as _e:
                    print(f"[modal] progress report failed: {_e}", flush=True)

        # WebM → WAV (16kHz mono)
        webm_fd, webm_path = tempfile.mkstemp(suffix=".webm")
        wav_fd,  wav_path  = tempfile.mkstemp(suffix=".wav")
        os.close(webm_fd); os.close(wav_fd)

        try:
            with open(webm_path, "wb") as f:
                f.write(audio_bytes)

            subprocess.run(
                ["ffmpeg", "-y", "-i", webm_path, "-ar", "16000", "-ac", "1", wav_path],
                check=True, capture_output=True,
            )
            _report("convert")  # ffmpeg done — warmup + decode complete

            # --- Whisper ---
            lang_hint = _LANG_PROMPTS.get(language or "")
            if lang_hint and prompt:
                effective_prompt = f"{lang_hint} {prompt}"
            else:
                effective_prompt = lang_hint or prompt

            # Best quality для Max — large-v3 (~3x медленнее, +15-20% качества на UA/RU)
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
                condition_on_previous_text=True,
                vad_filter=True,
                vad_parameters={
                    "threshold": 0.45,
                    "min_silence_duration_ms": 500,
                    "speech_pad_ms": 200,
                },
                word_timestamps=True,  # для word-level alignment в merger
            )
            # Кастуем к нативным Python типам — faster-whisper иногда возвращает
            # numpy.float32 для start/end, и Modal/cbor2 на стороне Flask-контейнера
            # без numpy падает с "Deserialization failed because 'numpy' is not available".
            segments = [
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
            _report("transcribe")  # whisper done

            if not segments:
                return {"segments": [], "vocab_additions": []}

            # --- Pyannote ---
            waveform, sample_rate = sf.read(wav_path, dtype="float32", always_2d=True)
            waveform = waveform.T  # (channels, time)
            audio_input = {
                "waveform": torch.from_numpy(np.ascontiguousarray(waveform)),
                "sample_rate": sample_rate,
            }
            kwargs = {}
            if num_speakers:
                # Юзер задал точное число — pyannote делает constrained clustering,
                # качество резко лучше. Особенно для 2-3 спикеров.
                kwargs["num_speakers"] = num_speakers
            else:
                # Bounds на пространство поиска — помогает кластеризации не
                # фрагментировать одного спикера на несколько и не сливать
                # двух в одного. 1..6 покрывает 95% реальных созвонов.
                kwargs["min_speakers"] = 1
                kwargs["max_speakers"] = 6

            result = self.pyannote(audio_input, **kwargs)
            annotation = result.speaker_diarization
            speaker_turns = [
                {"start": float(turn.start), "end": float(turn.end), "speaker": str(speaker)}
                for turn, _, speaker in annotation.itertracks(yield_label=True)
            ]
            _report("diarize")  # pyannote done

            # --- Merge ---
            merged = merge(segments, speaker_turns)
            # На случай если merger пропустил numpy типы — финальная нормализация
            for m in merged:
                m["start"]   = float(m["start"])
                m["end"]     = float(m["end"])
                m["speaker"] = str(m["speaker"])
            _report("merge")  # merge done

            # --- LLM correction ---
            merged, vocab_additions = self._correct_segments(merged, language, privacy_mode=privacy_mode)

            # После Gemini boundary-fix соседние сегменты могут оказаться
            # одного спикера — склеиваем заново.
            re_merged: list[dict] = []
            for seg in merged:
                if re_merged and re_merged[-1]["speaker"] == seg["speaker"]:
                    re_merged[-1]["end"]   = seg["end"]
                    re_merged[-1]["text"] += " " + seg["text"]
                else:
                    re_merged.append(dict(seg))
            merged = re_merged
            _report("correct")  # LLM correction done

            return {"segments": merged, "vocab_additions": vocab_additions}

        finally:
            for p in (webm_path, wav_path):
                try:
                    os.remove(p)
                except OSError:
                    pass

    # ── Chunked transcription (long recordings) ──────────────────

    @modal.method()
    def transcribe_chunk(
        self,
        wav_bytes: bytes,
        language: str | None,
        prompt: str | None = None,
        quality: str = "fast",
        privacy_mode: bool = False,
    ) -> dict:
        """Обрабатывает ОДИН чанк длинной записи (для transcribe_long).

        Принимает уже сконвертированный 16kHz mono WAV — оркестратор делает
        ffmpeg один раз на весь файл и режет на куски. В отличие от
        transcribe_full:
          • не форсит num_speakers (в чанке может быть меньше спикеров) —
            всегда bounds 1..6, глобальное число применяется при кластеризации;
          • дополнительно возвращает centroid-эмбеддинги каждого ЛОКАЛЬНОГО
            спикера, чтобы оркестратор глобально сшил спикеров между чанками;
          • таймстемпы chunk-relative (оркестратор сам добавит offset).

        Returns:
          { "segments": [{speaker, start, end, text}, ...],   # chunk-relative
            "embeddings": {"SPEAKER_00": [float, ...], ...},
            "vocab_additions": [term, ...] }
        """
        import soundfile as sf
        import numpy as np
        import torch
        from merger import merge

        wav_fd, wav_path = tempfile.mkstemp(suffix=".wav")
        os.close(wav_fd)
        try:
            with open(wav_path, "wb") as f:
                f.write(wav_bytes)

            # --- Whisper (те же параметры что в transcribe_full) ---
            lang_hint = _LANG_PROMPTS.get(language or "")
            if lang_hint and prompt:
                effective_prompt = f"{lang_hint} {prompt}"
            else:
                effective_prompt = lang_hint or prompt

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
                condition_on_previous_text=True,
                vad_filter=True,
                vad_parameters={
                    "threshold": 0.45,
                    "min_silence_duration_ms": 500,
                    "speech_pad_ms": 200,
                },
                word_timestamps=True,
            )
            segments = [
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
            if not segments:
                return {"segments": [], "embeddings": {}, "vocab_additions": []}

            # --- Pyannote (bounds 1..6, без форсинга num_speakers) ---
            waveform, sample_rate = sf.read(wav_path, dtype="float32", always_2d=True)
            waveform = waveform.T  # (channels, time)
            audio_input = {
                "waveform": torch.from_numpy(np.ascontiguousarray(waveform)),
                "sample_rate": sample_rate,
            }
            result = self.pyannote(audio_input, min_speakers=1, max_speakers=6)
            annotation = result.speaker_diarization
            speaker_turns = [
                {"start": float(turn.start), "end": float(turn.end), "speaker": str(speaker)}
                for turn, _, speaker in annotation.itertracks(yield_label=True)
            ]

            # Centroid-эмбеддинги локальных спикеров (для глобального сшивания)
            embeddings = self._speaker_centroids(wav_path, annotation)

            # --- Merge ---
            merged = merge(segments, speaker_turns)
            for m in merged:
                m["start"]   = float(m["start"])
                m["end"]     = float(m["end"])
                m["speaker"] = str(m["speaker"])

            # --- LLM correction (per-chunk; ~20мин транскрипт влезает в 1 Gemini-вызов) ---
            merged, vocab_additions = self._correct_segments(merged, language, privacy_mode=privacy_mode)

            # Re-merge соседних сегментов одного спикера после boundary-fix
            re_merged: list[dict] = []
            for seg in merged:
                if re_merged and re_merged[-1]["speaker"] == seg["speaker"]:
                    re_merged[-1]["end"]   = seg["end"]
                    re_merged[-1]["text"] += " " + seg["text"]
                else:
                    re_merged.append(dict(seg))

            return {
                "segments": re_merged,
                "embeddings": embeddings,
                "vocab_additions": vocab_additions,
            }
        finally:
            try:
                os.remove(wav_path)
            except OSError:
                pass

    def _speaker_centroids(self, wav_path: str, annotation) -> dict:
        """Считает усреднённый embedding (centroid) каждого локального спикера.

        Кропаем аудио по самым длинным сегментам спикера и усредняем
        embedding'и. Возвращает {label: list[float]} (нативные Python float —
        Flask-контейнер без numpy не десериализует numpy типы).
        Версионно-независимо: не полагается на pyannote return_embeddings.
        """
        import numpy as np

        if self.embedding_inference is None:
            return {}

        centroids: dict[str, list[float]] = {}
        for label in annotation.labels():
            timeline = annotation.label_timeline(label)
            segs = sorted(timeline, key=lambda s: s.duration, reverse=True)
            vecs = []
            for seg in segs[:10]:  # топ-10 самых длинных сегментов спикера
                if seg.duration < 0.5:  # слишком короткие — embedding нестабилен
                    continue
                try:
                    emb = self.embedding_inference.crop(wav_path, seg)
                    vecs.append(np.asarray(emb, dtype="float32").reshape(-1))
                except Exception as e:
                    print(f"[modal] embedding crop failed for {label}: {e}", flush=True)
                    continue
            if vecs:
                centroid = np.mean(np.stack(vecs), axis=0)
                centroids[label] = [float(x) for x in centroid]
        return centroids

    def _correct_segments(self, segments: list[dict], language: str | None,
                          privacy_mode: bool = False) -> tuple[list[dict], list[str]]:
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
                result = self._correct_segments_gemini(segments, language)
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

    def _correct_segments_gemini(self, segments: list[dict], language: str | None) -> tuple[list[dict], list[str]] | None:
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

        # Format: "N. [SPEAKER_XX] text"
        lines = [
            f"{i + 1}. [{seg['speaker']}] {seg['text']}"
            for i, seg in enumerate(segments)
        ]
        lines_in = "\n".join(lines)

        prompt = (
            f"{instruction}\n\n"
            "Below is a numbered, speaker-diarized transcript. Each line is:\n"
            "  N. [SPEAKER_XX] text\n\n"
            "Your tasks (in this order of importance):\n"
            "1. Fix obvious phonetic STT errors using world knowledge:\n"
            "   - Acronyms transliterated wrong (e.g. рдух → ADHD, СДВГ; стіарар → CTR)\n"
            "   - Misrecognized names of people, brands, products\n"
            "   - Technical terms broken by phonetic recognition\n"
            "2. Boundary fix: if you see a phrase clearly belonging to the NEXT or PREVIOUS speaker\n"
            "   (e.g. an answer's first words attached to the question), move those 1-5 words\n"
            "   across the speaker boundary. ONLY when grammar and semantics give clear evidence.\n\n"
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
        body = {
            "contents": [{"role": "user", "parts": [{"text": prompt}]}],
            "generationConfig": {
                "temperature": 0.1,
                "maxOutputTokens": min(32000, max(2000, len(lines_in) * 2)),
            },
        }

        try:
            resp = requests.post(endpoint, params={"key": api_key}, json=body, timeout=180)
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
        vocab_additions: list[str] = []
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
                # Извлекаем терминологию для персонального словаря
                vocab_additions.extend(self._extract_vocab_terms(orig_text, new_text))
                corrected[idx]["text"] = new_text
                changes_count += 1
            # Speaker reassignment (boundary fix)
            if new_speaker in original_speakers and new_speaker != orig["speaker"]:
                corrected[idx]["speaker"] = new_speaker
                speaker_changes += 1

        # Дедуплицируем словарные термины (сохраняем порядок появления)
        seen: set[str] = set()
        unique_vocab: list[str] = []
        for t in vocab_additions:
            key = t.lower()
            if key not in seen:
                seen.add(key)
                unique_vocab.append(t)

        print(
            f"[modal] gemini corrected {changes_count} texts, "
            f"reassigned {speaker_changes} segments, "
            f"vocab+{len(unique_vocab)} ({', '.join(unique_vocab[:8])}) "
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
    """Планирует границы чанков ~CHUNK_LEN_S, привязывая разрезы к ближайшим
    точкам тишины (чтобы не резать посреди слова). Фоллбэк — жёсткий рез.
    """
    if duration <= CHUNK_LEN_S * 1.5:
        return [(0.0, duration)]

    sil_mids = [(s + e) / 2 for s, e in silences]
    window = max(120.0, CHUNK_LEN_S * 0.25)  # окно поиска тишины вокруг цели
    cuts: list[float] = []
    target = float(CHUNK_LEN_S)
    while target < duration - CHUNK_LEN_S * 0.5:
        floor = (cuts[-1] if cuts else 0.0) + 60.0  # минимум 60с от прошлого реза
        candidates = [m for m in sil_mids if abs(m - target) < window and m > floor]
        cut = min(candidates, key=lambda m: abs(m - target)) if candidates else target
        cuts.append(cut)
        target = cut + CHUNK_LEN_S

    points = [0.0] + cuts + [duration]
    return [(points[i], points[i + 1]) for i in range(len(points) - 1)]


@app.function(
    image=orchestrator_image,
    secrets=[hf_secret],
    timeout=7200,                # 2ч с запасом — оркестратор почти всё время ждёт GPU
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
) -> dict:
    """Оркестратор длинных записей. Контракт ответа = transcribe_full:
      { "segments": [{speaker, start, end, text}, ...], "vocab_additions": [...] }
    """
    import soundfile as sf
    import numpy as np

    def _progress(**kw):
        if not progress_key:
            return
        try:
            progress_store[progress_key] = {**kw, "ts": time.time()}
            print(f"[long] progress → {kw}", flush=True)
        except Exception as e:
            print(f"[long] progress report failed: {e}", flush=True)

    src_fd, src_path = tempfile.mkstemp(suffix=".bin")
    wav_fd, wav_path = tempfile.mkstemp(suffix=".wav")
    os.close(src_fd); os.close(wav_fd)
    chunk_paths: list[str] = []
    try:
        with open(src_path, "wb") as f:
            f.write(audio_bytes)

        # 1. Декод полного аудио → 16k mono wav (на диск, не в RAM)
        _progress(stage="convert")
        subprocess.run(
            ["ffmpeg", "-y", "-i", src_path, "-ar", "16000", "-ac", "1", wav_path],
            check=True, capture_output=True,
        )
        duration = float(sf.info(wav_path).duration)

        # 2. Silence-aware split
        _progress(stage="split")
        sil_proc = subprocess.run(
            ["ffmpeg", "-i", wav_path, "-af", "silencedetect=noise=-30dB:d=0.5", "-f", "null", "-"],
            capture_output=True, text=True,
        )
        silences = _parse_silences(sil_proc.stderr)
        boundaries = _plan_chunk_boundaries(duration, silences)
        n = len(boundaries)
        print(f"[long] duration={duration:.0f}s → {n} chunks (silences={len(silences)})", flush=True)

        # 3. Фан-аут: извлекаем чанк и сразу спавним воркер (память — один чанк за раз)
        _progress(stage="processing", chunks_total=n, chunks_done=0)
        calls = []
        for i, (start, end) in enumerate(boundaries):
            ch_fd, ch_path = tempfile.mkstemp(suffix=f".chunk{i}.wav")
            os.close(ch_fd)
            chunk_paths.append(ch_path)
            # -ss/-t (не -to): -t = длительность, однозначно во всех версиях
            # ffmpeg (в отличие от -to, который может быть абсолютным/относительным).
            subprocess.run(
                ["ffmpeg", "-y", "-ss", str(start), "-t", str(end - start),
                 "-i", wav_path, "-ar", "16000", "-ac", "1", ch_path],
                check=True, capture_output=True,
            )
            with open(ch_path, "rb") as f:
                chunk_bytes = f.read()
            call = Transcriptor().transcribe_chunk.spawn(
                chunk_bytes, language, prompt, quality, privacy_mode,
            )
            calls.append((i, start, call))

        # 4. Сбор результатов (чанки крутятся параллельно на Modal)
        results: list[tuple[float, dict]] = [None] * n  # type: ignore
        done = 0
        for i, start, call in calls:
            res = call.get()
            results[i] = (start, res)
            done += 1
            _progress(stage="processing", chunks_total=n, chunks_done=done)

        # 5. Глобальная кластеризация спикеров по centroid-эмбеддингам
        _progress(stage="merge")
        items: list[tuple[int, str]] = []   # (chunk_idx, local_label)
        vecs: list[list[float]] = []
        for i, (_start, res) in enumerate(results):
            for label, vec in (res.get("embeddings") or {}).items():
                if vec:
                    items.append((i, label))
                    vecs.append(vec)

        label_map: dict[tuple[int, str], int] = {}
        if len(vecs) == 1:
            label_map = {items[0]: 0}
        elif len(vecs) >= 2:
            from sklearn.cluster import AgglomerativeClustering
            X = np.stack([np.asarray(v, dtype="float64") for v in vecs])
            if num_speakers and num_speakers >= 1:
                k = min(num_speakers, len(vecs))
                clusterer = AgglomerativeClustering(
                    n_clusters=k, metric="cosine", linkage="average",
                )
            else:
                clusterer = AgglomerativeClustering(
                    n_clusters=None, distance_threshold=GLOBAL_SPK_THRESHOLD,
                    metric="cosine", linkage="average",
                )
            cluster_ids = clusterer.fit_predict(X)
            label_map = {items[k]: int(cluster_ids[k]) for k in range(len(items))}
        if not vecs:
            print("[long] no speaker embeddings — falling back to per-chunk labels", flush=True)

        # 6. Стич: offset таймстемпов + релейбл local→global + сорт по времени
        all_segs: list[dict] = []
        for i, (start, res) in enumerate(results):
            for seg in (res.get("segments") or []):
                cluster = label_map.get((i, seg["speaker"]))
                # Фоллбэк если эмбеддинга не было — уникальный per-chunk лейбл
                key = cluster if cluster is not None else f"c{i}_{seg['speaker']}"
                all_segs.append({
                    "start": float(seg["start"]) + start,
                    "end":   float(seg["end"]) + start,
                    "text":  seg["text"],
                    "_k":    key,
                })
        all_segs.sort(key=lambda s: s["start"])

        # Глобальная нумерация спикеров по времени первого появления
        order: dict = {}
        for s in all_segs:
            if s["_k"] not in order:
                order[s["_k"]] = len(order)

        # 7. Re-merge соседних сегментов одного (глобального) спикера
        final: list[dict] = []
        for s in all_segs:
            spk = f"SPEAKER_{order[s['_k']]:02d}"
            if final and final[-1]["speaker"] == spk:
                final[-1]["end"]   = s["end"]
                final[-1]["text"] += " " + s["text"]
            else:
                final.append({"speaker": spk, "start": s["start"], "end": s["end"], "text": s["text"]})

        # 8. Агрегируем vocab_additions (дедуп по lower-case)
        vocab: list[str] = []
        seen: set[str] = set()
        for _i, (_start, res) in enumerate(results):
            for t in (res.get("vocab_additions") or []):
                if t.lower() not in seen:
                    seen.add(t.lower())
                    vocab.append(t)

        _progress(stage="correct", chunks_total=n, chunks_done=n)
        print(f"[long] done: {len(final)} segments, {len(order)} speakers, vocab+{len(vocab)}", flush=True)
        return {"segments": final, "vocab_additions": vocab}

    finally:
        for p in [src_path, wav_path, *chunk_paths]:
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

@app.cls(
    image=image,
    gpu="A10G",                  # 9B in int4 ~5GB — easily fits A10G's 24GB
    volumes={MODELS_DIR: volume},
    secrets=[hf_secret],
    timeout=600,
    scaledown_window=120,
    min_containers=0,
)
class LabMamayLM9B:
    """MamayLM — Ukrainian-focused fine-tune of Google Gemma 2 9B.
    Built specifically for ru/uk; expected to outperform generic models
    on Cyrillic analytical tasks despite being much smaller (9B vs 32B).

    Note: requires accepting Gemma 2 license on HuggingFace before
    HF_TOKEN can download. Set MAMAY_MODEL_ID env var to override the
    repo if the default doesn't match the actual release name."""

    @modal.enter()
    def load_model(self):
        import os, torch
        from transformers import AutoTokenizer, AutoModelForCausalLM, BitsAndBytesConfig
        from huggingface_hub import login

        hf_token = os.environ.get("HF_TOKEN")
        if hf_token:
            try: login(token=hf_token)
            except Exception: pass

        # Default repo guess — verify against HF or override via env
        model_id = os.environ.get(
            "MAMAY_MODEL_ID",
            "INSAIT-Institute/MamayLM-Gemma-2-9B-IT-v0.1",
        )
        print(f"[lab/mamaylm] loading {model_id}...", flush=True)
        bnb = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_compute_dtype=torch.float16,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_use_double_quant=True,
        )
        self.tokenizer = AutoTokenizer.from_pretrained(
            model_id, cache_dir=f"{MODELS_DIR}/lab", token=hf_token,
        )
        self.model = AutoModelForCausalLM.from_pretrained(
            model_id,
            quantization_config=bnb,
            device_map="cuda",
            cache_dir=f"{MODELS_DIR}/lab",
            token=hf_token,
            attn_implementation="sdpa",
        )
        self.model.eval()
        print("[lab/mamaylm] ready", flush=True)

    @modal.method()
    def generate(self, prompt: str, max_tokens: int = 2048, temperature: float = 0.3) -> str:
        return _llm_chat_generate(self.model, self.tokenizer, prompt, max_tokens, temperature)


@app.cls(
    image=image,
    gpu="L40S",                  # 48GB needed: 12GB model + eager-attn O(n²) on long ctx
    volumes={MODELS_DIR: volume},
    secrets=[hf_secret],
    timeout=600,
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

    @modal.method()
    def generate(self, prompt: str, max_tokens: int = 2048, temperature: float = 0.3) -> str:
        return _llm_chat_generate(
            self.model, self.tokenizer, prompt, max_tokens, temperature,
            # gpt-oss specific: short thinking, then final answer
            template_kwargs={"reasoning_effort": "low"},
            post_process=_strip_gpt_oss_analysis,
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
    timeout=300,                # Gemini Pro на длинном контексте ~30-120с
    scaledown_window=60,
    min_containers=0,
)
def gemini_generate(prompt: str, max_output_tokens: int = 8000, temperature: float = 0.3) -> str:
    """Вызов Gemini 2.5 Pro REST API. Возвращает сгенерированный текст.
    Бросает RuntimeError с человекочитаемым сообщением при ошибке —
    оно проходит через Modal FunctionCall и доедет до фронта.
    """
    import os
    import requests

    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY not configured")

    body = {
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {
            "temperature": temperature,
            "maxOutputTokens": max_output_tokens,
        },
    }

    try:
        resp = requests.post(
            GEMINI_ENDPOINT,
            params={"key": api_key},
            json=body,
            timeout=240,
        )
    except requests.RequestException as e:
        raise RuntimeError(f"gemini request failed: {e}") from e

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
    secrets=[hf_secret, notion_secret, admin_secret, stripe_secret],
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
