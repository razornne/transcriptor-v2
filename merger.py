"""Совмещение вывода Whisper (текст с таймингами) и pyannote (спикер-турны).

Алгоритм:
1. Если Whisper-сегменты содержат пословные таймстемпы (`words`) —
   режем каждый сегмент по словам в местах смены pyannote-спикера.
   Это позволяет правильно атрибутировать быстрый диалог типа
   "Менше одного? — Менше одного." когда Whisper склеил это в один сегмент.
2. Если слов нет — фоллбэк к сегментному уровню (как раньше).
3. Smoothing (опционально): короткий сегмент (< SMOOTH_THRESHOLD_S),
   зажатый между двумя одинаковыми спикерами, переназначается на их
   спикера. По умолчанию отключено (0) — pyannote-3.1 достаточно точен.
4. Склеиваем подряд идущие сегменты одного спикера в блоки.
"""
import os

# 0 = выключено (доверяем pyannote как есть). Любое >0 = порог в секундах.
SMOOTH_THRESHOLD_S = float(os.environ.get("SMOOTH_THRESHOLD_S", "0"))


def _overlap(a_start: float, a_end: float, b_start: float, b_end: float) -> float:
    """Длина пересечения двух интервалов (0 если не пересекаются)."""
    return max(0.0, min(a_end, b_end) - max(a_start, b_start))


def _best_speaker_for(start: float, end: float, turns: list[dict]) -> str:
    """Спикер с максимальным overlap по интервалу [start, end]."""
    best_speaker = "SPEAKER_UNKNOWN"
    best_overlap = 0.0
    for t in turns:
        ov = _overlap(start, end, t["start"], t["end"])
        if ov > best_overlap:
            best_overlap = ov
            best_speaker = t["speaker"]
    return best_speaker


def _assign_initial(transcript_segments: list[dict], speaker_turns: list[dict]) -> list[dict]:
    """Сегментный уровень (фоллбэк без пословных таймстемпов).
    Для каждого whisper-сегмента — speaker по максимальному overlap.
    """
    result = []
    for seg in transcript_segments:
        result.append({
            "speaker": _best_speaker_for(seg["start"], seg["end"], speaker_turns),
            "start":   seg["start"],
            "end":     seg["end"],
            "text":    seg["text"],
        })
    return result


def _split_by_speaker(transcript_segments: list[dict], speaker_turns: list[dict]) -> list[dict]:
    """Пословное разбиение: каждый Whisper-сегмент режется по словам
    в местах, где меняется pyannote-спикер. Лечит склейки быстрого диалога.

    Требует transcript_segments[i]["words"] = [{start, end, word}, ...].
    Если words нет — фоллбэк к сегментному уровню для этого сегмента.
    """
    result = []
    last_speaker = None  # для fallback при отсутствии overlap

    for seg in transcript_segments:
        words = seg.get("words") or []
        if not words:
            # Нет пословных данных — обрабатываем как один блок
            sp = _best_speaker_for(seg["start"], seg["end"], speaker_turns)
            result.append({
                "speaker": sp,
                "start":   seg["start"],
                "end":     seg["end"],
                "text":    seg["text"],
            })
            last_speaker = sp
            continue

        current = None  # текущая группа слов одного спикера
        for w in words:
            sp = _best_speaker_for(w["start"], w["end"], speaker_turns)
            # Если pyannote не нашёл овэрлапа — наследуем предыдущего спикера
            # (типично у первого/последнего слова сегмента у границы турна).
            if sp == "SPEAKER_UNKNOWN" and last_speaker is not None:
                sp = last_speaker

            if current is None or current["speaker"] != sp:
                if current is not None:
                    result.append(current)
                current = {
                    "speaker": sp,
                    "start":   w["start"],
                    "end":     w["end"],
                    "text":    w["word"].lstrip(),
                }
            else:
                current["end"]   = w["end"]
                current["text"] += w["word"]
            last_speaker = sp

        if current is not None:
            current["text"] = current["text"].strip()
            result.append(current)

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
    """transcript_segments: [{start, end, text, words?}] от Whisper
       speaker_turns:       [{start, end, speaker}] от pyannote
       → [{speaker, start, end, text}]

    Если в сегментах есть `words` — режем пословно. Иначе — сегментный уровень.
    """
    if not transcript_segments:
        return []

    has_words = any(seg.get("words") for seg in transcript_segments)
    if has_words:
        labeled = _split_by_speaker(transcript_segments, speaker_turns)
    else:
        labeled = _assign_initial(transcript_segments, speaker_turns)

    labeled = _smooth(labeled)
    return _merge_consecutive(labeled)
