"""Транскрипция через локальную faster-whisper модель.

Дефолт — large-v3, float16. На RTX 3070 (8 GB VRAM) занимает ~3 GB,
вместе с pyannote (~2 GB) свободно помещается. Качество на UA/RU
заметно лучше medium, особенно на именах/терминах и сложной интонации.

ENV-override через WHISPER_MODEL=large-v3-turbo/medium/... если нужно
быстрее или экономнее по VRAM.

Если запустить с device='cpu' — работать будет, но медленнее в ~10 раз.
"""
import os
import sys

# CTranslate2 (внутри faster-whisper) ищет cuDNN/cuBLAS DLL по системному
# поиску, а pip-пакеты nvidia-cudnn-cu12 / nvidia-cublas-cu12 кладут их
# внутрь site-packages. Явно добавляем эти директории в DLL-search-path
# ДО импорта faster-whisper.
if sys.platform == "win32":
    _site = os.path.join(sys.prefix, "Lib", "site-packages", "nvidia")
    for sub in ("cudnn", "cublas", "cuda_nvrtc"):
        bin_dir = os.path.join(_site, sub, "bin")
        if os.path.isdir(bin_dir):
            os.add_dll_directory(bin_dir)

from faster_whisper import WhisperModel

# large-v3 — дефолт ради качества. На 8GB VRAM влезает вместе с pyannote.
# Конфликт cuDNN между PyTorch и CTranslate2 на Windows решён заменой
# торчового cuDNN 9.1 на 9.22 в venv/Lib/site-packages/torch/lib/ (см. README).
MODEL_SIZE   = os.environ.get("WHISPER_MODEL", "large-v3")
DEVICE       = os.environ.get("WHISPER_DEVICE", "cuda")
COMPUTE_TYPE = os.environ.get("WHISPER_COMPUTE", "float16")

# Внутренние промпты по языку. Whisper воспринимает initial_prompt как
# предшествующий транскрипт — пишем как живую речь, не как инструкцию.
# Это прайминг: правильный алфавит, пунктуация, лексика домена.
# Пользовательский контекст (если придёт) добавляется ПОСЛЕ через пробел.
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

_model = None


def _get_model() -> WhisperModel:
    global _model
    if _model is None:
        print(f"[whisper] loading {MODEL_SIZE} on {DEVICE}/{COMPUTE_TYPE}…", flush=True)
        _model = WhisperModel(MODEL_SIZE, device=DEVICE, compute_type=COMPUTE_TYPE)
        print(f"[whisper] ready", flush=True)
    return _model


def transcribe(path: str, language: str | None = None, prompt: str | None = None) -> list[dict]:
    """Возвращает список сегментов: [{start, end, text}, ...]

    Параметры подобраны для максимального качества на русском/украинском:
    - beam_size=5, best_of=5: точнее декодирование
    - temperature с fallback: на неуверенных кусках Whisper повышает T
      и пробует снова — снижает галлюцинации и повторы
    - compression_ratio_threshold=2.4: отбрасывает сегменты с подозрительной
      компрессией (типичный признак галлюцинации — повторяющийся мусор)
    - log_prob_threshold=-1.0: отбрасывает сегменты с низкой уверенностью
    - no_speech_threshold=0.6: чувствительный детектор тишины
    - condition_on_previous_text=True: использует контекст предыдущих сегментов
    - vad_filter + параметры: Silero VAD отсекает тишину, speech_pad_ms не
      срезает начало/конец слов, threshold=0.45 чуть мягче дефолта (0.5)
    - initial_prompt: внутренний языковой прайминг + пользовательский контекст
    """
    # Собираем effective_prompt: языковой якорь + пользовательский контекст
    lang_hint = _LANG_PROMPTS.get(language or "")
    if lang_hint and prompt:
        effective_prompt = f"{lang_hint} {prompt}"
    else:
        effective_prompt = lang_hint or prompt  # один из них или None

    model = _get_model()
    segments_iter, _info = model.transcribe(
        path,
        language=language,
        initial_prompt=effective_prompt,
        beam_size=5,
        best_of=5,
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
    )
    return [
        {"start": s.start, "end": s.end, "text": s.text.strip()}
        for s in segments_iter
        if s.text.strip()
    ]
