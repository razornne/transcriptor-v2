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

import modal

# ── App + infrastructure ─────────────────────────────────────────

app = modal.App("transcriptor-v2")

# Persistent Volume — модели кэшируются между запусками.
# Первый запуск скачает всё (~12 GB), последующие грузят за секунды.
volume = modal.Volume.from_name("transcriptor-models", create_if_missing=True)
MODELS_DIR = "/models"

# Modal Secret с HF_TOKEN (создать: modal secret create transcriptor-secrets HF_TOKEN=hf_...)
hf_secret = modal.Secret.from_name("transcriptor-secrets")

# Образ контейнера — собирается один раз, кэшируется Modal'ом.
# Используем CUDA 12.4 base image чтобы libcublas.so.12 и libcudnn были
# доступны системно — без этого torch/ctranslate2 падают с "library not found".
image = (
    modal.Image.from_registry(
        "nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04",
        add_python="3.11",
    )
    .apt_install("ffmpeg")
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
        "transformers>=4.45.0",
        "accelerate",
        "bitsandbytes",
        "huggingface_hub",
        # Utils
        "numpy",
    )
    # Включаем локальный merger.py в образ — чистая Python-логика без GPU-deps
    .add_local_python_source("merger")
)

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
}


# ── Main class ───────────────────────────────────────────────────

@app.cls(
    gpu="A10G",           # 24 GB VRAM: whisper(3) + pyannote(2) + aya-8b-4bit(5) ≈ 10 GB
    image=image,
    volumes={MODELS_DIR: volume},
    secrets=[hf_secret],
    timeout=1200,                 # 20 мин макс (длинные созвоны)
    scaledown_window=300,         # держать тёплым 5 мин после последнего вызова
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

        # large-v3-turbo — дефолт в Modal: ~3-4x быстрее large-v3, качество сопоставимо.
        # Переопределить: WHISPER_MODEL=large-v3 в Modal Secrets или .env
        whisper_model = os.environ.get("WHISPER_MODEL", "large-v3-turbo")
        print(f"[modal] loading whisper {whisper_model}...", flush=True)
        self.whisper = WhisperModel(
            whisper_model,
            device="cuda",
            compute_type="float16",
            download_root=f"{MODELS_DIR}/whisper",
        )
        print("[modal] whisper ready", flush=True)

        print("[modal] loading pyannote/speaker-diarization-3.1...", flush=True)
        self.pyannote = Pipeline.from_pretrained(
            "pyannote/speaker-diarization-3.1",
            token=hf_token,
            cache_dir=f"{MODELS_DIR}/pyannote",
        )
        self.pyannote.to(torch.device("cuda"))
        print("[modal] pyannote ready", flush=True)

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
    ) -> list[dict]:
        """Полный пайплайн: webm → whisper → pyannote → merge → LLM correction.

        Принимает сырой WebM/Opus blob, конвертирует через ffmpeg внутри.
        Возвращает [{speaker, start, end, text}, ...].
        """
        import soundfile as sf
        import numpy as np
        import torch
        from merger import merge

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

            # --- Whisper ---
            lang_hint = _LANG_PROMPTS.get(language or "")
            if lang_hint and prompt:
                effective_prompt = f"{lang_hint} {prompt}"
            else:
                effective_prompt = lang_hint or prompt

            segments_iter, _ = self.whisper.transcribe(
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
            segments = [
                {
                    "start": s.start,
                    "end":   s.end,
                    "text":  s.text.strip(),
                    "words": [
                        {"start": w.start, "end": w.end, "word": w.word}
                        for w in (s.words or [])
                    ],
                }
                for s in segments_iter
                if s.text.strip()
            ]

            if not segments:
                return []

            # --- Pyannote ---
            waveform, sample_rate = sf.read(wav_path, dtype="float32", always_2d=True)
            waveform = waveform.T  # (channels, time)
            audio_input = {
                "waveform": torch.from_numpy(np.ascontiguousarray(waveform)),
                "sample_rate": sample_rate,
            }
            kwargs = {}
            if num_speakers:
                kwargs["num_speakers"] = num_speakers

            result = self.pyannote(audio_input, **kwargs)
            annotation = result.speaker_diarization
            speaker_turns = [
                {"start": turn.start, "end": turn.end, "speaker": speaker}
                for turn, _, speaker in annotation.itertracks(yield_label=True)
            ]

            # --- Merge ---
            merged = merge(segments, speaker_turns)

            # --- LLM correction ---
            merged = self._correct_segments(merged, language)

            return merged

        finally:
            for p in (webm_path, wav_path):
                try:
                    os.remove(p)
                except OSError:
                    pass

    def _correct_segments(self, segments: list[dict], language: str | None) -> list[dict]:
        """LLM correction pass — только фонетические STT-ошибки."""
        if not segments:
            return segments

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
                    # Отклоняем: >40% изменение длины
                    if abs(len(text) - len(orig)) / max(len(orig), 1) > 0.4:
                        continue
                    # Отклоняем: латиница появилась в кириллическом тексте
                    orig_latin = sum(1 for c in orig  if c.isascii() and c.isalpha())
                    new_latin  = sum(1 for c in text  if c.isascii() and c.isalpha())
                    orig_cyr   = sum(1 for c in orig  if 'Ѐ' <= c <= 'ӿ')
                    if orig_cyr > len(orig) * 0.5 and new_latin > orig_latin + 1:
                        continue
                    corrected[batch_start + idx]["text"] = text

            except Exception as e:
                print(f"[modal] correction batch {batch_start // batch_size} failed: {e}", flush=True)

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
