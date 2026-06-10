"""Тесты word-level alignment merger'а (ISS-13 / MYK-17).

Запуск:  python tests/test_merger.py   (или pytest tests/)
Чистый stdlib — работает без venv.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from merger import merge, _best_speaker_for  # noqa: E402


def _words(spec: list[tuple[float, float, str]]) -> list[dict]:
    return [{"start": s, "end": e, "word": " " + w} for s, e, w in spec]


def test_long_segment_split_at_speaker_change():
    """Whisper склеил быстрый диалог в один сегмент — режем по смене спикера."""
    segments = [{
        "start": 0.0, "end": 6.0, "text": "привет как дела нормально а у тебя",
        "words": _words([
            (0.0, 0.5, "привет"), (0.6, 1.0, "как"), (1.1, 1.5, "дела"),
            (3.0, 3.6, "нормально"), (3.7, 4.0, "а"), (4.1, 4.4, "у"), (4.5, 5.0, "тебя"),
        ]),
    }]
    turns = [
        {"start": 0.0, "end": 2.0, "speaker": "SPEAKER_00"},
        {"start": 2.8, "end": 6.0, "speaker": "SPEAKER_01"},
    ]
    out = merge(segments, turns)
    assert len(out) == 2, f"expected split into 2: {out}"
    assert out[0]["speaker"] == "SPEAKER_00" and "дела" in out[0]["text"]
    assert out[1]["speaker"] == "SPEAKER_01" and "нормально" in out[1]["text"]


def test_short_segment_majority_vote():
    """Короткая реплика (≤2с): pyannote-шум в середине не дробит её на ABAB."""
    segments = [{
        "start": 0.0, "end": 1.8, "text": "ну да я тоже так думаю",
        "words": _words([
            (0.0, 0.2, "ну"), (0.25, 0.4, "да"), (0.45, 0.6, "я"),
            (0.65, 0.9, "тоже"), (0.95, 1.3, "так"), (1.35, 1.75, "думаю"),
        ]),
    }]
    turns = [
        {"start": 0.0, "end": 0.6, "speaker": "SPEAKER_00"},
        {"start": 0.6, "end": 0.95, "speaker": "SPEAKER_01"},  # шумный микро-турн
        {"start": 0.95, "end": 2.0, "speaker": "SPEAKER_00"},
    ]
    out = merge(segments, turns)
    assert len(out) == 1
    assert out[0]["speaker"] == "SPEAKER_00"


def test_gap_word_goes_to_nearest_turn():
    """Первое слово реплики в паузе между турнами должно уйти БЛИЖАЙШЕМУ
    (следующему) турну, а не предыдущему спикеру слепым fill'ом."""
    segments = [{
        "start": 0.0, "end": 5.0, "text": "okay so let me explain",
        "words": _words([
            (0.0, 1.0, "okay"),
            # пауза; "so" в 2.4-2.6 — между турнами, ближе ко второму (2.8)
            (2.4, 2.6, "so"),
            (2.9, 3.2, "let"), (3.3, 3.5, "me"), (3.6, 4.2, "explain"),
        ]),
    }]
    turns = [
        {"start": 0.0, "end": 1.1, "speaker": "SPEAKER_00"},
        {"start": 2.8, "end": 5.0, "speaker": "SPEAKER_01"},
    ]
    out = merge(segments, turns)
    assert len(out) == 2, f"expected 2 blocks: {out}"
    assert out[1]["speaker"] == "SPEAKER_01"
    assert out[1]["text"].startswith("so"), f"gap word not snapped to next turn: {out}"


def test_far_word_falls_back_to_fill():
    """Слово дальше NEAREST_TURN_MAX_GAP_S от всех турнов → UNKNOWN →
    закрывается forward-fill'ом, UNKNOWN наружу не выходит."""
    segments = [{
        "start": 0.0, "end": 10.0, "text": "start lonely end",
        "words": _words([
            (0.0, 0.5, "start"),
            (5.0, 5.3, "lonely"),   # 3.5с от ближайшего турна
            (9.5, 10.0, "end"),
        ]),
    }]
    turns = [
        {"start": 0.0, "end": 1.0, "speaker": "SPEAKER_00"},
        {"start": 9.0, "end": 10.0, "speaker": "SPEAKER_01"},
    ]
    out = merge(segments, turns)
    assert all(s["speaker"] != "SPEAKER_UNKNOWN" for s in out), f"UNKNOWN leaked: {out}"


def test_smoothing_kills_aba_blip():
    """Микро-вставка чужого спикера между двумя блоками одного — переназначается."""
    segments = [
        {"start": 0.0, "end": 3.0, "text": "это первая длинная фраза говорящего",
         "words": _words([(0.0, 3.0, "это первая длинная фраза говорящего")])},
        {"start": 3.1, "end": 3.5, "text": "ага",
         "words": _words([(3.1, 3.5, "ага")])},
        {"start": 3.6, "end": 7.0, "text": "и вторая длинная фраза того же",
         "words": _words([(3.6, 7.0, "и вторая длинная фраза того же")])},
    ]
    turns = [
        {"start": 0.0, "end": 3.05, "speaker": "SPEAKER_00"},
        {"start": 3.05, "end": 3.55, "speaker": "SPEAKER_01"},  # шумный blip
        {"start": 3.55, "end": 7.0, "speaker": "SPEAKER_00"},
    ]
    out = merge(segments, turns)
    assert len(out) == 1, f"ABA not smoothed+merged: {out}"
    assert out[0]["speaker"] == "SPEAKER_00"


def test_segment_level_fallback_without_words():
    segments = [
        {"start": 0.0, "end": 2.0, "text": "hello there"},
        {"start": 2.5, "end": 4.0, "text": "hi back"},
    ]
    turns = [
        {"start": 0.0, "end": 2.2, "speaker": "SPEAKER_00"},
        {"start": 2.3, "end": 4.0, "speaker": "SPEAKER_01"},
    ]
    out = merge(segments, turns)
    assert [s["speaker"] for s in out] == ["SPEAKER_00", "SPEAKER_01"]


def test_best_speaker_overlap_beats_proximity():
    turns = [
        {"start": 0.0, "end": 1.0, "speaker": "A"},
        {"start": 1.1, "end": 2.0, "speaker": "B"},
    ]
    # Пересекается с B → B, хотя A тоже рядом
    assert _best_speaker_for(1.05, 1.3, turns) == "B"
    # Чистая пауза, ближе к A
    assert _best_speaker_for(1.01, 1.04, turns) == "A"
    # Далеко от всех → UNKNOWN
    assert _best_speaker_for(10.0, 10.5, turns) == "SPEAKER_UNKNOWN"


def test_empty_inputs():
    assert merge([], []) == []
    out = merge([{"start": 0, "end": 1, "text": "x"}], [])
    assert out[0]["speaker"] == "SPEAKER_UNKNOWN"


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
