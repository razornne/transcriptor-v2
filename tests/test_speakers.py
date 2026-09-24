"""Тесты переразметки спикеров по голосу (speakers.py).

Запуск:  python tests/test_speakers.py   (нужен numpy)
"""
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from speakers import relabel  # noqa: E402


def _voices(n, dim=64, seed=1):
    rng = np.random.default_rng(seed)
    v = rng.normal(size=(n, dim))
    return v / np.linalg.norm(v, axis=1, keepdims=True)


def _seg(t, spk, dur=4.0):
    return {"start": t, "end": t + dur, "speaker": spk, "text": "x"}


def _emb(voice, rng, noise=0.35):
    e = voice + rng.normal(scale=noise / np.sqrt(len(voice)), size=len(voice))
    return e / np.linalg.norm(e)


def test_fixes_merged_and_split_speakers():
    """Как на звонке 24.09: Soniox слил голоса A и C в SPEAKER_01, а B подписал
    SPEAKER_02 с самого начала. Перекластеризация по голосу разводит всех троих."""
    V = _voices(3)
    rng = np.random.default_rng(0)
    segs, embs, truth = [], [], []
    for n in range(60):
        who = n % 3
        soniox = {0: "SPEAKER_01", 1: "SPEAKER_02", 2: "SPEAKER_01"}[who]
        segs.append(_seg(n * 5.0, soniox))
        embs.append(_emb(V[who], rng))
        truth.append(who)
    new, info = relabel(segs, embs, k=3, first_index=1)
    assert info["applied"], info
    # каждому истинному голосу — ровно одна метка, и метки разные
    mapping = {}
    for t, lab in zip(truth, new):
        mapping.setdefault(t, set()).add(lab)
    assert all(len(v) == 1 for v in mapping.values()), mapping
    assert len({next(iter(v)) for v in mapping.values()}) == 3
    assert new[0] == "SPEAKER_01"  # нумерация по первому появлению


def test_short_segments_follow_neighbour_with_same_label():
    V = _voices(2)
    rng = np.random.default_rng(3)
    segs = [_seg(i * 5.0, f"S{i % 2}") for i in range(20)]
    embs = [_emb(V[i % 2], rng) for i in range(20)]
    segs.append({"start": 51.0, "end": 51.4, "speaker": "S0", "text": "угу"})
    embs.append(None)
    new, info = relabel(segs, embs, k=2)
    assert info["applied"]
    nearest_s0 = new[10]  # сегмент на 50.0 с, тоже S0
    assert new[-1] == nearest_s0


def test_keeps_original_when_voices_are_not_separable():
    V = _voices(1)
    rng = np.random.default_rng(5)
    segs = [_seg(i * 5.0, f"S{i % 2}") for i in range(20)]
    embs = [_emb(V[0], rng, noise=0.05) for _ in range(20)]  # один и тот же голос
    new, info = relabel(segs, embs, k=2)
    assert not info["applied"] and new == [s["speaker"] for s in segs], info


def test_keeps_original_with_too_little_speech():
    V = _voices(2)
    rng = np.random.default_rng(7)
    segs = [_seg(i * 2.0, f"S{i % 2}", dur=1.5) for i in range(6)]
    embs = [_emb(V[i % 2], rng) for i in range(6)]
    new, info = relabel(segs, embs, k=2)
    assert not info["applied"]


if __name__ == "__main__":
    failed = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"  PASS {name}")
            except AssertionError as e:
                failed += 1
                print(f"  FAIL {name}: {e}")
    print("ALL OK" if not failed else f"{failed} FAILED")
    sys.exit(1 if failed else 0)
