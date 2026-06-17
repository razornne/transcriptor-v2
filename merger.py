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

# Анти-петля: фраза из 1..LOOP_MAX_UNIT_WORDS слов, повторённая подряд
# >= LOOP_COLLAPSE_MIN_REPEATS раз, схлопывается до двух повторов.
# Классика Whisper — хвост записи "Пока-пока. Пока-пока. Пока-пока. ...":
# реальные прощания заражают контекст декодера, а на тихом/шумном хвосте
# LM-prior доминирует и зацикливается. Встроенные гейты Whisper это НЕ ловят:
# compression_ratio неэффективен на коротких строках (gzip-заголовок съедает
# выигрыш), avg_logprob у петли высокий (повтор = уверенность), VAD хвостовые
# шорохи не режет. Детерминированный коллапсер — единственная жёсткая гарантия.
# 3 повтора — порог: двойные повторы легитимны ("так-так", "пока-пока. пока-пока"
# от обоих спикеров), тройные+ одного юнита — практически всегда петля.
# 0 = выключить.
LOOP_COLLAPSE_MIN_REPEATS = int(os.environ.get("LOOP_COLLAPSE_MIN_REPEATS", "3"))
LOOP_MAX_UNIT_WORDS = int(os.environ.get("LOOP_MAX_UNIT_WORDS", "4"))


def _collapse_text_loops(text: str) -> str:
    """Схлопывает подряд идущие повторы короткой фразы до двух вхождений.

    Сравнение нечувствительно к регистру и пунктуации ("Пока-пока." ==
    "пока пока"), в выводе сохраняются ПЕРВЫЕ два вхождения как есть.
    Числа и легитимные двойные повторы не трогаются (порог >= 3).
    """
    if LOOP_COLLAPSE_MIN_REPEATS <= 0:
        return text
    words = text.split()
    if len(words) < LOOP_COLLAPSE_MIN_REPEATS:
        return text

    def norm(w: str) -> str:
        return "".join(c for c in w.lower() if c.isalnum())

    out: list[str] = []
    i, n = 0, len(words)
    while i < n:
        collapsed = False
        for unit in range(1, LOOP_MAX_UNIT_WORDS + 1):
            if i + unit * LOOP_COLLAPSE_MIN_REPEATS > n:
                break
            base = [norm(w) for w in words[i:i + unit]]
            if not any(base):
                continue  # юнит из чистой пунктуации — не схлопываем
            reps = 1
            j = i + unit
            while j + unit <= n and [norm(w) for w in words[j:j + unit]] == base:
                reps += 1
                j += unit
            if reps >= LOOP_COLLAPSE_MIN_REPEATS:
                out.extend(words[i:i + unit * 2])  # оставляем два повтора
                i += unit * reps
                collapsed = True
                break
        if not collapsed:
            out.append(words[i])
            i += 1
    return " ".join(out)


def _overlap(a_start: float, a_end: float, b_start: float, b_end: float) -> float:
    """Длина пересечения двух интервалов (0 если не пересекаются)."""
    return max(0.0, min(a_end, b_end) - max(a_start, b_start))


def _best_speaker_for(start: float, end: float, turns: list[dict]) -> str:
    """Спикер для интервала [start, end] по правилу СРЕДНЕЙ ТОЧКИ (midpoint).

    midpoint = (start + end) / 2 — интервал принадлежит тому pyannote-турну,
    внутрь которого попадает его ЦЕНТР. Это лечит «протекание» спикеров
    (speaker bleeding): первое короткое слово реплики ("Не", "Я", "Там"), чей
    ХВОСТ ещё задевает турн предыдущего спикера (pyannote регулярно растягивает
    хвост турна на ~100-300мс), но чей ЦЕНТР уже в новом турне, теперь уходит
    НОВОМУ спикеру — а не приклеивается к предыдущему по краевому overlap'у,
    как было в overlap-логике (регресс MYK-17/ISS-13).

    Если центр попал в ПАУЗУ между турнами (нет содержащего сегмента) — берём
    БЛИЖАЙШИЙ турн по абсолютному расстоянию до любой его границы (левой или
    правой) в пределах NEAREST_TURN_MAX_GAP_S. НИКАКОГО слепого previous-speaker
    fill: первое слово реплики после паузы уходит следующему (ближайшему) турну.
    """
    if not turns:
        return "SPEAKER_UNKNOWN"

    mid = (start + end) / 2.0

    # 1. Турн(ы), СОДЕРЖАЩИЕ среднюю точку слова
    containing = [t for t in turns if t["start"] <= mid <= t["end"]]
    if containing:
        if len(containing) == 1:
            return containing[0]["speaker"]
        # Перекрывающиеся турны (растянутый хвост предыдущего спикера или
        # реальная одновременная речь): отдаём ПОЗЖЕ начавшемуся турну — на
        # стыке реплик это входящий (новый) спикер. Именно это окончательно
        # убирает приклеивание первого слова к предыдущему блоку.
        return max(containing, key=lambda t: t["start"])["speaker"]

    # 2. Центр в паузе → ближайший турн по расстоянию до его границ
    best_speaker = "SPEAKER_UNKNOWN"
    best_dist = NEAREST_TURN_MAX_GAP_S
    for t in turns:
        dist = min(abs(t["start"] - mid), abs(mid - t["end"]))
        if dist < best_dist:
            best_dist = dist
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


def _smooth(labeled: list[dict], threshold: float | None = None) -> list[dict]:
    """Короткий сегмент, зажатый между двумя одинаковыми спикерами,
    переназначается на их спикера. Итеративно: после первого прохода
    могут открыться новые ABA-паттерны.

    threshold: если передан — используется вместо SMOOTH_THRESHOLD_S.
    0 = выключено.
    """
    t = SMOOTH_THRESHOLD_S if threshold is None else threshold
    if t <= 0 or len(labeled) < 3:
        return labeled

    for _pass in range(SMOOTH_PASSES):
        changed = False
        for i in range(1, len(labeled) - 1):
            cur      = labeled[i]
            duration = cur["end"] - cur["start"]
            if duration >= t:
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


def merge(
    transcript_segments: list[dict],
    speaker_turns: list[dict],
    smooth_threshold: float | None = None,
) -> list[dict]:
    """transcript_segments: [{start, end, text, words?}] от Whisper
       speaker_turns:       [{start, end, speaker}] от pyannote
       → [{speaker, start, end, text}]

    smooth_threshold: override SMOOTH_THRESHOLD_S (e.g. 0.4 when caller
    knows the exact num_speakers and wants to preserve brief minority-speaker
    interjections that the default 1.0s threshold would absorb).

    Если в сегментах есть `words` — режем пословно. Иначе — сегментный уровень.
    """
    if not transcript_segments:
        return []

    has_words = any(seg.get("words") for seg in transcript_segments)
    if has_words:
        labeled = _split_by_speaker(transcript_segments, speaker_turns)
    else:
        labeled = _assign_initial(transcript_segments, speaker_turns)

    labeled = _smooth(labeled, threshold=smooth_threshold)
    merged = _merge_consecutive(labeled)

    # Анти-петля (после склейки соседей одного спикера — петля из нескольких
    # сегментов к этому моменту уже сжата в один текст и видна целиком)
    for seg in merged:
        collapsed = _collapse_text_loops(seg["text"])
        if collapsed != seg["text"]:
            # ASCII-only: локальные Windows-консоли (cp1251) падают на юникоде
            print("[merger] collapsed hallucination loop: "
                  f"{len(seg['text'].split())} -> {len(collapsed.split())} words",
                  flush=True)
            seg["text"] = collapsed
    return merged
