"""Вырезание долгой тишины из дорожки микрофона перед Soniox.

Soniox берёт деньги за длительность каждой дорожки, а в стерео-записи звонка микрофон
большую часть времени молчит (говорит собеседник). Режем паузы дольше GAP_S, оставляя
PAD_S речи с краёв, распознаём укороченную дорожку и возвращаем таймстемпы слов в исходную
шкалу (`to_original`). Склейка sample-exact — никакого дрейфа на сотнях пауз.

Чистая логика на numpy/soundfile, без modal: тесты — tests/test_silence_trim.py.
"""
from __future__ import annotations

import bisect
from dataclasses import dataclass

import numpy as np

FRAME_S = 0.02        # шаг оценки громкости
GAP_S = 2.5           # паузы короче — не трогаем (это дыхание/межфразовые)
PAD_S = 0.5           # запас речи с каждой стороны вырезки
MIN_SAVING = 0.15     # меньше 15% экономии — не стоит риска, отдаём дорожку как есть
FLOOR_DB = -50.0      # ниже этого — тишина при любом шумовом фоне
ABOVE_NOISE_DB = 10.0 # речь = громче шумового фона на столько


@dataclass
class Span:
    start: float      # в исходной дорожке, сек
    end: float
    trim_start: float = 0.0   # где этот отрезок начинается в укороченной дорожке


def frame_db(samples: np.ndarray, sr: int) -> np.ndarray:
    """Громкость (dBFS) по кадрам FRAME_S. Хвост короче кадра отбрасывается."""
    n = max(1, int(sr * FRAME_S))
    frames = len(samples) // n
    if frames == 0:
        return np.zeros(0)
    x = samples[: frames * n].astype(np.float64).reshape(frames, n)
    rms = np.sqrt(np.mean(x * x, axis=1))
    return 20.0 * np.log10(np.maximum(rms, 1e-7))


def plan_spans(db: np.ndarray, total_s: float) -> list[Span] | None:
    """Отрезки, которые оставляем. None — резать не стоит (мало тишины или нет речи)."""
    if len(db) == 0:
        return None
    noise = float(np.percentile(db, 10))
    thr = max(FLOOR_DB, noise + ABOVE_NOISE_DB)
    active = db > thr
    if not active.any():
        return None  # вся дорожка «тишина»: пусть Soniox сам решает, ничего не режем

    # активные кадры → интервалы, склеиваем промежутки короче GAP_S
    spans: list[list[float]] = []
    i = 0
    n = len(active)
    while i < n:
        if not active[i]:
            i += 1
            continue
        j = i
        while j < n and active[j]:
            j += 1
        s, e = i * FRAME_S, j * FRAME_S
        if spans and s - spans[-1][1] < GAP_S:
            spans[-1][1] = e
        else:
            spans.append([s, e])
        i = j

    padded: list[list[float]] = []
    for s, e in spans:
        s, e = max(0.0, s - PAD_S), min(total_s, e + PAD_S)
        if padded and s <= padded[-1][1]:
            padded[-1][1] = max(padded[-1][1], e)
        else:
            padded.append([s, e])

    kept = sum(e - s for s, e in padded)
    if total_s <= 0 or 1 - kept / total_s < MIN_SAVING:
        return None
    out: list[Span] = []
    acc = 0.0
    for s, e in padded:
        out.append(Span(s, e, acc))
        acc += e - s
    return out


def to_original(t: float, spans: list[Span]) -> float:
    """Время в укороченной дорожке → в исходной. За пределами отрезков — прижимаем к ближайшему."""
    if not spans:
        return t
    starts = [s.trim_start for s in spans]
    k = max(0, bisect.bisect_right(starts, t) - 1)
    sp = spans[k]
    off = min(max(t - sp.trim_start, 0.0), sp.end - sp.start)
    return sp.start + off


def remap_words(words: list[dict], spans: list[Span]) -> list[dict]:
    return [{**w, "start": to_original(w["start"], spans), "end": to_original(w["end"], spans)} for w in words]


def trimmed_duration(spans: list[Span]) -> float:
    return sum(s.end - s.start for s in spans)


def analyse(wav_path: str) -> tuple[list[Span] | None, float]:
    """Громкость по блокам (память не растёт с длиной записи) → план отрезков."""
    import soundfile as sf

    info = sf.info(wav_path)
    sr = info.samplerate
    n = max(1, int(sr * FRAME_S))
    block = n * 1500  # ~30 с
    dbs: list[np.ndarray] = []
    leftover = np.zeros(0, dtype=np.float32)
    for b in sf.blocks(wav_path, blocksize=block, dtype="float32", always_2d=True):
        x = np.concatenate([leftover, b[:, 0]])
        usable = (len(x) // n) * n
        dbs.append(frame_db(x[:usable], sr))
        leftover = x[usable:]
    db = np.concatenate(dbs) if dbs else np.zeros(0)
    total = info.frames / sr
    return plan_spans(db, total), total


def write_trimmed(wav_path: str, spans: list[Span], out_path: str) -> None:
    """Склеивает отрезки sample-exact. trim_start пересчитывается по реальному числу сэмплов."""
    import soundfile as sf

    with sf.SoundFile(wav_path) as src:
        sr = src.samplerate
        with sf.SoundFile(out_path, "w", samplerate=sr, channels=src.channels, subtype="PCM_16", format="WAV") as dst:
            written = 0
            for sp in spans:
                a = int(round(sp.start * sr))
                b = min(int(round(sp.end * sr)), src.frames)
                sp.start, sp.end = a / sr, b / sr
                sp.trim_start = written / sr
                src.seek(a)
                left = b - a
                while left > 0:
                    chunk = src.read(min(left, sr * 30), dtype="int16", always_2d=True)
                    if len(chunk) == 0:
                        break
                    dst.write(chunk)
                    left -= len(chunk)
                    written += len(chunk)
