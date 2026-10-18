"""Обучение словаря на правках юзера после диктовки (приложение читает поле, куда вставило текст).

Приложение присылает то, что мы вставили (`original`), и то, что стало в том же месте после правок
(`edited`). Здесь выделяются пары wrong → right, которые пойдут в личный словарь так же, как
пары из Gemini-коррекции. Чистая логика — тесты в tests/test_vocab_learn.py.
"""
from __future__ import annotations

import difflib
import re

MAX_CHARS = 4000
MIN_SIMILARITY = 0.5   # правка сильно переписала текст — это не исправление термина, не учим
MAX_WORDS_SIDE = 3     # замена длиннее 3 слов — перефразирование, а не термин
_WORD = re.compile(r"[^\W_]+(?:[’'\-][^\W_]+)*", re.UNICODE)


def _tokens(text: str) -> list[str]:
    return _WORD.findall(text)


def _is_abbrev(w: str) -> bool:
    letters = [c for c in w if c.isalpha()]
    return len(letters) >= 2 and all(c.isupper() for c in letters)


def _worthy(right: list[str], wrong: list[str]) -> bool:
    """Правая часть годится для словаря: аббревиатура, имя/бренд с заглавной или длинное слово,
    которое не просто другая форма прежнего (він→вона, пішов→пішла — это грамматика, не термин).
    Короткие служебные слова и числа не учим."""
    similar = difflib.SequenceMatcher(a=" ".join(wrong).lower(), b=" ".join(right).lower()).ratio() >= 0.6
    for w in right:
        if w.isdigit():
            continue
        if _is_abbrev(w) or (w[:1].isupper() and len(w) >= 3):
            return True
        if len(w) >= 5 and any(c.isalpha() for c in w) and not similar:
            return True
    return False


def pairs_from_edit(original: str, edited: str) -> list[dict]:
    """[{wrong, right}] из правки юзера. Пусто, если правок нет или это переписывание."""
    original, edited = (original or "")[:MAX_CHARS], (edited or "")[:MAX_CHARS]
    if not original.strip() or not edited.strip() or original == edited:
        return []
    a, b = _tokens(original), _tokens(edited)
    if not a or not b:
        return []
    sm = difflib.SequenceMatcher(a=[w.lower() for w in a], b=[w.lower() for w in b], autojunk=False)
    if sm.ratio() < MIN_SIMILARITY:
        return []
    pairs: list[dict] = []
    for op, i1, i2, j1, j2 in sm.get_opcodes():
        if op != "replace":
            continue
        wrong_words, right_words = a[i1:i2], b[j1:j2]
        if not wrong_words or not right_words:
            continue
        if len(wrong_words) > MAX_WORDS_SIDE or len(right_words) > MAX_WORDS_SIDE:
            continue
        if not _worthy(right_words, wrong_words):
            continue
        wrong, right = " ".join(wrong_words), " ".join(right_words)
        if wrong != right and wrong.lower() != right.lower():
            pairs.append({"wrong": wrong, "right": right})
    return pairs[:10]
