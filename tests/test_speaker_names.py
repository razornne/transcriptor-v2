"""Проверка подсказок имён спикеров: принимаем только то, что подтверждено цитатой.
Запуск: python tests/test_speaker_names.py"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import speaker_names as sn  # noqa: E402

SEGS = [
    {"speaker": "SPEAKER_00", "start": 38.0, "end": 40.0, "text": "Привіт, Миколо. Чуєш мене нормально?"},
    {"speaker": "SPEAKER_01", "start": 41.0, "end": 42.0, "text": "Так, чую. Привіт."},
    {"speaker": "SPEAKER_00", "start": 43.0, "end": 44.0, "text": "Як справи з дашбордом?"},
    {"speaker": "SPEAKER_02", "start": 62.0, "end": 64.0, "text": "Мене звати Олена, я допоможу з даними."},
    {"speaker": "SPEAKER_00", "start": 70.0, "end": 72.0, "text": "Ми з Іваном бачились вчора."},
]


def answer(*names):
    return json.dumps({"names": list(names)}, ensure_ascii=False)


def test_addressed_by_name():
    got = sn.parse_suggestions(answer({"speaker": "SPEAKER_01", "name": "Микола", "evidence": "Привіт, Миколо"}), SEGS)
    assert got == [{"speaker": "SPEAKER_01", "name": "Микола", "evidence": "Привіт, Миколо", "at": 38.0}], got


def test_self_introduction_is_accepted():
    got = sn.parse_suggestions(answer({"speaker": "SPEAKER_02", "name": "Олена", "evidence": "Мене звати Олена"}), SEGS)
    assert len(got) == 1 and got[0]["name"] == "Олена" and got[0]["at"] == 62.0


def test_quote_must_exist_in_transcript():
    got = sn.parse_suggestions(answer({"speaker": "SPEAKER_01", "name": "Микола", "evidence": "Добрий день, Миколо"}), SEGS)
    assert got == []


def test_own_line_without_introduction_is_rejected():
    # SPEAKER_00 сам сказал «Миколо» — это обращение к другому, а не его имя
    got = sn.parse_suggestions(answer({"speaker": "SPEAKER_00", "name": "Микола", "evidence": "Привіт, Миколо"}), SEGS)
    assert got == []


def test_third_person_name_is_not_assigned_if_quote_is_theirs():
    # «Ми з Іваном…» — про третього; модель могла приписати Івана SPEAKER_00
    got = sn.parse_suggestions(answer({"speaker": "SPEAKER_00", "name": "Іван", "evidence": "Ми з Іваном бачились"}), SEGS)
    assert got == []


def test_unknown_speaker_and_bad_names_are_dropped():
    bad = [
        {"speaker": "SPEAKER_09", "name": "Микола", "evidence": "Привіт, Миколо"},
        {"speaker": "SPEAKER_01", "name": "", "evidence": "Привіт, Миколо"},
        {"speaker": "SPEAKER_01", "name": "Микола123", "evidence": "Привіт, Миколо"},
        {"speaker": "SPEAKER_01", "name": "а" * 60, "evidence": "Привіт, Миколо"},
    ]
    assert sn.parse_suggestions(answer(*bad), SEGS) == []


def test_same_name_for_two_speakers_is_ambiguous():
    segs = SEGS + [{"speaker": "SPEAKER_01", "start": 80.0, "end": 81.0, "text": "Мене звати Микола."}]
    got = sn.parse_suggestions(answer(
        {"speaker": "SPEAKER_01", "name": "Микола", "evidence": "Привіт, Миколо"},
        {"speaker": "SPEAKER_02", "name": "Микола", "evidence": "Мене звати Микола"},
    ), segs)
    assert got == []


def test_tolerates_fences_and_garbage():
    raw = "```json\n" + answer({"speaker": "SPEAKER_01", "name": "Микола", "evidence": "Привіт, Миколо"}) + "\n```"
    assert len(sn.parse_suggestions(raw, SEGS)) == 1
    assert sn.parse_suggestions("not json", SEGS) == []
    assert sn.parse_suggestions("", SEGS) == []
    assert sn.parse_suggestions('{"names": "x"}', SEGS) == []


def test_prompt_contains_lines_and_is_capped():
    p = sn.build_prompt(SEGS)
    assert "[SPEAKER_01 @41] Так, чую. Привіт." in p
    long = [{"speaker": "SPEAKER_00", "start": i, "end": i + 1, "text": "слово " * 40} for i in range(2000)]
    assert len(sn.build_transcript(long)) <= sn.MAX_CHARS


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print("ok", name)
