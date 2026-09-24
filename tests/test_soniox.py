"""Тесты преобразования ответа Soniox (soniox.py).

Запуск:  python tests/test_soniox.py   (чистый stdlib)
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import soniox  # noqa: E402
from soniox import build_context, tokens_to_words, words_to_segments  # noqa: E402


def _tok(text, start, end, spk="1"):
    return {"text": text, "start_ms": start, "end_ms": end, "speaker": spk}


def test_subword_tokens_join_into_words():
    toks = [_tok("Dob", 0, 100), _tok("rý", 100, 200), _tok(" den", 250, 500), _tok(",", 500, 510),
            _tok(" Jano", 600, 900), _tok("<end>", 900, 900)]
    words = tokens_to_words(toks)
    assert [w["word"] for w in words] == ["Dobrý", "den,", "Jano"], words
    assert words[0]["start"] == 0.0 and words[0]["end"] == 0.2
    assert words[2]["end"] == 0.9


def test_segments_split_on_speaker_change():
    toks = [_tok("Ahoj", 0, 300, "1"), _tok(" jak", 400, 600, "1"), _tok(" Dobře", 800, 1100, "2")]
    segs = words_to_segments(tokens_to_words(toks))
    assert [(s["speaker"], s["text"]) for s in segs] == [("1", "Ahoj jak"), ("2", "Dobře")]
    assert segs[0]["words"][1]["word"] == " jak"


def test_segments_split_on_long_pause_same_speaker():
    toks = [_tok("Ano", 0, 300), _tok(" jasně", 5000, 5400)]
    segs = words_to_segments(tokens_to_words(toks))
    assert len(segs) == 2


def test_long_segment_splits_at_sentence_end():
    toks = []
    t = 0
    for i in range(40):  # ~40 с без пауз, конец предложения на 20-м слове
        toks.append(_tok((" " if i else "") + ("konec." if i == 19 else "slovo"), t, t + 900))
        t += 1000
    segs = words_to_segments(tokens_to_words(toks), max_len_s=15)
    assert len(segs) == 2 and segs[0]["text"].endswith("konec."), [s["text"][-20:] for s in segs]


def test_context_builder():
    assert build_context([], None) is None
    ctx = build_context(["HubSpot", " ", "CRM"], "  Porada o marketingu  ")
    assert ctx == {"terms": ["HubSpot", "CRM"], "text": "Porada o marketingu"}


def test_context_stays_under_soniox_limit():
    ctx = build_context([f"term{i}-" + "x" * 250 for i in range(100)], "y" * 20000)
    size = sum(len(t) for t in ctx["terms"]) + len(ctx["text"])
    assert size < 8000, size


def test_temporary_key_request_is_bounded():
    """Ключ живого транскрипта: только для WebSocket, сессия не длиннее остатка
    минут юзера и потолка Soniox (5 ч), reference id в пределах 256 символов."""
    import types

    sent = {}

    class Resp:
        ok = True
        def json(self):
            return {"api_key": "snx_temp_x", "expires_at": "2026-09-24T10:00:00Z"}

    def fake_post(url, headers, json, timeout):
        sent.update(url=url, auth=headers["Authorization"], body=json)
        return Resp()

    real = sys.modules.get("requests")
    sys.modules["requests"] = types.SimpleNamespace(post=fake_post)
    try:
        out = soniox.create_temporary_key("perm", "live:" + "u" * 400, max_session_s=10 ** 6)
        assert out == {"api_key": "snx_temp_x", "expires_at": "2026-09-24T10:00:00Z"}
        assert sent["url"].endswith("/auth/temporary-api-key") and sent["auth"] == "Bearer perm"
        body = sent["body"]
        assert body["usage_type"] == "transcribe_websocket"
        assert body["max_session_duration_seconds"] == soniox.MAX_RT_SESSION_S
        assert len(body["client_reference_id"]) == 256
        soniox.create_temporary_key("perm", "r", max_session_s=5)
        assert sent["body"]["max_session_duration_seconds"] == 60  # не меньше минуты
    finally:
        if real is not None:
            sys.modules["requests"] = real
        else:
            del sys.modules["requests"]


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
