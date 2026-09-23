"""Soniox STT (batch): клиент + преобразование ответа в наш формат сегментов.

Soniox отдаёт суб-словные токены: {"text", "start_ms", "end_ms", "speaker", ...},
где ведущий пробел в text = начало нового слова. Отсюда:
  tokens_to_words   → [{"word", "start", "end", "speaker"}]  (секунды)
  words_to_segments → [{"speaker", "start", "end", "text", "words"}] — новая
                      реплика на смене спикера, паузе или слишком длинном куске.
Выбран по tests/score_stt.py (2026-09-24): на эталоне 0% пропущенных слов против
1.3% у Whisper+pyannote, на реальном звонке чище границы реплик; $0.10/ч.
"""
import re
import time

API = "https://api.soniox.com/v1"
MODEL_ASYNC = "stt-async-v5"
MAX_DURATION_S = 300 * 60  # лимит Soniox на файл

_SERVICE = re.compile(r"^<.+>$")  # служебные токены (<end>, <fin>)


def tokens_to_words(tokens: list[dict]) -> list[dict]:
    words: list[dict] = []
    cur: dict | None = None
    for t in tokens:
        text = t.get("text") or ""
        if not text or _SERVICE.match(text.strip()):
            continue
        spk = str(t.get("speaker", ""))
        start = float(t.get("start_ms", 0)) / 1000
        end = float(t.get("end_ms", t.get("start_ms", 0))) / 1000
        for piece in re.split(r"(\s+)", text):
            if not piece:
                continue
            if piece.isspace():
                if cur:
                    words.append(cur)
                cur = None
                continue
            if cur is None:
                cur = {"word": piece, "start": start, "end": end, "speaker": spk}
            else:
                cur["word"] += piece
                cur["end"] = end
    if cur:
        words.append(cur)
    return words


def words_to_segments(words: list[dict], max_gap_s: float = 1.0, max_len_s: float = 30.0) -> list[dict]:
    """Слова → реплики. Режем на смене спикера, на паузе > max_gap_s и, если реплика
    стала длиннее max_len_s, — на ближайшем конце предложения (для чередования
    каналов и читаемости). speaker — сырой лейбл Soniox."""
    segs: list[dict] = []
    for w in words:
        seg = segs[-1] if segs else None
        new = (
            seg is None
            or w["speaker"] != seg["speaker"]
            or w["start"] - seg["end"] > max_gap_s
            or (seg["end"] - seg["start"] > max_len_s and seg["text"].rstrip().endswith((".", "?", "!", "…")))
        )
        if new:
            segs.append({"speaker": w["speaker"], "start": w["start"], "end": w["end"],
                         "text": w["word"], "words": [{"start": w["start"], "end": w["end"], "word": " " + w["word"]}]})
        else:
            seg["end"] = w["end"]
            seg["text"] += " " + w["word"]
            seg["words"].append({"start": w["start"], "end": w["end"], "word": " " + w["word"]})
    return segs


def transcribe(api_key: str, audio_path: str, language: str | None, diarize: bool,
               context: dict | None = None, poll_s: float = 1.5, timeout_s: float = 3000) -> list[dict]:
    """Загрузка файла → транскрипция → токены. Файл и транскрипция удаляются
    (у Soniox лимит 1000 файлов / 2000 транскрипций на аккаунт)."""
    import requests

    h = {"Authorization": f"Bearer {api_key}"}
    with open(audio_path, "rb") as f:
        r = requests.post(f"{API}/files", headers=h, files={"file": f}, timeout=600)
    if not r.ok:
        raise RuntimeError(f"soniox upload {r.status_code}: {r.text[:300]}")
    file_id = r.json()["id"]
    tr_id = None
    try:
        body = {"model": MODEL_ASYNC, "file_id": file_id,
                "enable_speaker_diarization": diarize, "enable_language_identification": True}
        if language:
            body["language_hints"] = [language]
        if context:
            body["context"] = context
        r = requests.post(f"{API}/transcriptions", headers=h, json=body, timeout=60)
        if not r.ok:
            raise RuntimeError(f"soniox create {r.status_code}: {r.text[:300]}")
        tr_id = r.json()["id"]
        deadline = time.time() + timeout_s
        while True:
            st = requests.get(f"{API}/transcriptions/{tr_id}", headers=h, timeout=30).json()
            if st.get("status") == "completed":
                break
            if st.get("status") == "error":
                raise RuntimeError(f"soniox: {st.get('error_message')}")
            if time.time() > deadline:
                raise RuntimeError("soniox: timed out waiting for transcription")
            time.sleep(poll_s)
        r = requests.get(f"{API}/transcriptions/{tr_id}/transcript", headers=h, timeout=120)
        r.raise_for_status()
        return r.json().get("tokens") or []
    finally:
        for url in ([f"{API}/transcriptions/{tr_id}"] if tr_id else []) + [f"{API}/files/{file_id}"]:
            try:
                requests.delete(url, headers=h, timeout=30)
            except Exception:
                pass


def build_context(terms: list[str] | None, text: str | None) -> dict | None:
    """Личный словарь → context.terms, поле «Context» юзера → context.text.
    Лимит Soniox ~10k символов на весь context — режем с запасом."""
    ctx: dict = {}
    clean_terms: list[str] = []
    budget = 3000  # символов на термины: вместе с text гарантированно ниже лимита Soniox
    for t in terms or []:
        t = (t or "").strip()[:80]
        if t and len(clean_terms) < 100 and budget - len(t) >= 0:
            clean_terms.append(t)
            budget -= len(t) + 2
    if clean_terms:
        ctx["terms"] = clean_terms
    if text and text.strip():
        ctx["text"] = text.strip()[:4000]
    return ctx or None
