"""Тесты планировщика чанков long-пайплайна (_plan_chunk_boundaries).

Запуск:  python tests/test_chunk_planner.py   (или pytest tests/)
Требует import modal (lazy-объекты, сеть не нужна).
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import modal_app  # noqa: E402
from modal_app import (  # noqa: E402
    _plan_chunk_boundaries,
    _parse_silences,
    CHUNK_LEN_S,
    MAX_PARALLEL_CHUNKS,
    MAX_CHUNK_LEN_S,
)


def _check_contiguous(bounds: list[tuple[float, float]], duration: float):
    assert bounds[0][0] == 0.0
    assert abs(bounds[-1][1] - duration) < 1e-6
    for (s1, e1), (s2, e2) in zip(bounds, bounds[1:]):
        assert abs(e1 - s2) < 1e-6, f"gap between chunks: {e1} != {s2}"
        assert e1 > s1, "non-positive chunk"
    assert bounds[-1][1] > bounds[-1][0]


def test_short_audio_single_chunk():
    bounds = _plan_chunk_boundaries(1500.0, [])
    assert bounds == [(0.0, 1500.0)]


def test_35min_two_balanced_chunks():
    bounds = _plan_chunk_boundaries(2100.0, [])
    assert len(bounds) == 2
    _check_contiguous(bounds, 2100.0)
    # Без тишины рез ровно посередине
    assert abs(bounds[0][1] - 1050.0) < 1.0


def test_4h_fits_single_wave():
    duration = 4 * 3600.0
    bounds = _plan_chunk_boundaries(duration, [])
    assert len(bounds) <= MAX_PARALLEL_CHUNKS, (
        f"4h must fit one GPU wave, got {len(bounds)} chunks"
    )
    _check_contiguous(bounds, duration)
    for s, e in bounds:
        assert e - s <= MAX_CHUNK_LEN_S + 1.0


def test_6h_caps_chunk_length():
    duration = 6 * 3600.0
    bounds = _plan_chunk_boundaries(duration, [])
    _check_contiguous(bounds, duration)
    # 6ч не влезает в одну волну с капом 30 мин — чанков больше лимита,
    # но каждый ≤ кап
    assert len(bounds) == 12
    for s, e in bounds:
        assert e - s <= MAX_CHUNK_LEN_S + 1.0


def test_silence_snapping():
    duration = 4 * 3600.0
    # Тишина каждые ~10 минут, смещённая на +37с от кратных точек
    silences = [(m * 600.0 + 37.0, m * 600.0 + 38.0) for m in range(1, 24)]
    bounds = _plan_chunk_boundaries(duration, silences)
    assert len(bounds) <= MAX_PARALLEL_CHUNKS
    _check_contiguous(bounds, duration)
    # Каждый внутренний рез должен попасть в середину какой-то тишины
    sil_mids = {(s + e) / 2 for s, e in silences}
    for _s, e in bounds[:-1]:
        assert any(abs(e - m) < 1e-6 for m in sil_mids), f"cut {e} not on silence"


def test_monotonic_cuts_with_clustered_silences():
    duration = 4 * 3600.0
    # Все тишины сгрудились в начале — резы не должны слипнуться/уйти назад
    silences = [(100.0 + i, 101.0 + i) for i in range(0, 300, 10)]
    bounds = _plan_chunk_boundaries(duration, silences)
    _check_contiguous(bounds, duration)
    cuts = [e for _s, e in bounds[:-1]]
    assert all(c2 - c1 >= 59.0 for c1, c2 in zip(cuts, cuts[1:]))


def test_parse_silences():
    stderr = (
        "[silencedetect @ 0x1] silence_start: 12.5\n"
        "[silencedetect @ 0x1] silence_end: 14.0 | silence_duration: 1.5\n"
        "[silencedetect @ 0x1] silence_start: 100.25\n"
        "[silencedetect @ 0x1] silence_end: 101.0 | silence_duration: 0.75\n"
        "garbage line\n"
    )
    assert _parse_silences(stderr) == [(12.5, 14.0), (100.25, 101.0)]


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
