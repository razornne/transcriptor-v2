"""Тесты двухканальной логики (channels.py).

Запуск:  python tests/test_channels.py   (нужен numpy из venv)
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np  # noqa: E402

from channels import (  # noqa: E402
    MIC_LABEL, ChannelStats, drop_echo, interleave, label, relabel, split_on_pauses,
)

SR = 16000
rng = np.random.default_rng(0)


def _speech(seconds: float, level: float = 0.2) -> np.ndarray:
    # шум, промодулированный "слогами" — грубая имитация речи с паузами
    t = np.arange(int(seconds * SR)) / SR
    envelope = (np.sin(2 * np.pi * 1.5 * t) > 0).astype("float64")
    return rng.normal(0, level, t.size) * envelope


def _verdict(left, right) -> str:
    st = ChannelStats()
    for i in range(0, left.size, SR):  # блоками по секунде, как в пайплайне
        st.feed(left[i:i + SR], right[i:i + SR])
    return st.verdict()


def test_different_channels_are_dual():
    assert _verdict(_speech(20), _speech(20)) == "dual"


def test_same_audio_in_both_channels_is_mono():
    x = _speech(20)
    assert _verdict(x, x * 0.9) == "mono"


def test_silent_right_is_left_only():
    assert _verdict(_speech(20), np.zeros(20 * SR)) == "left_only"


def test_silent_left_is_right_only():
    assert _verdict(np.zeros(20 * SR), _speech(20)) == "right_only"


def test_echo_leak_still_dual():
    # микрофон = своя речь + тихое запаздывающее эхо звонка — это всё ещё два канала
    call = _speech(20)
    mic = _speech(20) + np.roll(call, int(0.25 * SR)) * 0.2
    assert _verdict(mic, call) == "dual"


def _seg(start, end, text):
    words, step = [], (end - start) / max(len(text.split()), 1)
    for i, w in enumerate(text.split()):
        words.append({"start": start + i * step, "end": start + (i + 1) * step, "word": " " + w})
    return {"start": start, "end": end, "text": text, "words": words}


def test_echo_segment_dropped():
    call = [_seg(10.0, 13.0, "migrace dat je hotová z osmdesáti procent")]
    mic = [
        _seg(10.3, 13.3, "migrace dat je hotová z osmdesáti procent"),  # эхо
        _seg(14.0, 15.0, "výborně díky"),
    ]
    kept = drop_echo(mic, call)
    assert [s["text"] for s in kept] == ["výborně díky"], kept


def test_same_words_far_apart_are_not_echo():
    call = [_seg(10.0, 12.0, "tak jo díky moc")]
    mic = [_seg(40.0, 42.0, "tak jo díky moc")]
    assert len(drop_echo(mic, call)) == 1


def test_talking_over_is_kept():
    call = [_seg(10.0, 13.0, "náklady na akvizici jsou vysoké")]
    mic = [_seg(10.5, 14.0, "počkej ale to přece není pravda vůbec jsou vysoké")]
    assert len(drop_echo(mic, call)) == 1


def test_split_on_pauses_restores_turn_order():
    # Whisper склеил две реплики звонка через паузу, в которой говорил микрофон
    call_seg = {"start": 10.0, "end": 30.0, "text": "dobrý den díky moc", "words": [
        {"start": 10.0, "end": 10.4, "word": " dobrý"}, {"start": 10.5, "end": 10.9, "word": " den"},
        {"start": 28.0, "end": 28.5, "word": " díky"}, {"start": 28.6, "end": 30.0, "word": " moc"},
    ]}
    parts = split_on_pauses([call_seg])
    assert [p["text"] for p in parts] == ["dobrý den", "díky moc"], parts
    mic = label([_seg(15.0, 20.0, "jak se máte")], MIC_LABEL)
    out = interleave(mic, label(parts, "SPEAKER_01"))
    assert [s["speaker"] for s in out] == ["SPEAKER_01", MIC_LABEL, "SPEAKER_01"], out


def test_interleave_orders_and_merges():
    mic = label([_seg(0, 2, "ahoj"), _seg(2.2, 3, "jak se máš")], MIC_LABEL)
    call = label([_seg(3.5, 5, "dobře díky")], "SPEAKER_X")
    out = interleave(mic, call)
    assert [s["speaker"] for s in out] == [MIC_LABEL, "SPEAKER_X"]
    assert out[0]["text"] == "ahoj jak se máš"


def test_relabel_keeps_mic_and_orders_others():
    segs = [
        {"speaker": "SPEAKER_03", "start": 0, "end": 1, "text": "a"},
        {"speaker": MIC_LABEL, "start": 1, "end": 2, "text": "b"},
        {"speaker": "SPEAKER_00", "start": 2, "end": 3, "text": "c"},
    ]
    out = relabel(segs, mapping_start=1, keep=(MIC_LABEL,))
    assert [s["speaker"] for s in out] == ["SPEAKER_01", MIC_LABEL, "SPEAKER_02"]


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
