"""Тесты дедупа пад-зон чанков (_trim_to_core) — overlap на стыках.

Запуск:  python tests/test_chunk_trim.py   (или pytest tests/)
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from modal_app import _trim_to_core, CHUNK_PAD_S  # noqa: E402


def _seg(start: float, end: float, text: str = "x") -> dict:
    return {"start": start, "end": end, "text": text}


def test_core_segments_kept():
    segs = [_seg(5.0, 8.0), _seg(100.0, 105.0)]
    out = _trim_to_core(segs, lead_s=3.0, core_len_s=1200.0, is_last=False)
    assert out == segs


def test_lead_pad_dropped():
    # Сегмент целиком в lead-паде (midpoint 1.5 < lead 3.0)
    segs = [_seg(0.5, 2.5, "pad"), _seg(4.0, 6.0, "core")]
    out = _trim_to_core(segs, lead_s=3.0, core_len_s=1200.0, is_last=False)
    assert [s["text"] for s in out] == ["core"]


def test_trail_pad_dropped_unless_last():
    # core = [3, 1203); сегмент с midpoint 1204 — в trail-паде
    segs = [_seg(1203.0, 1205.0, "tail")]
    assert _trim_to_core(segs, 3.0, 1200.0, is_last=False) == []
    # ...но последний чанк забирает хвост
    assert len(_trim_to_core(segs, 3.0, 1200.0, is_last=True)) == 1


def test_straddling_segment_owned_by_midpoint():
    # Сегмент начинается в паде, но середина в core → остаётся (текст не режем)
    segs = [_seg(1.0, 6.0, "straddle")]  # midpoint 3.5 >= lead 3.0
    out = _trim_to_core(segs, 3.0, 1200.0, is_last=False)
    assert len(out) == 1


def test_no_trim_when_core_len_none_semantics():
    # transcribe_chunk пропускает трим если core_len_s is None — здесь
    # проверяем дефолтный путь: lead=0 + is_last=True ничего не отрезает
    segs = [_seg(0.0, 1.0), _seg(50.0, 60.0)]
    assert _trim_to_core(segs, 0.0, 99999.0, is_last=True) == segs


def test_seam_partition_property():
    """Главный инвариант: для двух соседних чанков с общим швом каждый
    сегмент (по его глобальному midpoint) достаётся РОВНО одному чанку —
    ни дублей, ни потерь."""
    pad = CHUNK_PAD_S
    cut = 1200.0          # глобальный шов
    core0 = (0.0, cut)    # чанк 0: core [0, 1200), пад справа
    core1 = (cut, 2400.0) # чанк 1: core [1200, 2400), пад слева

    # Речь вокруг шва: сегменты каждые 0.7с в окне [шов-пад-2 .. шов+пад+2]
    global_segs = []
    t = cut - pad - 2.0
    while t < cut + pad + 2.0:
        global_segs.append((t, t + 0.6))
        t += 0.7

    # Чанк 0: паддед-аудио [0, cut+pad), lead=0
    chunk0 = [_seg(s, e) for s, e in global_segs if e <= cut + pad]
    kept0 = _trim_to_core(chunk0, lead_s=0.0, core_len_s=cut, is_last=False)
    kept0_globals = {round(s["start"], 3) for s in kept0}

    # Чанк 1: паддед-аудио [cut-pad, ...), lead=pad; таймстемпы chunk-relative
    ss1 = cut - pad
    chunk1 = [_seg(s - ss1, e - ss1) for s, e in global_segs if s >= ss1]
    kept1 = _trim_to_core(chunk1, lead_s=pad, core_len_s=1200.0, is_last=True)
    kept1_globals = {round(s["start"] + ss1, 3) for s in kept1}

    all_globals = {round(s, 3) for s, _e in global_segs}
    assert kept0_globals | kept1_globals == all_globals, "segment lost at seam"
    assert kept0_globals & kept1_globals == set(), "segment duplicated at seam"


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
