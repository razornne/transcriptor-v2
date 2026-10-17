"""Имена спикеров из самого разговора: обращения («Привіт, Миколо») и самопредставления.

Только чистая логика (промпт и проверка ответа модели) — вызов Gemini делает app.py.
Принцип: модель лишь *предлагает*, а мы отбрасываем всё, что не подтверждено
цитатой из транскрипта. Лучше пропустить имя, чем приписать человеку чужое.
"""
import json
import re

MAX_CHARS = 36000  # имена звучат в начале разговора; хвост длинной записи не нужен

PROMPT = """You read a transcript of a spoken conversation. Speakers are labelled SPEAKER_00, SPEAKER_01, ...
Find the real first name of a speaker ONLY when the conversation states it clearly:
- another speaker addresses them by name ("Привіт, Миколо", "Thanks, Anna"): the addressee is the speaker who is spoken to (usually the one who answers next);
- the speaker introduces themselves ("I'm Anna", "мене звати Олена", "меня зовут Иван").

Rules:
- Return the name in its base (nominative) form: "Миколо" -> "Микола", "Олено" -> "Олена". Keep the script of the transcript.
- Never guess from the topic, gender, role or voice. If the name could belong to more than one speaker, or is the name of a third person being talked ABOUT, skip it.
- At most one name per speaker. Skip speakers whose name is not clear. An empty list is a fine answer.
- "evidence" must be a short EXACT quote from the transcript (max 80 characters) that contains the name as it was said.

Answer with JSON only, no commentary:
{"names":[{"speaker":"SPEAKER_01","name":"Микола","evidence":"Привіт, Миколо"}]}

Transcript (each line: [speaker @seconds] text):
<<<
{transcript}
>>>"""

_WORD = r"[^\W\d_](?:[^\W\d_]|['’\-]){1,28}"  # буквы, апостроф, дефис; без цифр
_NAME_RE = re.compile(rf"{_WORD}(?: {_WORD})?", re.UNICODE)
# фразы самопредставления на языках продукта (en/ru/uk/pl/cs)
_INTRO_RE = re.compile(
    r"(\bi['’]?m\b|\bi am\b|\bmy name\b|\bthis is\b|меня зовут|я\s*[-—]|мене звати|мене\s+звуть|це\s|я\s+[A-ZА-ЯІЇЄҐ]|"
    r"nazywam się|jestem\b|jmenuji se|jsem\b)",
    re.IGNORECASE | re.UNICODE,
)


def _norm(s: str) -> str:
    """Для сравнения цитат: нижний регистр, без пунктуации, один пробел."""
    return re.sub(r"\s+", " ", re.sub(r"[^\w\s]", " ", s.lower(), flags=re.UNICODE)).strip()


def build_transcript(segments: list[dict], max_chars: int = MAX_CHARS) -> str:
    lines, total = [], 0
    for s in segments:
        text = str(s.get("text") or "").strip()
        if not text:
            continue
        line = f"[{s.get('speaker', 'SPEAKER_00')} @{float(s.get('start') or 0):.0f}] {text}"
        total += len(line) + 1
        if total > max_chars:
            break
        lines.append(line)
    return "\n".join(lines)


def build_prompt(segments: list[dict]) -> str:
    return PROMPT.replace("{transcript}", build_transcript(segments))


def _extract_json(raw: str):
    raw = (raw or "").strip()
    raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw, flags=re.IGNORECASE)
    try:
        return json.loads(raw)
    except ValueError:
        m = re.search(r"\{.*\}", raw, re.DOTALL)
        if not m:
            return None
        try:
            return json.loads(m.group(0))
        except ValueError:
            return None


def parse_suggestions(raw: str, segments: list[dict]) -> list[dict]:
    """Ответ модели -> проверенные подсказки [{speaker, name, evidence, at}]."""
    data = _extract_json(raw)
    items = data.get("names") if isinstance(data, dict) else None
    if not isinstance(items, list):
        return []
    labels = {str(s.get("speaker")) for s in segments if s.get("speaker") is not None}
    prepared = [(str(s.get("speaker")), _norm(str(s.get("text") or "")), float(s.get("start") or 0)) for s in segments]

    out: list[dict] = []
    for it in items:
        if not isinstance(it, dict):
            continue
        speaker = str(it.get("speaker") or "")
        name = re.sub(r"\s+", " ", str(it.get("name") or "")).strip()
        evidence = str(it.get("evidence") or "").strip()[:120]
        if speaker not in labels or not _NAME_RE.fullmatch(name) or len(evidence) < 3:
            continue
        ev = _norm(evidence)
        if not ev:
            continue
        # цитата обязана быть в тексте; запоминаем, кто и когда это сказал
        hit = next(((sp, start) for sp, text, start in prepared if ev in text), None)
        if hit is None:
            continue
        said_by, at = hit
        # обращение к спикеру говорит ДРУГОЙ человек; своё имя человек называет только в представлении
        if said_by == speaker and not _INTRO_RE.search(evidence):
            continue
        out.append({"speaker": speaker, "name": name, "evidence": evidence, "at": round(at, 1)})

    # один спикер — одно имя; одно имя у двух спикеров — неоднозначно, пропускаем оба
    seen: dict[str, list[dict]] = {}
    for o in out:
        seen.setdefault(o["speaker"], []).append(o)
    out = [v[0] for v in seen.values()]
    names: dict[str, int] = {}
    for o in out:
        names[o["name"].lower()] = names.get(o["name"].lower(), 0) + 1
    return [o for o in out if names[o["name"].lower()] == 1]
