"""Совмещение вывода Whisper (текст с таймингами) и pyannote (спикер-турны).

Алгоритм: для каждого Whisper-сегмента находим перекрывающийся pyannote-турн
с наибольшим overlap → присваиваем этот speaker. Соседние сегменты с одним
и тем же speaker склеиваем в один блок.
"""


def _overlap(a_start: float, a_end: float, b_start: float, b_end: float) -> float:
    """Длина пересечения двух интервалов (0 если не пересекаются)."""
    return max(0.0, min(a_end, b_end) - max(a_start, b_start))


def merge(transcript_segments: list[dict], speaker_turns: list[dict]) -> list[dict]:
    """
    transcript_segments: [{start, end, text}, ...] — от Whisper
    speaker_turns:       [{start, end, speaker}, ...] — от pyannote

    Возвращает: [{speaker, start, end, text}, ...]
    Соседние блоки одного спикера склеены.
    """
    if not transcript_segments:
        return []

    # Назначаем speaker каждому транскрипт-сегменту
    labeled = []
    for seg in transcript_segments:
        best_speaker = "SPEAKER_UNKNOWN"
        best_overlap = 0.0
        for turn in speaker_turns:
            ov = _overlap(seg["start"], seg["end"], turn["start"], turn["end"])
            if ov > best_overlap:
                best_overlap = ov
                best_speaker = turn["speaker"]
        labeled.append({
            "speaker": best_speaker,
            "start": seg["start"],
            "end": seg["end"],
            "text": seg["text"],
        })

    # Склеиваем подряд идущие сегменты с одинаковым speaker
    merged = [labeled[0]]
    for seg in labeled[1:]:
        if seg["speaker"] == merged[-1]["speaker"]:
            merged[-1]["end"] = seg["end"]
            merged[-1]["text"] += " " + seg["text"]
        else:
            merged.append(seg)

    return merged
