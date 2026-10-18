"""Тесты вырезания тишины (silence_trim.py). Запуск: venv\\Scripts\\python.exe tests/test_silence_trim.py"""
import os
import sys
import tempfile

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import silence_trim as st  # noqa: E402

SR = 16000


def tone(seconds: float, amp: float = 0.2, freq: float = 220) -> np.ndarray:
    t = np.arange(int(seconds * SR)) / SR
    return (amp * np.sin(2 * np.pi * freq * t)).astype(np.float32)


def quiet(seconds: float) -> np.ndarray:
    return np.random.default_rng(1).normal(0, 0.0003, int(seconds * SR)).astype(np.float32)


def test_long_silence_is_cut_short_pause_kept():
    sig = np.concatenate([tone(3), quiet(1.0), tone(3), quiet(20), tone(2)])  # 1 с пауза остаётся, 20 с режется
    total = len(sig) / SR
    spans = st.plan_spans(st.frame_db(sig, SR), total)
    assert spans is not None and len(spans) == 2, spans
    assert st.trimmed_duration(spans) < total - 15


def test_little_silence_not_worth_it():
    sig = np.concatenate([tone(10), quiet(3), tone(10)])
    assert st.plan_spans(st.frame_db(sig, SR), len(sig) / SR) is None


def test_all_silence_untouched():
    sig = quiet(30)
    assert st.plan_spans(st.frame_db(sig, SR), 30) is None


def test_to_original_roundtrip():
    spans = [st.Span(2.0, 5.0, 0.0), st.Span(20.0, 24.0, 3.0), st.Span(40.0, 41.0, 7.0)]
    assert abs(st.to_original(0.0, spans) - 2.0) < 1e-9
    assert abs(st.to_original(2.9, spans) - 4.9) < 1e-9
    assert abs(st.to_original(3.0, spans) - 20.0) < 1e-9
    assert abs(st.to_original(6.5, spans) - 23.5) < 1e-9
    assert abs(st.to_original(7.5, spans) - 40.5) < 1e-9
    assert abs(st.to_original(99, spans) - 41.0) < 1e-9  # за концом — прижимаем


def test_write_trimmed_is_sample_exact_and_words_map_back():
    import soundfile as sf

    # три «слова» разной высоты, между ними длинная тишина — слово ищем по частоте после склейки
    sig = np.concatenate([quiet(5), tone(2, 0.3, 300), quiet(30), tone(2, 0.3, 600), quiet(30), tone(2, 0.3, 900), quiet(5)])
    with tempfile.TemporaryDirectory() as d:
        a, b = os.path.join(d, "a.wav"), os.path.join(d, "b.wav")
        sf.write(a, sig, SR, subtype="PCM_16")
        spans, tot = st.analyse(a)
        assert spans and len(spans) == 3, spans
        assert abs(tot - len(sig) / SR) < 0.02
        st.write_trimmed(a, spans, b)
        out, sr = sf.read(b, dtype="float32")
        assert sr == SR
        assert abs(len(out) / SR - st.trimmed_duration(spans)) < 0.01
        # у каждого слова в укороченной дорожке время → обратно в исходное: попадает в исходное слово
        for freq, orig_t in ((300, 5.0), (600, 37.0), (900, 69.0)):
            hit = None
            for k in range(0, len(out) - SR // 2, SR // 4):
                w = out[k:k + SR // 2]
                if np.abs(w).max() > 0.2:
                    f = np.argmax(np.abs(np.fft.rfft(w))) * SR / len(w)
                    if abs(f - freq) < 15:
                        hit = k / SR
                        break
            assert hit is not None, freq
            back = st.to_original(hit + 0.1, spans)
            assert orig_t - 0.2 < back < orig_t + 2.2, (freq, hit, back)


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print("ok", name)
