"""Совмещение вывода Whisper (текст с таймингами) и pyannote (спикер-турны).

Алгоритм:
1. Если Whisper-сегменты содержат пословные таймстемпы (`words`) —
   обрабатываем каждый сегмент:
   - Если сегмент короткий (<= SHORT_SEGMENT_THRESHOLD_S) — используем
     majority-vote: pyannote часто шумит на коротких репликах, выдавая
     микро-пинг-понг между спикерами на одной фразе. Whisper же режет
     по реальным паузам, поэтому короткий блок ≈ одна реплика одного
     человека. Берём большинство спикера по словам и применяем ко всему.
   - Если длинный — режем по словам в местах смены pyannote-спикера
     (быстрый диалог склеенный Whisper'ом, монологи с уточнениями и т.п.)
2. Если слов нет — фоллбэк к сегментному уровню.
3. Smoothing: короткий сегмент (< SMOOTH_THRESHOLD_S), зажатый между
   двумя одинаковыми спикерами, переназначается на их спикера. Делается
   итеративно — после первого прохода могут открыться новые ABA-паттерны.
4. Склеиваем подряд идущие сегменты одного спикера в блоки.
"""
import os
from collections import Counter

# Smoothing: 0 = выключено. >0 = порог в секундах. Default 1.0 — лечит
# мелкий бaunce pyannote на быстрых диалогах. Раньше было 0, поднято 2026-05.
SMOOTH_THRESHOLD_S = float(os.environ.get("SMOOTH_THRESHOLD_S", "1.0"))

# Короткие Whisper-сегменты (<= 2.0s) обрабатываются majority-vote
# вместо word-level splitting. Это убирает шум pyannote на коротких
# репликах, когда одна фраза дробится на 4 микро-куска с разными спикерами.
SHORT_SEGMENT_THRESHOLD_S = float(os.environ.get("SHORT_SEGMENT_THRESHOLD_S", "2.0"))

# Сколько проходов smoothing делать. Каждый проход может открыть новые
# ABA-паттерны после изменений предыдущего. Обычно сходится за 1-2.
SMOOTH_PASSES = int(os.environ.get("SMOOTH_PASSES", "3"))

# Слово, не пересёкшееся ни с одним pyannote-турном (пауза между турнами,
# непокрытый край), приписывается ближайшему по времени турну, если тот не
# дальше этого порога (сек). Дальше — SPEAKER_UNKNOWN (заполнится fill'ом).
# Точечная атрибуция по реальной близости лучше слепого forward-fill:
# первое слово реплики после паузы уходит СЛЕДУЮЩЕМУ турну, а не предыдущему.
NEAREST_TURN_MAX_GAP_S = float(os.environ.get("NEAREST_TURN_MAX_GAP_S", "2.0"))


def _overlap(a_start: float, a_end: float, b_start: float, b_end: float) -> float:
    """Длина пересечения двух интервалов (0 если не пересекаются)."""
    return max(0.0, min(a_end, b_end) - max(a_start, b_start))


def _best_speaker_for(start: float, end: float, turns: list[dict]) -> str:
    """Спикер с максимальным overlap по интервалу [start, end].

    Если пересечений нет — ближайший турн в пределах NEAREST_TURN_MAX_GAP_S
    (таймстемпы Whisper-слов гуляют на ±100-300мс, а pyannote часто не
    покрывает первые/последние полслова реплики)."""
    best_speaker = "SPEAKER_UNKNOWN"
    best_overlap = 0.0
    for t in turns:
        ov = _overlap(start, end, t["start"], t["end"])
        if ov > best_overlap:
            best_overlap = ov
            best_speaker = t["speaker"]
    if best_overlap > 0.0:
        return best_speaker

    best_gap = NEAREST_TURN_MAX_GAP_S
    for t in turns:
        gap = max(t["start"] - end, start - t["end"])
        if 0.0 <= gap < best_gap:
            best_gap = gap
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
    """Гибридное разбиение:
    - Короткий Whisper-сегмент (<= SHORT_SEGMENT_THRESHOLD_S) → majority-vote.
      Одна короткая фраза не должна дробиться pyannote-шумом на ABAB.
    - Длинный Whisper-сегмент → word-level split в местах смены спикера
      (быстрый диалог склеенный Whisper'ом, монолог с уточнениями и т.п.)

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

        # Word-level speakers + forward/backward-fill UNKNOWN
        word_speakers = [_best_speaker_for(w["start"], w["end"], speaker_turns) for w in words]

        first_known = next((s for s in word_speakers if s != "SPEAKER_UNKNOWN"), None)
        for i, s in enumerate(word_speakers):
            if s != "SPEAKER_UNKNOWN":
                break
            if first_known:
                word_speakers[i] = first_known
            elif last_speaker:
                word_speakers[i] = last_speaker

        running = last_speaker or first_known or "SPEAKER_UNKNOWN"
        for i, s in enumerate(word_speakers):
            if s == "SPEAKER_UNKNOWN":
                word_speakers[i] = running
            else:
                running = s

        seg_duration = seg["end"] - seg["start"]
        unique_speakers = set(word_speakers)

        # === Majority-vote path для коротких сегментов ===
        # Если Whisper выдал короткий цельный блок (одна реплика) — даже
        # если pyannote передумал в середине, доверяем большинству.
        # Исключение: если ровно ABA-pattern и доля меньшинства большая
        # (>30%), всё-таки оставляем word-level — это может быть реальное
        # двухголосое короткое подтверждение типа "А ты как? — Норм."
        if seg_duration <= SHORT_SEGMENT_THRESHOLD_S and len(unique_speakers) > 1:
            counter = Counter(word_speakers)
            top_speaker, top_count = counter.most_common(1)[0]
            top_ratio = top_count / len(word_speakers)
            # Доминирующий спикер (>= 70%) → берём весь сегмент ему
            if top_ratio >= 0.7:
                result.append({
                    "speaker": top_speaker,
                    "start":   seg["start"],
                    "end":     seg["end"],
                    "text":    seg["text"].strip(),
                })
                last_speaker = top_speaker
                continue

        # === Word-level split path для длинных или явно двухголосых сегментов ===
        current = None
        for w, sp in zip(words, word_speakers):
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
    переназначается на их спикера. Итеративно: после первого прохода
    могут открыться новые ABA-паттерны.

    Управляется SMOOTH_THRESHOLD_S (env). 0 = выключено.
    """
    if SMOOTH_THRESHOLD_S <= 0 or len(labeled) < 3:
        return labeled

    for _pass in range(SMOOTH_PASSES):
        changed = False
        for i in range(1, len(labeled) - 1):
            cur      = labeled[i]
            duration = cur["end"] - cur["start"]
            if duration >= SMOOTH_THRESHOLD_S:
                continue
            prev_sp = labeled[i - 1]["speaker"]
            next_sp = labeled[i + 1]["speaker"]
            if prev_sp == next_sp and prev_sp != cur["speaker"]:
                cur["speaker"] = prev_sp
                changed = True
        if not changed:
            break
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
