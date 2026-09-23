"""Тесты эвристики _detect_transcript_language (app.py).

Запуск:  python tests/test_language_detect.py
Чистый stdlib: функция вытаскивается из app.py через ast, без импорта Flask/jwt.
"""
import ast
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _load_detector():
    with open(os.path.join(ROOT, "app.py"), encoding="utf-8") as f:
        tree = ast.parse(f.read())
    fn = next(n for n in tree.body
              if isinstance(n, ast.FunctionDef) and n.name == "_detect_transcript_language")
    ns: dict = {}
    exec(compile(ast.Module(body=[fn], type_ignores=[]), "app.py", "exec"), ns)
    return ns["_detect_transcript_language"]


detect = _load_detector()


def test_czech():
    assert detect("Dobrý den, děkuji za pozvání. Příští týden řešíme rozpočet.") == "cs"


def test_czech_segments():
    segs = [{"text": "Takže začneme čtvrtletním přehledem."}, {"text": "Souhlasím, můžeme."}]
    assert detect(segs) == "cs"


def test_polish_not_confused_with_czech():
    assert detect("Dzień dobry, dziękuję za zaproszenie. Omawiamy budżet.") == "pl"


def test_english():
    assert detect("Good morning, thanks for having me today.") == "en"


def test_ukrainian_and_russian():
    assert detect("Добрий день, сьогодні обговоримо їхні ідеї.") == "uk"
    assert detect("Добрый день, спасибо за приглашение.") == "ru"


def test_empty():
    assert detect("") is None
    assert detect("   ") is None


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
