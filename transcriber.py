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
    - beam_size=5: лучше чем дефолт, аккуратнее декодирование
    - temperature: список с fallback. На неуверенных кусках Whisper повышает T
      и пробует снова — снижает галлюцинации и повторы
    - compression_ratio_threshold=2.4: отбрасывает сегменты с подозрительной
      компрессией (типичный признак галлюцинации — повторяющийся мусор)
    - log_prob_threshold=-1.0: отбрасывает сегменты с низкой уверенностью
    - no_speech_threshold=0.6: чувствительный детектор тишины
    - condition_on_previous_text=True: использует контекст предыдущих сегментов
      для согласованности (полезно для имён, терминов)
    - vad_filter: Silero VAD отсекает тишину до Whisper'а
    """
    model = _get_model()
    segments_iter, _info = model.transcribe(
        path,
        language=language,
        initial_prompt=prompt,
        beam_size=5,
        best_of=5,
        temperature=(0.0, 0.2, 0.4, 0.6, 0.8, 1.0),
        compression_ratio_threshold=2.4,
        log_prob_threshold=-1.0,
        no_speech_threshold=0.6,
        condition_on_previous_text=True,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 500},
    )
    return [
        {"start": s.start, "end": s.end, "text": s.text.strip()}
        for s in segments_iter
        if s.text.strip()
    ]
