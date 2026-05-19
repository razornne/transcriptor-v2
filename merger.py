"""Совмещение вывода Whisper (текст с таймингами) и pyannote (спикер-турны).

Алгоритм:
1. Для каждого Whisper-сегмента находим перекрывающийся pyannote-турн
   с наибольшим overlap → присваиваем этот speaker.
2. Smoothing (опционально): короткий сегмент (< SMOOTH_THRESHOLD_S),
   зажатый между двумя одинаковыми спикерами, переназначается на их
   спикера. По умолчанию отключено (0) — pyannote-3.1 достаточно точен.
   Включить можно через env SMOOTH_THRESHOLD_S=1.0 если нужно.
3. Склеиваем подряд идущие сегменты одного спикера в блоки.
"""
import os

# 0 = выключено (доверяем pyannote как есть). Любое >0 = порог в секундах.
SMOOTH_THRESHOLD_S = float(os.environ.get("SMOOTH_THRESHOLD_S", "0"))


def _overlap(a_start: float, a_end: float, b_start: float, b_end: float) -> float:
    """Длина пересечения двух интервалов (0 если не пересекаются)."""
    return max(0.0, min(a_end, b_end) - max(a_start, b_start))


def _assign_initial(transcript_segments: list[dict], speaker_turns: list[dict]) -> list[dict]:
    """Для каждого whisper-сегмента — speaker по максимальному overlap."""
    result = []
    for seg in transcript_segments:
        best_speaker = "SPEAKER_UNKNOWN"
        best_overlap = 0.0
        for turn in speaker_turns:
            ov = _overlap(seg["start"], seg["end"], turn["start"], turn["end"])
            if ov > best_overlap:
                best_overlap = ov
                best_speaker = turn["speaker"]
        result.append({
            "speaker": best_speaker,
            "start":   seg["start"],
            "end":     seg["end"],
            "text":    seg["text"],
        })
    return result


def _smooth(labeled: list[dict]) -> list[dict]:
    """Короткий сегмент, зажатый между двумя одинаковыми спикерами,
    переназначается на их спикера. Лечит мелкие ошибки диаризации.

    Управляется SMOOTH_THRESHOLD_S (env). 0 = выключено.
    """
    if SMOOTH_THRESHOLD_S <= 0 or len(labeled) < 3:
        return labeled

    for i in range(1, len(labeled) - 1):
        cur      = labeled[i]
        duration = cur["end"] - cur["start"]
        if duration >= SMOOTH_THRESHOLD_S:
            continue
        prev_sp = labeled[i - 1]["speaker"]
        next_sp = labeled[i + 1]["speaker"]
        if prev_sp == next_sp and prev_sp != cur["speaker"]:
            cur["speaker"] = prev_sp
    return labeled


def _merge_consecutive(labeled: list[dict]) -> list[dict]:
    """Склеиваем подряд идущие сегменты одного спикера."""
    if not labeled:
        return []
    merged = [labeled[0]]
    for seg in labeled[1:]:
        if seg["speaker"] == merged[-1]["speaker"]:
            merged[-1]["end"]   = seg["end"]
            merged[-1]["text"] += " " + seg["text"]
        else:
            merged.append(seg)
    return merged


def merge(transcript_segments: list[dict], speaker_turns: list[dict]) -> list[dict]:
    """transcript_segments: [{start, end, text}] от Whisper
       speaker_turns:       [{start, end, speaker}] от pyannote
       → [{speaker, start, end, text}]
    """
    if not transcript_segments:
        return []
    labeled = _assign_initial(transcript_segments, speaker_turns)
    labeled = _smooth(labeled)
    return _merge_consecutive(labeled)
