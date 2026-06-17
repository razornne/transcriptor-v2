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


def test_best_speaker_midpoint_containment():
    turns = [
        {"start": 0.0, "end": 1.0, "speaker": "A"},
        {"start": 1.1, "end": 2.0, "speaker": "B"},
    ]
    # Центр слова (1.175) внутри турна B → B
    assert _best_speaker_for(1.05, 1.3, turns) == "B"
    # Центр (1.025) в паузе, ближе к границе A → A
    assert _best_speaker_for(1.01, 1.04, turns) == "A"
    # Далеко от всех (центр 10.25, >2с от любой границы) → UNKNOWN
    assert _best_speaker_for(10.0, 10.5, turns) == "SPEAKER_UNKNOWN"


def test_boundary_first_word_not_glued_to_previous():
    """Регресс MYK-17/ISS-13 (speaker bleeding): pyannote растягивает хвост
    турна предыдущего спикера за реальную границу, задевая первое слово реплики.
    Overlap-логика приклеивала это слово к ПРЕДЫДУЩЕМУ (больше пересечения по
    краю). По СРЕДНЕЙ ТОЧКЕ слово уходит НОВОМУ спикеру."""
    turns = [
        {"start": 0.0, "end": 2.5, "speaker": "A"},   # хвост А растянут до 2.5
        {"start": 2.0, "end": 5.0, "speaker": "B"},   # B реально начался в 2.0
    ]
    # слово "Не" 1.9-2.3 (центр 2.1): overlap с A (0.4) > overlap с B (0.3) →
    # старая логика дала бы A. Центр 2.1 ∈ обоих → берём позже начавшийся B.
    assert _best_speaker_for(1.9, 2.3, turns) == "B"

    # И в реальном сегменте: первое слово реплики не утекает в предыдущий блок.
    segments = [{
        "start": 0.0, "end": 4.0, "text": "нічого не важко було",
        "words": _words([
            (0.2, 1.2, "нічого"),          # центр 0.7 → A
            (2.05, 2.35, "не"),            # центр 2.2 → B (раньше → A)
            (2.5, 2.9, "важко"), (3.0, 3.3, "було"),
        ]),
    }]
    out = merge(segments, turns)
    assert len(out) == 2, f"expected 2 blocks: {out}"
    assert out[0]["speaker"] == "A" and out[0]["text"].strip() == "нічого"
    assert out[1]["speaker"] == "B" and out[1]["text"].startswith("не")


def test_smooth_threshold_preserves_minority_speaker():
    """num_speakers режим: 0.4s порог сохраняет короткие реплики миноритарного
    спикера ("Так", 0.5s), которые default 1.0s порог поглотил бы в Speaker 1.
    Воспроизводит регресс 'Оренда екрану': обе реплики 0.5s должны выжить."""
    segments = [
        {"start":  0.0, "end":  5.0, "text": "розкажу як завантажити документ"},
        {"start":  5.1, "end":  5.6, "text": "Так"},          # SP2, 0.5s — выживает при 0.4
        {"start":  5.7, "end": 10.0, "text": "відкриваємо реєстр"},
        {"start": 10.1, "end": 10.6, "text": "Зрозуміло"},    # SP2, 0.5s — выживает при 0.4
        {"start": 10.7, "end": 15.0, "text": "натискаємо кнопку"},
    ]
    turns = [
        {"start":  0.0, "end":  5.05, "speaker": "SPEAKER_00"},
        {"start":  5.05, "end":  5.65, "speaker": "SPEAKER_01"},
        {"start":  5.65, "end": 10.05, "speaker": "SPEAKER_00"},
        {"start": 10.05, "end": 10.65, "speaker": "SPEAKER_01"},
        {"start": 10.65, "end": 15.0, "speaker": "SPEAKER_00"},
    ]
    # Default (1.0s) — поглощает 0.5s SPEAKER_01 в SPEAKER_00
    out_default = merge(segments, turns)
    speakers_default = [s["speaker"] for s in out_default]
    assert all(sp == "SPEAKER_00" for sp in speakers_default), (
        f"default should collapse minority: {speakers_default}"
    )

    # num_speakers mode (0.4s) — сохраняет SPEAKER_01
    out_explicit = merge(segments, turns, smooth_threshold=0.4)
    speakers_explicit = [s["speaker"] for s in out_explicit]
    assert "SPEAKER_01" in speakers_explicit, (
        f"0.4s threshold should preserve SPEAKER_01 interjections: {speakers_explicit}"
    )


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
