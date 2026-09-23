"""Двухканальные записи из веб-рекордера: L = микрофон юзера, R = звук звонка.

Когда в каналах разный звук, каждый канал распознаётся отдельно: спикер
микрофона известен заранее, одновременная речь не глушит друг друга, а
pyannote нужен только на канале звонка (если собеседников несколько).

Здесь только чистая логика (тестируется без GPU):
  • ChannelStats — потоковый детектор: действительно ли каналы разные;
  • drop_echo    — выкидывает из микрофона эхо собеседника из колонок;
  • label/interleave — склейка двух дорожек в один транскрипт по времени.
"""
import bisect
import math

from merger import _collapse_text_loops, _merge_consecutive

MIC_LABEL = "SPEAKER_MIC"
# Единственный собеседник на канале звонка (диаризация не нужна).
CALL_LABEL = "SPEAKER_CALL"

# Кадр, у которого RMS выше порога, считается "звучащим" (речь/звук, не тишина).
ACTIVE_RMS = 0.01
# Канал с долей звучащих кадров ниже этой — фактически пустой.
MIN_ACTIVE_FRACTION = 0.01
# Корреляция каналов выше порога — это dual-mono (один звук в обоих каналах).
DUAL_MONO_CORR = 0.95


class ChannelStats:
    """Накопитель статистики по блокам (для записей любой длины без загрузки в RAM).

    feed(left, right) принимает numpy-массивы одного блока; verdict() →
      'dual'       — в каналах разный звук (разводим),
      'left_only'  — звучит только левый (микрофон) → обычный моно-путь по L,
      'right_only' — звучит только правый → моно-путь по R,
      'mono'       — каналы одинаковые или оба пустые → обычный даунмикс.
    """

    def __init__(self, frame_len: int = 1600):
        self.frame_len = frame_len
        self.frames = 0
        self.active_l = 0
        self.active_r = 0
        self.n = 0
        self.sl = self.sr = self.sll = self.srr = self.slr = 0.0

    def feed(self, left, right) -> None:
        import numpy as np

        left = np.asarray(left, dtype="float64")
        right = np.asarray(right, dtype="float64")
        self.n += left.size
        self.sl += float(left.sum()); self.sr += float(right.sum())
        self.sll += float((left * left).sum()); self.srr += float((right * right).sum())
        self.slr += float((left * right).sum())
        usable = (left.size // self.frame_len) * self.frame_len
        if usable:
            fl = left[:usable].reshape(-1, self.frame_len)
            fr = right[:usable].reshape(-1, self.frame_len)
            self.frames += fl.shape[0]
            self.active_l += int((np.sqrt((fl * fl).mean(axis=1)) > ACTIVE_RMS).sum())
            self.active_r += int((np.sqrt((fr * fr).mean(axis=1)) > ACTIVE_RMS).sum())

    def correlation(self) -> float:
        if self.n == 0:
            return 0.0
        n = self.n
        cov = self.slr - self.sl * self.sr / n
        var_l = self.sll - self.sl * self.sl / n
        var_r = self.srr - self.sr * self.sr / n
        if var_l <= 1e-12 or var_r <= 1e-12:
            return 0.0
        return cov / math.sqrt(var_l * var_r)

    def verdict(self) -> str:
        if self.frames == 0:
            return "mono"
        l_on = self.active_l / self.frames >= MIN_ACTIVE_FRACTION
        r_on = self.active_r / self.frames >= MIN_ACTIVE_FRACTION
        if l_on and r_on:
            return "mono" if self.correlation() > DUAL_MONO_CORR else "dual"
        if l_on:
            return "left_only"
        if r_on:
            return "right_only"
        return "mono"


def _norm_word(w: str) -> str:
    return "".join(c for c in w.lower() if c.isalnum())


def drop_echo(mic_segments: list[dict], call_segments: list[dict],
              before_s: float = 1.5, after_s: float = 0.5, min_share: float = 0.6) -> list[dict]:
    """Убирает из микрофонного канала эхо собеседника.

    Без наушников голос из колонок попадает в микрофон, и Whisper распознаёт
    ту же фразу второй раз. Слово микрофона считается эхом, если такое же
    слово есть в канале звонка чуть раньше или одновременно (эхо запаздывает,
    плюс неточность таймстемпов Whisper). Сегмент, в котором эхом оказалась
    доля слов >= min_share, выбрасывается целиком; смешанные сегменты
    (юзер говорит поверх собеседника) остаются.
    Нужны пословные таймстемпы (`words`) в обоих каналах.
    """
    index: dict[str, list[float]] = {}
    for seg in call_segments:
        for w in seg.get("words") or []:
            key = _norm_word(w["word"])
            if key:
                index.setdefault(key, []).append(float(w["start"]))
    for times in index.values():
        times.sort()

    kept = []
    for seg in mic_segments:
        words = [(float(w["start"]), _norm_word(w["word"])) for w in seg.get("words") or []]
        words = [(t, k) for t, k in words if k]
        if not words:
            kept.append(seg)
            continue
        hits = 0
        for t, k in words:
            times = index.get(k)
            if times:
                i = bisect.bisect_left(times, t - before_s)
                if i < len(times) and times[i] <= t + after_s:
                    hits += 1
        if hits / len(words) < min_share:
            kept.append(seg)
    return kept


def split_on_pauses(segments: list[dict], max_gap_s: float = 0.8) -> list[dict]:
    """Режет Whisper-сегменты по паузам между словами длиннее max_gap_s.

    С vad_filter faster-whisper склеивает речевые куски в окна до 30с, и один
    сегмент канала звонка может перекрыть паузу, в которой говорил микрофон —
    тогда реплики двух каналов не чередуются по времени. Нужны `words`;
    сегменты без слов возвращаются как есть.
    """
    out: list[dict] = []
    for seg in segments:
        words = seg.get("words") or []
        if len(words) < 2:
            out.append(seg)
            continue
        group = [words[0]]
        for w in words[1:]:
            if float(w["start"]) - float(group[-1]["end"]) > max_gap_s:
                out.append(_from_words(group))
                group = []
            group.append(w)
        out.append(_from_words(group))
    return [s for s in out if s["text"]]


def _from_words(words: list[dict]) -> dict:
    return {
        "start": float(words[0]["start"]),
        "end": float(words[-1]["end"]),
        "text": "".join(w["word"] for w in words).strip(),
        "words": words,
    }


def label(segments: list[dict], speaker: str) -> list[dict]:
    """Сегменты одного известного спикера (канал микрофона / единственный собеседник)."""
    return [
        {"speaker": speaker, "start": float(s["start"]), "end": float(s["end"]),
         "text": _collapse_text_loops(s["text"])}
        for s in segments if s.get("text", "").strip()
    ]


def interleave(*tracks: list[dict]) -> list[dict]:
    """Склеивает размеченные дорожки в один транскрипт: сортировка по времени,
    склейка подряд идущих реплик одного спикера, анти-петля на склеенном тексте."""
    combined = sorted((dict(s) for t in tracks for s in t), key=lambda s: (s["start"], s["end"]))
    merged = _merge_consecutive(combined)
    for seg in merged:
        seg["text"] = _collapse_text_loops(seg["text"])
    return merged


def relabel(segments: list[dict], mapping_start: int = 0, keep: tuple[str, ...] = ()) -> list[dict]:
    """SPEAKER_XX по порядку первого появления, начиная с mapping_start.
    Лейблы из keep (например MIC_LABEL) не трогаются."""
    order: dict[str, str] = {}
    out = []
    for s in segments:
        spk = s["speaker"]
        if spk not in keep and spk not in order:
            order[spk] = f"SPEAKER_{mapping_start + len(order):02d}"
        out.append({**s, "speaker": spk if spk in keep else order[spk]})
    return out
