"""Транскрипция через локальную faster-whisper модель.

На RTX 3070 (8 GB VRAM) запускается medium-модель с float16 — ~3.5 GB VRAM,
скорость ~5x realtime. Качество для русско/украинской речи — хорошее.

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

# medium — оптимум для 8GB VRAM с pyannote вместе (~3.5 GB).
# Конфликт cuDNN между PyTorch и CTranslate2 на Windows решён заменой
# торчового cuDNN 9.1 на 9.22 в venv/Lib/site-packages/torch/lib/ (см. README).
MODEL_SIZE   = os.environ.get("WHISPER_MODEL", "medium")
DEVICE       = os.environ.get("WHISPER_DEVICE", "cuda")
COMPUTE_TYPE = os.environ.get("WHISPER_COMPUTE", "float16")

_model = None


def _get_model() -> WhisperModel:
    global _model
    if _model is None:
        _model = WhisperModel(MODEL_SIZE, device=DEVICE, compute_type=COMPUTE_TYPE)
    return _model


def transcribe(path: str, language: str | None = None, prompt: str | None = None) -> list[dict]:
    """Возвращает список сегментов: [{start, end, text}, ...]

    start/end — секунды от начала аудио (float).
    Используем встроенный VAD-фильтр faster-whisper, он отсекает тишину
    и сокращает галлюцинации.
    """
    model = _get_model()
    segments_iter, _info = model.transcribe(
        path,
        language=language,
        initial_prompt=prompt,
        beam_size=5,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 500},
    )
    return [
        {"start": s.start, "end": s.end, "text": s.text.strip()}
        for s in segments_iter
        if s.text.strip()
    ]
