"""Тесты map-reduce хелперов privacy-генерации (ISS-1 / MYK-5).

Запуск:  python tests/test_mapreduce.py   (или pytest tests/)
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from modal_app import _split_text_windows, MAPREDUCE_TEXT_SLOT  # noqa: E402


def test_short_text_single_window():
    assert _split_text_windows("hello\nworld", 100) == ["hello\nworld"]


def test_windows_respect_limit():
    lines = [f"[Speaker {i % 3}]: реплика номер {i} " + "слово " * 30 for i in range(500)]
    text = "\n".join(lines)
    windows = _split_text_windows(text, 12000)
    assert len(windows) > 1
    for w in windows:
        assert len(w) <= 12000, f"window of {len(w)} chars exceeds limit"


def test_line_boundary_split_is_lossless():
    lines = [f"line {i} " + "x" * 50 for i in range(200)]
    text = "\n".join(lines)
    windows = _split_text_windows(text, 1000)
    assert "\n".join(windows) == text


def test_hard_split_of_giant_line():
    text = "a" * 25000  # одна строка без переносов
    windows = _split_text_windows(text, 12000)
    assert [len(w) for w in windows] == [12000, 12000, 1000]
    assert "".join(windows) == text


def test_empty_text():
    assert _split_text_windows("", 1000) == [""]


def test_slot_constant_matches_flask_side():
    """PRIVACY_TEXT_SLOT (app.py) и MAPREDUCE_TEXT_SLOT (modal_app.py) — один
    и тот же литерал: Flask вшивает его в промпты, контейнер делает replace.
    Расходятся → текст молча не подставится. Сверяем по исходнику app.py,
    чтобы не тянуть flask-импорты в тест."""
    src = open(os.path.join(ROOT, "app.py"), encoding="utf-8").read()
    m = re.search(r'^PRIVACY_TEXT_SLOT\s*=\s*"([^"]+)"', src, re.M)
    assert m, "PRIVACY_TEXT_SLOT not found in app.py"
    assert m.group(1) == MAPREDUCE_TEXT_SLOT


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
