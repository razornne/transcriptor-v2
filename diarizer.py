"""Диаризация (определение кто говорит когда) через pyannote-3.1.

Требует HF_TOKEN в окружении и принятия условий модели на HuggingFace:
https://huggingface.co/pyannote/speaker-diarization-3.1

На RTX 3070 ~2 GB VRAM, скорость ~0.1x realtime на GPU
(1 час аудио = ~6 минут обработки).
На CPU работает, но в ~10 раз медленнее.
"""
import os
import numpy as np
import soundfile as sf
import torch
from pyannote.audio import Pipeline

_pipeline = None


def _get_pipeline() -> Pipeline:
    global _pipeline
    if _pipeline is None:
        token = os.environ.get("HF_TOKEN")
        if not token:
            raise RuntimeError(
                "HF_TOKEN env var required. Get one at https://huggingface.co/settings/tokens "
                "and accept terms at https://huggingface.co/pyannote/speaker-diarization-3.1"
            )
        _pipeline = Pipeline.from_pretrained(
            "pyannote/speaker-diarization-3.1",
            token=token,
        )
        if torch.cuda.is_available():
            _pipeline.to(torch.device("cuda"))
    return _pipeline


def diarize(path: str, num_speakers: int | None = None) -> list[dict]:
    """Возвращает список speaker turns: [{start, end, speaker}, ...]

    speaker — строка вида "SPEAKER_00", "SPEAKER_01" и т.д.
    num_speakers — если знаем точное число участников, можно подсказать pyannote
    (улучшает качество). None = pyannote сам определит.
    """
    pipeline = _get_pipeline()
    kwargs = {}
    if num_speakers is not None:
        kwargs["num_speakers"] = num_speakers

    # Загружаем аудио в память сами (через soundfile), чтобы не зависеть от torchcodec
    # — на Windows со static-ffmpeg он не работает (см. README).
    waveform, sample_rate = sf.read(path, dtype="float32", always_2d=True)
    # soundfile отдаёт (time, channels); pyannote ждёт (channels, time)
    waveform = waveform.T
    audio_input = {
        "waveform": torch.from_numpy(np.ascontiguousarray(waveform)),
        "sample_rate": sample_rate,
    }

    # В pyannote 4.x pipeline() возвращает DiarizeOutput; сама диаризация — внутри.
    result = pipeline(audio_input, **kwargs)
    annotation = result.speaker_diarization

    return [
        {"start": turn.start, "end": turn.end, "speaker": speaker}
        for turn, _, speaker in annotation.itertracks(yield_label=True)
    ]
