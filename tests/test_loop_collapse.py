"""Тесты анти-петли (_collapse_text_loops) — хвостовые галлюцинации Whisper.

Воспроизводит реальный кейс из прод-транскрипта 2026-06-10:
"Пока-пока. Пока-пока. Пока-пока. Пока-пока." в конце записи.

Запуск:  python tests/test_loop_collapse.py   (или pytest tests/)
Чистый stdlib.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from merger import _collapse_text_loops, merge  # noqa: E402


def test_real_tail_loop_from_prod_transcript():
    # Дословный хвост из Транскрипты.md (Speaker 2, последний сегмент)
    text = "Пока-пока. Пока-пока. Пока-пока. Пока-пока."
    assert _collapse_text_loops(text) == "Пока-пока. Пока-пока."


def test_double_repeat_untouched():
    # Двойной повтор — легитимная речь, не трогаем
    for text in ("Пока-пока. Пока-пока.", "так, так", "Угу. Угу."):
        assert _collapse_text_loops(text) == text


def test_loop_inside_sentence():
    text = "Добре, дякую. Окей. Окей. Окей. Окей. Окей. До зустрічі."
    assert _collapse_text_loops(text) == "Добре, дякую. Окей. Окей. До зустрічі."


def test_multiword_unit_loop():
    text = "ну добре ну добре ну добре ну добре і все"
    assert _collapse_text_loops(text) == "ну добре ну добре і все"


def test_numbers_not_collapsed():
    # Реальные числа из того же транскрипта — повторы по 2, должны жить
    text = "Нараховано 4.3.8, 4.3.8, я просто не взяв ручку"
    assert _collapse_text_loops(text) == text


def test_legit_triple_number_sequence_collapses_only_identical():
    # Три РАЗНЫХ числа подряд — не петля
    text = "298 306 307 317 309"
    assert _collapse_text_loops(text) == text


def test_case_and_punct_insensitive_matching():
    text = "Пока-пока! пока пока. ПОКА-ПОКА"
    # norm("Пока-пока!")="покапока", norm("пока")="пока" — юнит из 1 слова не
    # матчится, но юнит "пока пока" (2 слова) != "Пока-пока" (1 слово).
    # Здесь 3 повтора НЕ выстраиваются в равные юниты → текст не трогаем.
    assert _collapse_text_loops(text) == text
    # А вот одинаковая форма с разным регистром/пунктуацией — схлопывается
    text2 = "Пока-пока. пока-пока! ПОКА-ПОКА, пока-пока"
    assert _collapse_text_loops(text2) == "Пока-пока. пока-пока!"


def test_empty_and_short():
    assert _collapse_text_loops("") == ""
    assert _collapse_text_loops("Привіт") == "Привіт"


def test_collapse_runs_inside_merge():
    """Петля, размазанная по нескольким Whisper-сегментам одного спикера,
    после _merge_consecutive становится одним текстом и схлопывается."""
    segments = [
        {"start": 0.0, "end": 1.0, "text": "Пока-пока.",
         "words": [{"start": 0.0, "end": 1.0, "word": " Пока-пока."}]},
        {"start": 1.1, "end": 2.0, "text": "Пока-пока.",
         "words": [{"start": 1.1, "end": 2.0, "word": " Пока-пока."}]},
        {"start": 2.1, "end": 3.0, "text": "Пока-пока.",
         "words": [{"start": 2.1, "end": 3.0, "word": " Пока-пока."}]},
        {"start": 3.1, "end": 4.0, "text": "Пока-пока.",
         "words": [{"start": 3.1, "end": 4.0, "word": " Пока-пока."}]},
    ]
    turns = [{"start": 0.0, "end": 4.0, "speaker": "SPEAKER_01"}]
    out = merge(segments, turns)
    assert len(out) == 1
    assert out[0]["text"] == "Пока-пока. Пока-пока."
    assert out[0]["speaker"] == "SPEAKER_01"


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
