"""Тесты обучения словаря на правках (vocab_learn.py). Запуск: python tests/test_vocab_learn.py"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from vocab_learn import pairs_from_edit  # noqa: E402


def test_term_fix():
    p = pairs_from_edit("Надішли звіт по пожика до п'ятниці", "Надішли звіт по ЖК до п'ятниці")
    assert p == [{"wrong": "пожика", "right": "ЖК"}], p


def test_name_fix():
    p = pairs_from_edit("Let's ask Katerina about the Skriptly roadmap", "Let's ask Kateryna about the Skriptly roadmap")
    assert p == [{"wrong": "Katerina", "right": "Kateryna"}], p


def test_multiword_phrase():
    p = pairs_from_edit("we use scripty for calls today", "we use Skriptly for calls today")
    assert p == [{"wrong": "scripty", "right": "Skriptly"}], p


def test_no_change_and_case_only():
    assert pairs_from_edit("hello world", "hello world") == []
    assert pairs_from_edit("send it to anna", "send it to Anna") == []


def test_rewrite_is_not_learned():
    assert pairs_from_edit("Please send the quarterly numbers tomorrow morning",
                           "Could you share last month results by Friday afternoon") == []


def test_short_function_words_ignored():
    assert pairs_from_edit("він пішов у магазин", "вона пішла у магазин") == []
    assert pairs_from_edit("I will go to the shop", "I will go to a shop") == []


def test_long_replacement_ignored():
    assert pairs_from_edit("we need to ship the very first big release", "we need to ship an entirely different new product release") == []


def test_inserts_and_deletes_ignored():
    assert pairs_from_edit("this is a test sentence", "this is a quick test sentence") == []
    assert pairs_from_edit("this is a quick test sentence", "this is a test sentence") == []


def test_garbage():
    assert pairs_from_edit("", "x") == []
    assert pairs_from_edit("x", "") == []
    assert pairs_from_edit(None, None) == []  # type: ignore[arg-type]


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print("ok", name)
