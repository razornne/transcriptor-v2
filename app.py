"""Flask backend для transcriptor-v2.

Полный пайплайн: WebM аудио → faster-whisper → pyannote → merge → JSON со спикерами.
Доп. эндпоинт /api/title использует LLM для генерации заголовка по транскрипту.

USE_MODAL=true → тяжёлый ML и LLM запускаются на Modal (облачный A10G).
                  Flask становится тонким прокси, ноут не нужен для инференса.
USE_MODAL не задан → локальный режим: faster-whisper + pyannote + Ollama на ноуте.

CORS открыт по умолчанию — рассчитан на фронт на отдельном домене (Vercel).
"""
import os
import re
import subprocess
import threading
import time
import uuid
from datetime import datetime, timedelta

import jwt as pyjwt
import requests
from flask import Flask, render_template, jsonify, request, g, make_response, redirect, Response
from flask_cors import CORS
from dotenv import load_dotenv

# ── Modal / Local mode switch ──────────────────────────────────
load_dotenv()
USE_MODAL = os.environ.get("USE_MODAL", "").lower() in ("1", "true", "yes")

if USE_MODAL:
    import modal as _modal
    _transcriptor = _modal.Cls.from_name("transcriptor-v2", "Transcriptor")()
else:
    from transcriber import transcribe
    from diarizer import diarize
    from merger import merge


# ── Job tracking ────────────────────────────────────────────────
# Два режима:
#   USE_MODAL=true  → spawn() возвращает Modal FunctionCall, его object_id —
#                     наш job_id. Polling через FunctionCall.from_id().get(0).
#                     Flask-контейнер не висит, скейлится в ноль.
#   USE_MODAL=false → старый паттерн: in-memory dict + Python threads.
#                     Работает только пока процесс жив (для локалки норм).
#
# job_id в Modal-режиме имеет префикс t_/g_/c_ — кодирует тип задачи
# (transcribe/generate/chat) чтобы на polling вернуть правильный shape.

JOBS: dict[str, dict] = {}     # только для local mode
JOBS_LOCK = threading.Lock()
JOB_TTL_MINUTES = 30

# job_id → progress_key: in-memory mapping для чтения real-time прогресса из modal.Dict.
# Best-effort: если Flask контейнер рестартует, mapping теряется и фронт
# фоллбэкает на estimation-based прогресс — это нормально, транскрипция продолжается.
_job_progress_keys: dict[str, str] = {}
# job_id → language: для последующего сохранения vocab additions с правильным lang.
_job_language: dict[str, str | None] = {}
# job_id → user_id: чтобы знать чьи vocab additions сохранять.
_job_user: dict[str, str] = {}
# user_id → job_id: текущая активная транскрипция юзера. При НОВОЙ транскрипции
# мы принудительно гасим предыдущую (см. _terminate_modal_job) — чтобы частые
# рестарты/отмены не плодили зомби-контейнеры в очереди Modal.
_user_active_job: dict[str, str] = {}

# Ленивая ссылка на modal.Dict для прогресса — инициализируется при первом use.
_progress_dict = None


def _get_progress_dict():
    """Возвращает modal.Dict progress_store. Ленивая инициализация."""
    global _progress_dict
    if _progress_dict is None and USE_MODAL:
        try:
            _progress_dict = _modal.Dict.from_name(
                "transcription-progress", create_if_missing=True
            )
        except Exception as e:
            print(f"[progress] dict init failed: {e}", flush=True)
    return _progress_dict


def _create_local_job(kind: str) -> str:
    job_id = uuid.uuid4().hex
    with JOBS_LOCK:
        JOBS[job_id] = {
            "kind": kind,
            "status": "queued",
            "created_at": datetime.utcnow(),
        }
    return job_id


def _update_local_job(job_id: str, **fields):
    with JOBS_LOCK:
        if job_id in JOBS:
            JOBS[job_id].update(fields)


def _get_local_job(job_id: str) -> dict | None:
    with JOBS_LOCK:
        return dict(JOBS[job_id]) if job_id in JOBS else None


def _cleanup_local_jobs():
    """Удаляем local job'ы старше TTL — чтобы dict не разрастался."""
    cutoff = datetime.utcnow() - timedelta(minutes=JOB_TTL_MINUTES)
    with JOBS_LOCK:
        stale = [j for j, v in JOBS.items()
                 if v.get("created_at", datetime.utcnow()) < cutoff]
        for j in stale:
            del JOBS[j]


# Префиксы job_id в Modal-режиме — нужно знать тип на этапе polling'a
# чтобы вернуть правильное поле в ответе (segments / result / answer).
JOB_PREFIX_TRANSCRIBE = "t_"
JOB_PREFIX_GENERATE   = "g_"
JOB_PREFIX_CHAT       = "c_"


def _modal_job_status(job_id: str) -> dict:
    """Опрашиваем статус Modal FunctionCall. Не блокирует."""
    if not USE_MODAL:
        return {"status": "error", "error": "modal not enabled"}

    # Определяем тип по префиксу + получаем настоящий call_id
    if job_id.startswith(JOB_PREFIX_TRANSCRIBE):
        kind = "transcribe"
    elif job_id.startswith(JOB_PREFIX_GENERATE):
        kind = "generate"
    elif job_id.startswith(JOB_PREFIX_CHAT):
        kind = "chat"
    else:
        return {"status": "error", "error": "unknown job kind"}

    call_id = job_id[2:]  # снимаем префикс

    try:
        call = _modal.FunctionCall.from_id(call_id)
        result = call.get(timeout=0)  # 0 = не ждать
    except TimeoutError:
        # Job still running — enrich with real backend progress if available.
        # Прогресс пишется GPU-функциями в modal.Dict (pipeline_steps + stage +
        # chunks_*). Разворачиваем его на верхний уровень ответа, чтобы фронт
        # читал поля напрямую (pr.pipeline_steps / pr.stage / pr.chunks_total).
        resp: dict = {"status": "processing"}
        if kind == "transcribe":
            pk = _job_progress_keys.get(job_id)
            if pk:
                try:
                    pdict = _get_progress_dict()
                    if pdict is not None:
                        prog = pdict.get(pk)
                        if prog and isinstance(prog, dict):
                            # Честный live-elapsed для бегущего шага — считаем на
                            # сервере (часы контейнеров Modal NTP-синхронизированы).
                            steps = prog.get("pipeline_steps")
                            if isinstance(steps, dict):
                                now = time.time()
                                for st in steps.values():
                                    if (isinstance(st, dict)
                                            and st.get("status") == "running"
                                            and st.get("started_ts")):
                                        st["elapsed_sec"] = round(max(0.0, now - st["started_ts"]), 1)
                            resp.update(prog)          # flatten на верхний уровень
                            resp["progress"] = prog    # back-compat (legacy nested)
                except Exception:
                    pass
        return resp
    except _modal.exception.OutputExpiredError:
        return {"status": "error", "error": "result expired"}
    except Exception as e:
        return {"status": "error", "error": str(e)}

    # Возвращаем правильное поле в зависимости от типа задачи
    if kind == "transcribe":
        # Backward compat: result может быть list (старый формат) ИЛИ
        # dict {"segments": [...], "vocab_additions": [...]} (новый).
        if isinstance(result, dict):
            return {
                "status": "done",
                "segments": result.get("segments") or [],
                "vocab_additions": result.get("vocab_additions") or [],
                "channel_mode": result.get("channel_mode"),
            }
        return {"status": "done", "segments": result or []}
    if kind == "generate":
        return {"status": "done", "result": (result or "").strip()}
    if kind == "chat":
        return {"status": "done", "answer": (result or "").strip()}
    return {"status": "done"}

OLLAMA_URL   = os.environ.get("OLLAMA_URL", "http://localhost:11434")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "llama3.2:3b")

# Шаблоны промптов для /api/generate.
# {text} — отформатированный транскрипт, {lang_hint} — явное указание языка
# (LLM плохо догадывается «по умолчанию», даже когда видит русский/украинский).
LANG_HINTS = {
    "ru": "Write the entire response in Russian.",
    "uk": "Write the entire response in Ukrainian.",
    "en": "Write the entire response in English.",
    "pl": "Write the entire response in Polish.",
    "cs": "Write the entire response in Czech.",
}
LANG_HINT_DEFAULT = "Write the entire response in the same language as the transcript."


def _detect_transcript_language(segments_or_text) -> str | None:
    """Эвристика по содержимому: 'uk' / 'ru' / 'pl' / 'cs' / 'en' / None.

    Нужна когда фронт прислал autodetect (пустой language). Без явного
    указания LLM (Qwen2.5) часто скатывается в английский, даже если в
    промпте сказано «отвечай на языке транскрипта». Так что детектим сами
    и подкладываем конкретный LANG_HINT.
    """
    if isinstance(segments_or_text, list):
        text = " ".join((s.get("text") or "") for s in segments_or_text[:40])
    else:
        text = segments_or_text or ""
    text = text[:2000]
    if not text.strip():
        return None

    cyrillic = sum(1 for c in text if 'Ѐ' <= c <= 'ӿ' or 'А' <= c <= 'я')
    # Украинские буквы, которых нет в русском
    uk_specific = sum(1 for c in text if c in 'іїєґІЇЄҐ')
    latin = sum(1 for c in text if 'a' <= c.lower() <= 'z')
    # Польские диакритики, которых нет в английском — отличают pl от en
    pl_specific = sum(1 for c in text if c in 'ąćęłńóśźżĄĆĘŁŃÓŚŹŻ')
    # Чешские гачеки/кроужек — в польском их нет (там ż, а не ž)
    cs_specific = sum(1 for c in text if c in 'ěščřžůťďňĚŠČŘŽŮŤĎŇ')

    if cyrillic == 0 and latin == 0:
        return None
    if cyrillic > latin:
        return 'uk' if uk_specific > 0 else 'ru'
    if cs_specific > pl_specific:
        return 'cs'
    return 'pl' if pl_specific > 0 else 'en'

GENERATE_TEMPLATES = {
    "summary": (
        "You are a senior analyst writing a detailed written report on a meeting "
        "for someone who did not attend but needs to understand what happened "
        "deeply enough to act on it. This is NOT a TL;DR — it is a thorough "
        "analytical document.\n\n"
        "{lang_hint} Preserve speaker names exactly as given in the transcript "
        "(e.g. [Eli], [Speaker 1]). Write in clean markdown.\n\n"
        "{focus_hint}"
        "==== HARD RULES ====\n"
        "1. Use ONLY information that is actually present in the transcript. "
        "Do not invent names, numbers, dates, companies, or facts. If something "
        "is unclear from the transcript, write 'unclear from context' rather "
        "than guessing.\n"
        "2. When you describe a participant's position, attribute it explicitly "
        "(e.g. 'Speaker 2 emphasized that...', 'The client argued...').\n"
        "3. Distinguish between three different things and never mix them:\n"
        "   - DECISIONS: things that were explicitly agreed to happen.\n"
        "   - IDEAS / PROPOSALS: things someone suggested but were not agreed.\n"
        "   - FACTS / POSITIONS: what people said about the current state.\n"
        "4. Prefer concrete detail over generic phrases. Replace empty "
        "formulations like 'the team discussed the issue' with what was "
        "actually discussed and where it landed.\n"
        "5. Quote short verbatim phrases (1-10 words) when they capture an "
        "important position especially well.\n"
        "6. Preserve ALL proper nouns (names of people, companies, products, "
        "places, events) EXACTLY as written in the transcript, including the "
        "original alphabet. NEVER transliterate Cyrillic to Latin and vice "
        "versa. 'ДІМ-9000' must stay 'ДІМ-9000', not 'DIMM-9000' or "
        "'DIM-9000'. 'UrbanStack' must stay 'UrbanStack', not 'УрбанСтек'.\n"
        "7. NEVER assign roles, titles, job positions, or seniority levels to "
        "participants that are not explicitly stated in the transcript. "
        "If a participant's role is unclear, refer to them by name only — "
        "do not call them 'manager', 'lead', 'CEO', 'керівник' etc. unless "
        "the transcript uses that word.\n"
        "8. Preserve specific numbers verbatim — starting/target salaries, "
        "percentages, counts, dates, deadlines. Do not approximate or round. "
        "If the transcript says '500, потім 700', the report must mention "
        "BOTH numbers, not 'a low starting salary'.\n"
        "9. Surface specific companies, events, and places by NAME when they "
        "appear in the transcript (e.g. 'Epify', 'AI Awards', 'Прага', "
        "specific JIRA ticket IDs). These concrete anchors are exactly what "
        "makes the report useful to someone who wasn't there.\n\n"
        "==== ADAPTIVE STRUCTURE ====\n"
        "Choose 4-8 of the following sections — only the ones relevant to THIS "
        "meeting. Do not force sections that don't apply. Do not invent "
        "sections beyond this list. Order them to tell the story of the "
        "meeting clearly.\n"
        "CRITICAL: Translate every section heading into the SAME language as the "
        "transcript (per the language instruction above). Never output a heading "
        "in a different language than the body. The English names below are only "
        "labels for you — render them in the transcript's language.\n\n"
        "- **Context** (always include): 1-3 sentences — what kind "
        "of meeting, who participated, what was the purpose.\n"
        "- **Main topics**: narrative paragraphs "
        "(not just bullets) covering what was actually discussed and what came "
        "out of each topic.\n"
        "- **Positions of the parties**: include when "
        "different participants had distinct views. Give each side its own "
        "sub-section with their reasoning.\n"
        "- **Problems identified**: concrete issues that "
        "surfaced, with enough detail that the reader understands the root "
        "cause, not just the symptom.\n"
        "- **Decisions and agreements**: ONLY things "
        "explicitly agreed in the meeting. If none, omit this section.\n"
        "- **Ideas and proposals**: suggestions that were "
        "raised but not formally agreed. Attribute to whoever proposed them.\n"
        "- **What can be improved**: include only if the "
        "meeting itself surfaced recommendations for improvement (e.g. process "
        "feedback, retrospective points).\n"
        "- **Open questions**: things left unresolved that "
        "need follow-up.\n"
        "- **Next steps and status**: concrete next "
        "actions and overall status (e.g. 'project continues', 'cooperation "
        "ends', 'follow-up meeting scheduled').\n\n"
        "==== DEPTH ====\n"
        "Target length scales with transcript length:\n"
        "- Short meeting (<15 min): 300-600 words.\n"
        "- Medium meeting (15-45 min): 700-1500 words.\n"
        "- Long meeting (>45 min): 1500-3000 words.\n"
        "{detail_hint}"
        "Do not pad. But do not under-report either — a 1-hour meeting should "
        "not collapse into 5 bullet points.\n\n"
        "==== STYLE ====\n"
        "- Use `## Heading` for main sections, `### Sub-heading` for sides of "
        "a position or sub-topics.\n"
        "- Use bullet lists inside sections where appropriate, but lead "
        "complex sections with a 1-2 sentence narrative paragraph before the "
        "bullets.\n"
        "- Bold (`**word**`) for key terms, names, and numbers worth scanning.\n"
        "- No emoji. No 'I' or 'you' — write in third person, analytical voice.\n\n"
        "==== TRANSCRIPT ====\n"
        "{text}"
    ),
    "actions": (
        "You are extracting actionable takeaways from a meeting transcript. "
        "{lang_hint} Preserve speaker names exactly as given. Output is "
        "markdown.\n\n"
        "CRITICAL: Write the section headings (`## Action items`, "
        "`## Recommendations`) in the SAME language as the transcript — translate "
        "them. The English names here are only labels for you.\n\n"
        "{focus_hint}"
        "==== TWO SEPARATE SECTIONS ====\n"
        "The output has up to TWO sections. Do not mix them.\n\n"
        "1) `## Action items` — CONCRETE TASKS someone explicitly committed "
        "to during the meeting.\n"
        "   Markers: 'I will...', 'We agreed to...', 'Let's...', "
        "'Я зроблю...', 'Давайте...', 'Нужно сделать...', 'До п'ятниці я...', "
        "or a task assigned to a specific person ('Sasha will draft the brief').\n"
        "   Format: `- [ ] {{task}} — @{{owner}} — by {{deadline}}`\n"
        "   Rules:\n"
        "   - Imperative phrasing ('Send the updated brief', not 'brief').\n"
        "   - `@{{owner}}` = speaker name. Omit segment entirely if truly "
        "unclear — never guess.\n"
        "   - `by {{deadline}}` only if a specific deadline was stated. "
        "Otherwise omit. Never invent dates.\n"
        "   - If >3 actions for the same owner, group them under a "
        "`### @Owner` sub-heading.\n"
        "   - Order by importance / urgency, not by mention order.\n\n"
        "2) `## Recommendations` — IDEAS, SUGGESTIONS, AND "
        "INSIGHTS surfaced in the meeting that someone should act on, but "
        "were NOT formally committed to as a task. These are the lessons, "
        "process improvements, ideas raised but not assigned, problems "
        "flagged without an owner, etc. This section is essential for "
        "retrospective / feedback / review meetings where the value is in "
        "the insights, not in formal commitments.\n"
        "   Format: each item starts with `- 💡 ` followed by a clear "
        "actionable phrasing. Attribute to the person who raised it when "
        "useful: `- 💡 {{recommendation}} (raised by @{{speaker}})`.\n"
        "   Examples of what belongs here:\n"
        "   - Process improvements proposed but not assigned ('we should "
        "stop sending drafts to the client').\n"
        "   - Ideas / hypotheses worth testing.\n"
        "   - Problems identified without an explicit owner.\n"
        "   - Lessons learned that should change future behavior.\n"
        "   Order by importance. Group thematically when there are many "
        "(use `### Theme` sub-headings).\n\n"
        "==== ADAPTIVE OUTPUT ====\n"
        "- If the meeting produced explicit commitments AND insights → "
        "include both sections.\n"
        "- If only commitments → include only `## Action items`.\n"
        "- If only insights / recommendations (typical for retro / feedback / "
        "review meetings) → include only `## Recommendations`.\n"
        "- If neither — the transcript genuinely has no actionable content "
        "of either kind — reply with a single line in the target language, "
        "e.g. 'Конкретних action items та рекомендацій не зафіксовано.' / "
        "'No actionable takeaways were identified.'\n\n"
        "{detail_hint}"
        "==== HARD RULES ====\n"
        "- Use ONLY content actually present in the transcript. Do not invent "
        "actions, recommendations, owners, or deadlines.\n"
        "- Do not duplicate the same item across both sections.\n"
        "- Things that already happened do not belong in either section.\n"
        "- Preserve all proper nouns (people names, companies, products, "
        "places) EXACTLY as written, including original alphabet. Do not "
        "transliterate (Cyrillic stays Cyrillic, Latin stays Latin).\n"
        "- Preserve specific numbers, dates, and deadlines verbatim. Never "
        "approximate or invent dates.\n"
        "- Never assign roles or job titles to participants beyond what the "
        "transcript explicitly states.\n\n"
        "==== TRANSCRIPT ====\n"
        "{text}"
    ),
}

# Шаблоны которые идут через Gemini 2.5 Pro (для качества аналитики).
# Остальные (если появятся в будущем) — через локальный Qwen.
GEMINI_TEMPLATES = {"summary", "actions"}

# ── Custom Presets ───────────────────────────────────────────────
# Ограничения: по 50 пресетов на юзера/воркспейс, 100 символов имя, 2000 промпт.
PRESET_MAX_PERSONAL = 50
PRESET_MAX_TEAM     = 50
PRESET_NAME_MAX     = 100
PRESET_PROMPT_MAX   = 2000

import re as _re
_CTRL_CHARS = _re.compile(r"[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]")
def _sanitize_preset_prompt(raw: str) -> str:
    """Strip null bytes and ASCII control chars; auto-add <<TRANSCRIPT_TEXT>> if absent."""
    p = _CTRL_CHARS.sub("", raw).strip()[:PRESET_PROMPT_MAX]
    if p and "<<TRANSCRIPT_TEXT>>" not in p:
        p += "\n\n<<TRANSCRIPT_TEXT>>"
    return p[:PRESET_PROMPT_MAX]

# Anti-hallucination рамка для кастомных пресетов.
# Текст транскрипта подставляется через <<TRANSCRIPT_TEXT>> (str.replace, не format —
# фигурные скобки в юзерском промпте не должны ломать format-вызов).
CUSTOM_PRESET_HARD_RULES = (
    "You are an AI assistant processing a meeting transcript.\n\n"
    "HARD RULES — follow without exception:\n"
    "1. Work ONLY from the transcript below. Do NOT invent, assume, or add "
    "information that is not explicitly stated.\n"
    "2. If the transcript does not contain what the user asks for, say so "
    "briefly. Do not fabricate content.\n"
    "3. Keep names, technical terms, abbreviations, and numbers EXACTLY as "
    "they appear in the transcript — never paraphrase or correct them.\n"
    "4. Do not describe or comment on the transcript itself; produce the "
    "requested output directly.\n\n"
    "==== USER INSTRUCTIONS ====\n"
    "{user_prompt}\n\n"
    "==== TRANSCRIPT ====\n"
    "<<TRANSCRIPT_TEXT>>"
)

# ── Privacy Mode: map-reduce промпты ────────────────────────────
# gpt-oss-20b (privacy-путь) не тянет длинный контекст одним вызовом: eager
# attention → O(n²) память → CUDA OOM на 3-4ч транскриптах (ISS-1). Flask
# передаёт в LabGPTOSS20B.generate_mapreduce ГОТОВЫЕ промпты: reduce — обычный
# шаблон из GENERATE_TEMPLATES, map — этот. Оба с PRIVACY_TEXT_SLOT на месте
# текста (подстановка через str.replace в контейнере — фигурные скобки
# шаблонов не требуют экранирования).
PRIVACY_TEXT_SLOT = "<<TRANSCRIPT_TEXT>>"

PRIVACY_MAP_PROMPT = (
    "You are compressing PART of a long meeting transcript into dense "
    "factual notes. Notes from all parts will be combined and turned into a "
    "final report by another step, so preserve everything a report writer "
    "could need.\n\n"
    "{lang_hint}\n\n"
    "KEEP (verbatim where possible):\n"
    "- decisions and agreements\n"
    "- tasks and commitments with owner and deadline\n"
    "- concrete numbers, dates, money amounts\n"
    "- names of people, companies, products, places — EXACTLY as written, "
    "original alphabet, never transliterate\n"
    "- problems raised and their root causes\n"
    "- distinct positions and arguments of speakers (attribute them: "
    "[Name] argued that...)\n"
    "- open questions\n\n"
    "RULES: dense bullet points only; no introduction, no conclusion, no "
    "meta-commentary; do NOT invent or interpret beyond the text; if this "
    "part contains nothing substantive, output the single line 'No "
    "substantive content.' Target 150-300 words.\n\n"
    "==== TRANSCRIPT PART ====\n"
    "<<TRANSCRIPT_TEXT>>"
)

# Детальность вывода (объём саммари / actions). Пресет → инструкция-модификатор,
# подставляется в {detail_hint}. Default medium = пустая строка (базовое поведение).
GENERATE_DETAILS = {"short", "medium", "detailed"}

def _build_generate_extras(detail: str, focus: str) -> dict:
    """Строит {detail_hint, focus_hint} для подстановки в GENERATE_TEMPLATES.

    detail — short/medium/detailed (объём вывода). focus — свободный текст
    "на чём сфокусироваться". Оба опциональны; medium + пустой focus = базовое
    поведение (пустые строки), полная обратная совместимость.
    """
    detail = (detail or "medium").lower()
    if detail not in GENERATE_DETAILS:
        detail = "medium"

    detail_hints = {
        "short": (
            "==== USER LENGTH PREFERENCE: SHORT ====\n"
            "The reader wants this concise. Cover only the most essential points; "
            "prefer tight bullets over long narrative. Do not lose key names, "
            "numbers, or decisions — be concise, not vague.\n\n"
        ),
        "medium": "",
        "detailed": (
            "==== USER LENGTH PREFERENCE: DETAILED ====\n"
            "The reader wants maximum depth. Be thorough and comprehensive — more "
            "detail, more sub-points, more verbatim quotes where they add value. "
            "Do not pad with filler.\n\n"
        ),
    }

    focus_hint = ""
    f = (focus or "").strip()[:300]
    if f:
        focus_hint = (
            "==== USER FOCUS ====\n"
            f'The reader especially cares about: "{f}". Prioritize and expand on '
            "anything related to this; you may compress less-relevant parts. Never "
            "invent — if the transcript does not cover the focus, note that briefly.\n\n"
        )

    return {"detail_hint": detail_hints[detail], "focus_hint": focus_hint}


def _format_segments_for_llm(segments: list[dict], speaker_names: dict[str, str] | None = None) -> str:
    """Сегменты + кастомные имена спикеров → текст с [Name]: метками для LLM."""
    speaker_names = speaker_names or {}
    lines = []
    for seg in segments:
        raw = seg.get("speaker", "SPEAKER_00")
        # Дефолт: "SPEAKER_00" → "Speaker 1"
        name = speaker_names.get(raw)
        if not name:
            m = re.search(r"(\d+)", raw)
            name = f"Speaker {int(m.group(1)) + 1}" if m else raw
        lines.append(f"[{name}]: {seg.get('text', '').strip()}")
    return "\n".join(lines)


def _webm_to_wav(webm_path: str) -> str:
    """Конвертация WebM → WAV (16kHz mono) через ffmpeg CLI.
    Нужно потому что pyannote/torchcodec на Windows не дружит со static-ffmpeg,
    а ему нужны shared DLLs. WAV обходит проблему.
    """
    wav_path = webm_path.rsplit(".", 1)[0] + ".wav"
    subprocess.run(
        ["ffmpeg", "-y", "-i", webm_path, "-ar", "16000", "-ac", "1", wav_path],
        check=True,
        capture_output=True,
    )
    return wav_path

RECORDINGS_DIR = os.path.join(os.path.dirname(__file__), "recordings")
os.makedirs(RECORDINGS_DIR, exist_ok=True)

app = Flask(__name__)
# Разрешаем все origins для dev — в проде заменить на список доменов
CORS(app, resources={r"/api/*": {"origins": "*"}})

ALLOWED_LANGUAGES = {"ru", "uk", "en", "pl", "cs"}
# large-v3-turbo (урезанный декодер) заметно слабее на языках среднего ресурса —
# для них всегда large-v3, независимо от плана.
FORCE_BEST_QUALITY_LANGUAGES = {"cs"}

# Порог (сек) для роутинга в chunked long-pipeline (transcribe_long).
# Записи длиннее этого режутся на чанки и обрабатываются параллельно;
# короче — идут в монолитный transcribe_full. Default 1800 = 30 мин.
LONG_AUDIO_THRESHOLD_S = float(os.environ.get("LONG_AUDIO_THRESHOLD_S", "1800"))


# ── Supabase JWT validation ─────────────────────────────────────
# Проверяем JWT от Supabase Auth на всех /api/* кроме /api/health.
# Токен фронт получает после логина (signInWithOAuth / signInWithOtp)
# и присылает в Authorization: Bearer <jwt>.
#
# Верификация через JWKS endpoint Supabase
#   https://<project>.supabase.co/auth/v1/.well-known/jwks.json
# PyJWKClient кэширует ключи. Работает с HS256 (legacy) и ES256/RS256 (новый
# JWT Signing Keys), без необходимости хранить секрет на нашей стороне.
SUPABASE_URL              = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
STRIPE_SECRET_KEY         = os.environ.get("STRIPE_SECRET_KEY", "")
STRIPE_WEBHOOK_SECRET     = os.environ.get("STRIPE_WEBHOOK_SECRET", "")
STRIPE_PRO_MONTHLY_PRICE  = os.environ.get("STRIPE_PRO_MONTHLY_PRICE", "")
STRIPE_PRO_ANNUAL_PRICE   = os.environ.get("STRIPE_PRO_ANNUAL_PRICE", "")
STRIPE_MAX_MONTHLY_PRICE  = os.environ.get("STRIPE_MAX_MONTHLY_PRICE", "")
STRIPE_MAX_ANNUAL_PRICE   = os.environ.get("STRIPE_MAX_ANNUAL_PRICE", "")
# Team plan: per-seat pricing. Subscription quantity = workspace.seats
STRIPE_TEAM_MONTHLY_PRICE = os.environ.get("STRIPE_TEAM_MONTHLY_PRICE", "")
STRIPE_TEAM_ANNUAL_PRICE  = os.environ.get("STRIPE_TEAM_ANNUAL_PRICE", "")

STRIPE_PRICE_MAP = {
    ("pro",  "monthly"): lambda: STRIPE_PRO_MONTHLY_PRICE,
    ("pro",  "annual"):  lambda: STRIPE_PRO_ANNUAL_PRICE,
    ("max",  "monthly"): lambda: STRIPE_MAX_MONTHLY_PRICE,
    ("max",  "annual"):  lambda: STRIPE_MAX_ANNUAL_PRICE,
    ("team", "monthly"): lambda: STRIPE_TEAM_MONTHLY_PRICE,
    ("team", "annual"):  lambda: STRIPE_TEAM_ANNUAL_PRICE,
}

TEAM_MIN_SEATS = 2  # Minimum seats at upgrade (owner + at least 1 invitee)

# Admin emails — comma-separated. Used to gate /api/lab/* and any future
# internal tools. Anyone whose JWT email matches gets through; everyone else
# 403s. Defaults to empty (no admins) so this is safe to ship unconfigured.
ADMIN_EMAILS = {
    e.strip().lower()
    for e in os.environ.get("ADMIN_EMAILS", "").split(",")
    if e.strip()
}


def _is_admin() -> bool:
    """True if the JWT-authenticated user is in ADMIN_EMAILS."""
    return bool(g.user_email and g.user_email.lower() in ADMIN_EMAILS)


# Plans on which Privacy Mode is offered as a feature. Free/Pro users can
# have the column flipped (no DB-level enforcement) but the UI hides the
# toggle and the backend ignores their flag.
PRIVACY_MODE_ALLOWED_PLANS = {"max", "team"}


def _privacy_mode_active(profile: dict, effective_plan: str) -> bool:
    """True if this user's transcription / generation should bypass Gemini.
    Requires both the flag set AND the user actually being on a plan that
    offers Privacy Mode (defence-in-depth — UI gates too)."""
    if not profile.get("privacy_mode"):
        return False
    return effective_plan in PRIVACY_MODE_ALLOWED_PLANS

# Notion OAuth — Public integration credentials
NOTION_OAUTH_CLIENT_ID     = os.environ.get("NOTION_OAUTH_CLIENT_ID", "")
NOTION_OAUTH_CLIENT_SECRET = os.environ.get("NOTION_OAUTH_CLIENT_SECRET", "")
# Where Notion redirects after user authorizes. Must match what's configured
# in https://www.notion.so/my-integrations exactly.
NOTION_REDIRECT_URI        = os.environ.get(
    "NOTION_REDIRECT_URI",
    "https://razornne--transcriptor-v2-flask-app.modal.run/api/notion/oauth/callback",
)
NOTION_API_VERSION         = "2022-06-28"

PLAN_LIMITS = {
    "free": {"minutes": 60,   "diarization": False, "ai": False, "history": 5},
    "pro":  {"minutes": 600,  "diarization": True,  "ai": True,  "history": None},
    "max":  {"minutes": 2000, "diarization": True,  "ai": True,  "history": None},
    # Team: per-seat plan. Each seat gets the same allowance as Pro, billed
    # to workspace owner (~$14/seat/mo, $11 annual).
    "team": {"minutes": 600,  "diarization": True,  "ai": True,  "history": None},
}

_tracked_jobs: set = set()  # job_ids уже учтённые в minutes_used (in-memory, ок для MVP)


def _sb_admin(path: str, method: str = "GET", data: dict = None, params: dict = None) -> list:
    """Supabase REST с service role key — обходит RLS. Только бэкенд."""
    if not SUPABASE_SERVICE_ROLE_KEY or not SUPABASE_URL:
        return []
    url = f"{SUPABASE_URL}/rest/v1/{path}"
    headers = {
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }
    r = requests.request(method, url, headers=headers, json=data, params=params, timeout=5)
    r.raise_for_status()
    return r.json() if r.content else []


# ── Recording archive (Cloudflare R2) ──────────────────────────────────
# Every transcribed recording/upload (except Privacy Mode) is copied to R2 for
# the founder's error analysis, with a row in public.recordings (migration 012)
# linking audio, raw pipeline output and capture_stats by recording_id.
# Objects expire via an R2 lifecycle rule (RECORDING_RETENTION_DAYS).
R2_BUCKET = os.environ.get("R2_BUCKET", "")
RECORDING_RETENTION_DAYS = 90
_r2_client = None

_ARCHIVE_EXT = {
    "audio/webm": "webm", "video/webm": "webm", "audio/ogg": "ogg", "audio/mpeg": "mp3",
    "audio/mp4": "m4a", "audio/x-m4a": "m4a", "video/mp4": "mp4", "video/quicktime": "mov",
    "audio/wav": "wav", "audio/x-wav": "wav", "audio/flac": "flac", "audio/aac": "aac",
}


def _r2():
    global _r2_client
    if _r2_client is None:
        import boto3
        from botocore.config import Config
        # R2_ENDPOINT only for jurisdiction buckets (EU: https://<acc>.eu.r2.cloudflarestorage.com)
        _r2_client = boto3.client(
            "s3",
            endpoint_url=os.environ.get("R2_ENDPOINT")
            or f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
            aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
            aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
            region_name="auto",
            config=Config(signature_version="s3v4", retries={"max_attempts": 3}),
        )
    return _r2_client


def _archive_recording(audio_bytes: bytes, content_type: str, *, recording_id: str, user_id: str,
                       user_email: str | None, job_id: str, source: str, duration_sec: float,
                       language: str | None, num_speakers: int | None, quality: str):
    """Best-effort, runs in a background thread: audio → R2, metadata → public.recordings."""
    ctype = (content_type or "application/octet-stream").split(";")[0].strip().lower()
    key = f"recordings/{user_id}/{recording_id}.{_ARCHIVE_EXT.get(ctype, 'bin')}"
    try:
        _r2().put_object(Bucket=R2_BUCKET, Key=key, Body=audio_bytes, ContentType=ctype)
        _sb_admin("recordings", method="POST", data={
            "id": recording_id, "user_id": user_id, "user_email": user_email,
            "storage_key": key, "size_bytes": len(audio_bytes), "content_type": ctype,
            "source": source, "duration_sec": duration_sec or None, "language": language,
            "num_speakers": num_speakers, "quality": quality, "job_id": job_id,
            "expires_at": (datetime.utcnow() + timedelta(days=RECORDING_RETENTION_DAYS)).isoformat() + "Z",
        })
        print(f"[archive] {recording_id} → {key} ({len(audio_bytes) / 1048576:.1f} MB)", flush=True)
    except Exception as e:
        print(f"[archive] {recording_id} failed: {e}", flush=True)


def _archive_job_result(job_id: str, fields: dict):
    """Best-effort: attach the raw pipeline result (or error) to the archived recording."""
    try:
        _sb_admin(f"recordings?job_id=eq.{job_id}", method="PATCH",
                  data={**fields, "completed_at": datetime.utcnow().isoformat() + "Z"})
    except Exception as e:
        print(f"[archive] result patch for {job_id} failed: {e}", flush=True)


def _notify_admin(text: str):
    """Best-effort Telegram ping to admin. No-op if not configured.
    Never raises — caller must not depend on this for correctness."""
    token = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
    chat_id = os.environ.get("TELEGRAM_ADMIN_CHAT_ID", "").strip()
    if not token or not chat_id:
        return
    try:
        requests.post(
            f"https://api.telegram.org/bot{token}/sendMessage",
            json={"chat_id": chat_id, "text": text, "parse_mode": "HTML",
                  "disable_web_page_preview": True},
            timeout=4,
        )
    except Exception as e:
        print(f"[admin-notify] failed: {e}", flush=True)


def _stripe_session_discount_summary(session_obj) -> str:
    """If the Stripe Checkout Session used a promotion code, build a short
    Telegram-friendly summary string. Returns empty string if no discount.

    Tries multiple access patterns because the Stripe SDK sometimes exposes
    nested fields as dicts and sometimes as objects depending on version."""
    try:
        total_details = getattr(session_obj, "total_details", None) or \
                        (session_obj.get("total_details") if hasattr(session_obj, "get") else None)
        if not total_details:
            return ""
        discount_amount = 0
        breakdown = None
        if isinstance(total_details, dict):
            discount_amount = (total_details.get("amount_discount") or 0)
            breakdown = total_details.get("breakdown")
        else:
            discount_amount = getattr(total_details, "amount_discount", 0) or 0
            breakdown = getattr(total_details, "breakdown", None)
        if discount_amount <= 0:
            return ""
        currency = "USD"
        try:
            currency = (getattr(session_obj, "currency", None) or
                        (session_obj.get("currency") if hasattr(session_obj, "get") else "usd")).upper()
        except Exception:
            pass
        code = ""
        try:
            discounts = breakdown.get("discounts") if isinstance(breakdown, dict) else getattr(breakdown, "discounts", None)
            if discounts:
                first = discounts[0]
                disc = first.get("discount") if isinstance(first, dict) else getattr(first, "discount", None)
                if disc:
                    promo_code = disc.get("promotion_code") if isinstance(disc, dict) else getattr(disc, "promotion_code", None)
                    coupon = disc.get("coupon") if isinstance(disc, dict) else getattr(disc, "coupon", None)
                    if promo_code:
                        code = str(promo_code)
                    elif coupon:
                        code = (coupon.get("name") if isinstance(coupon, dict) else getattr(coupon, "name", None)) or ""
        except Exception:
            pass
        line = f"🎟 promo: −{discount_amount/100:.2f} {currency}"
        if code:
            line += f" ({code})"
        return line
    except Exception as e:
        print(f"[webhook] discount summary failed: {e}", flush=True)
        return ""


def _generate_referral_code(user_id: str) -> str:
    """Short, URL-safe, human-readable referral code. Collision-resistant enough
    for our scale (deriving from uuid + secrets gives ~10^9 unique codes)."""
    import secrets, hashlib
    # Mix user_id with random salt so codes are stable per attempt but unique per user
    h = hashlib.sha256((user_id + secrets.token_hex(4)).encode()).hexdigest()
    # 8 chars from a friendly alphabet (no 0/O/1/l/I to avoid copy confusion)
    alphabet = "23456789abcdefghjkmnpqrstuvwxyz"
    out = ""
    for i in range(0, 8):
        out += alphabet[int(h[i*2:i*2+2], 16) % len(alphabet)]
    return out


def _ensure_referral_code(user_id: str, profile: dict) -> dict:
    """Lazily generate referral code if missing (also covers profiles created
    before migration 003). Retries on rare UNIQUE collision."""
    if profile.get("referral_code"):
        return profile
    for _ in range(5):
        code = _generate_referral_code(user_id)
        try:
            updated = _sb_admin("user_profiles", method="PATCH",
                                params={"id": f"eq.{user_id}"},
                                data={"referral_code": code})
            if updated:
                return updated[0]
        except Exception as e:
            # Likely UNIQUE constraint violation — try a fresh code
            if "duplicate" not in str(e).lower():
                print(f"[referral] code generation failed: {e}", flush=True)
    return profile  # gave up; non-fatal — UI will just not show invite link


def _maybe_notify_signup(profile: dict):
    """Fire admin signup ping ONCE per user. Profile can be created either by
    our backend or by a Supabase trigger before we see the user — flag check
    decouples notification from creation path."""
    if not profile or profile.get("signup_notified_at"):
        return
    user_id = profile.get("id")
    if not user_id:
        return
    try:
        email = getattr(g, "user_email", None) or "(unknown)"
        ref_code = profile.get("referral_code") or "?"
        _notify_admin(
            f"🎉 <b>New Skriptly signup</b>\n\n"
            f"📧 {email}\n"
            f"🆔 <code>{user_id}</code>\n"
            f"🔗 ref code: <code>{ref_code}</code>"
        )
        # Mark as notified so we never double-ping (even if user logs out / back in)
        _sb_admin("user_profiles", method="PATCH",
                  params={"id": f"eq.{user_id}"},
                  data={"signup_notified_at": datetime.utcnow().isoformat()})
    except Exception as e:
        print(f"[admin-notify] signup ping failed: {e}", flush=True)


def _get_user_profile(user_id: str) -> dict:
    """Читает профиль, сбрасывает счётчик если новый месяц, создаёт если нет."""
    from datetime import timezone
    rows = _sb_admin("user_profiles", params={"id": f"eq.{user_id}", "select": "*"})
    if rows:
        profile = rows[0]
        try:
            reset_at = datetime.fromisoformat(
                profile.get("minutes_reset_at", "").replace("Z", "+00:00")
            )
            now = datetime.now(timezone.utc)
            if now.year != reset_at.year or now.month != reset_at.month:
                new_reset = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0).isoformat()
                _sb_admin("user_profiles", method="PATCH",
                          params={"id": f"eq.{user_id}"},
                          data={"minutes_used": 0, "minutes_reset_at": new_reset})
                profile["minutes_used"] = 0
        except Exception:
            pass
        # Lazy-backfill referral code for legacy profiles
        if not profile.get("referral_code"):
            profile = _ensure_referral_code(user_id, profile)
        # Fire signup ping if we haven't yet (covers trigger-created profiles)
        _maybe_notify_signup(profile)
        return profile
    # Создаём профиль если не существует — сразу с реф-кодом
    code = _generate_referral_code(user_id)
    rows = _sb_admin("user_profiles", method="POST",
                     data={"id": user_id, "referral_code": code})
    if rows:
        _maybe_notify_signup(rows[0])
        return rows[0]
    return {"plan": "free", "minutes_used": 0, "referral_code": code}


def _add_minutes(user_id: str, minutes: float):
    """Добавляет минуты через Postgres RPC (атомарно, без race condition)."""
    _sb_admin("rpc/add_minutes", method="POST",
              data={"user_id": user_id, "mins": max(1, int(minutes + 0.5))})


# ── Personal vocabulary (auto-learned terminology) ───────────────
#
# Стратегия: Gemini correction возвращает список терминов которые он
# исправил (рдух → ADHD, → "Біллі Айліш" и т.п.). Сохраняем их в
# user_profiles.vocabulary (JSONB). На следующей транскрипции топ-N
# терминов идёт в initial_prompt Whisper'а — он распознаёт их с
# первого раза без необходимости коррекции.

VOCAB_MAX_ITEMS = 100  # максимум терминов в персональном словаре
VOCAB_PROMPT_TOP = 30  # сколько подаём в Whisper initial_prompt

def _get_user_vocabulary(user_id: str) -> list[dict]:
    """Возвращает список терминов юзера из user_profiles.vocabulary."""
    if not (SUPABASE_SERVICE_ROLE_KEY and user_id):
        return []
    try:
        rows = _sb_admin("user_profiles",
                         params={"id": f"eq.{user_id}", "select": "vocabulary"})
        if rows and isinstance(rows[0].get("vocabulary"), list):
            return rows[0]["vocabulary"]
    except Exception as e:
        print(f"[vocab] fetch failed: {e}")
    return []


def _save_vocabulary_additions(user_id: str, additions: list, language: str | None):
    """Добавляет/инкрементит термины в персональный словарь юзера.

    additions — список пар {wrong, right} от Gemini correction (терпит и
    голые строки для обратной совместимости со старыми in-flight джобами).
    Элемент словаря: {term(=right), wrong?, freq, lang, last_seen}.

    Логика: для каждого нового term — если есть в словаре, +1 к freq и
    обновляем last_seen (+ свежую wrong-форму). Если нет — freq=1. Держим
    топ-100 по freq (старые редкие выкидываем).
    """
    if not (SUPABASE_SERVICE_ROLE_KEY and user_id and additions):
        return
    try:
        existing = _get_user_vocabulary(user_id)
        by_key: dict[str, dict] = {item.get("term", "").lower(): item for item in existing if item.get("term")}

        now_iso = datetime.now().isoformat()
        for add in additions:
            # tolerate dict {wrong, right} ИЛИ голую строку (старый формат)
            if isinstance(add, dict):
                term  = (add.get("right") or "").strip()
                wrong = (add.get("wrong") or "").strip()
            else:
                term, wrong = str(add).strip(), ""
            if len(term) < 2:
                continue
            key = term.lower()
            if key in by_key:
                item = by_key[key]
                item["freq"] = int(item.get("freq", 1)) + 1
                item["last_seen"] = now_iso
                # Обновляем casing если новый вариант больше похож на правильный
                if term.isupper() or term[0].isupper():
                    item["term"] = term
                if wrong:
                    item["wrong"] = wrong  # свежая ошибочная форма
            else:
                new_item = {
                    "term": term,
                    "freq": 1,
                    "lang": language or "auto",
                    "last_seen": now_iso,
                }
                if wrong:
                    new_item["wrong"] = wrong
                by_key[key] = new_item

        # Сортируем по freq desc, обрезаем до VOCAB_MAX_ITEMS
        all_items = sorted(by_key.values(), key=lambda x: (-int(x.get("freq", 1)), x.get("last_seen", "")))[:VOCAB_MAX_ITEMS]

        _sb_admin("user_profiles", method="PATCH",
                  params={"id": f"eq.{user_id}"},
                  data={"vocabulary": all_items})
        print(f"[vocab] saved {len(additions)} new terms for user {user_id[:8]}…, total {len(all_items)}")
    except Exception as e:
        print(f"[vocab] save failed: {e}")


def _build_vocab_prompt(vocab: list[dict]) -> str:
    """Берёт топ-30 терминов по freq и форматирует как initial_prompt."""
    if not vocab:
        return ""
    top = sorted(vocab, key=lambda x: -int(x.get("freq", 1)))[:VOCAB_PROMPT_TOP]
    terms = [item.get("term") for item in top if item.get("term")]
    if not terms:
        return ""
    # Whisper prompt format — просто перечисление через запятую работает
    return "Recurring terms in this user's recordings: " + ", ".join(terms) + "."


VOCAB_HINTS_TOP = 20  # сколько пар wrong→right подаём в Gemini correction

def _build_correction_hints(vocab: list[dict]) -> str:
    """Строит блок known corrections для Gemini из пар wrong→right.

    Формат: 'пожика → по ЖК; депутатська → дебіторська'. Берём только
    элементы где есть поле wrong, топ по freq. Передаётся в Modal как
    correction_hints → Gemini контекстно применяет известные исправления.
    """
    if not vocab:
        return ""
    paired = [v for v in vocab if v.get("wrong") and v.get("term")]
    if not paired:
        return ""
    top = sorted(paired, key=lambda x: -int(x.get("freq", 1)))[:VOCAB_HINTS_TOP]
    return "; ".join(f"{v['wrong']} → {v['term']}" for v in top)

_jwks_client = None
def _get_jwks_client():
    """Ленивая инициализация — клиент кэширует ключи между запросами."""
    global _jwks_client
    if _jwks_client is None and SUPABASE_URL:
        _jwks_client = pyjwt.PyJWKClient(
            f"{SUPABASE_URL}/auth/v1/.well-known/jwks.json",
            cache_keys=True,
        )
    return _jwks_client

# Эндпоинты которые работают без auth (служебные, открытые)
_PUBLIC_API_PATHS = {"/api/health", "/api/stripe/webhook", "/api/notion/oauth/callback"}


@app.before_request
def _require_jwt():
    """Гард: все /api/* кроме PUBLIC требуют валидный Supabase JWT."""
    # CORS preflight всегда пропускаем
    if request.method == "OPTIONS":
        return None

    path = request.path
    if not path.startswith("/api/") or path in _PUBLIC_API_PATHS:
        return None

    # Если SUPABASE_URL не задан — auth не настроен. В локальной разработке
    # это сознательный режим (пропускаем). В Modal-режиме это значит, что
    # секрет сломан (например, --force без SUPABASE_URL) — МОЛЧА отключать
    # auth нельзя, иначе все /api/* становятся публичными. Отдаём 503.
    jwks_client = _get_jwks_client()
    if jwks_client is None:
        if USE_MODAL:
            print("[auth] FATAL: SUPABASE_URL missing in Modal mode — refusing requests", flush=True)
            return jsonify({"error": "auth is not configured on the server"}), 503
        return None

    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        return jsonify({"error": "missing token"}), 401

    token = auth_header[7:].strip()
    try:
        signing_key = jwks_client.get_signing_key_from_jwt(token)
        payload = pyjwt.decode(
            token,
            signing_key.key,
            algorithms=["HS256", "ES256", "RS256"],
            audience="authenticated",
        )
    except pyjwt.ExpiredSignatureError:
        return jsonify({"error": "token expired"}), 401
    except pyjwt.InvalidTokenError as e:
        return jsonify({"error": f"invalid token: {e}"}), 401
    except Exception as e:
        return jsonify({"error": f"jwt verification failed: {e}"}), 401

    # Прокидываем user_id в request context на случай если эндпоинт хочет использовать
    g.user_id = payload.get("sub")
    g.user_email = payload.get("email")
    return None


@app.route("/")
def index():
    """Cutover (2026-06-14): фронт переехал на Next.js /app.
    301 → skriptly.io/app. Старый templates/index.html в legacy/.
    """
    return redirect("https://skriptly.io/app", code=301)


@app.route("/api/health")
def health():
    """Проверка что бэк жив и модели подгружаются."""
    return jsonify({"status": "ok"})


@app.route("/api/jobs/<job_id>", methods=["GET"])
def job_status_endpoint(job_id):
    """Опрос статуса фоновой задачи. Клиент опрашивает раз в 2 секунды.

    Modal-режим: job_id с префиксом t_/g_/c_ → проверяем Modal FunctionCall.
    Local-режим: job_id это uuid hex → читаем из локального JOBS dict.
    """
    # Modal: префикс кодирует тип
    if USE_MODAL and len(job_id) > 2 and job_id[1] == "_":
        result = _modal_job_status(job_id)
        if R2_BUCKET and job_id.startswith(JOB_PREFIX_TRANSCRIBE) and job_id not in _tracked_jobs:
            if result.get("status") == "done":
                threading.Thread(target=_archive_job_result, daemon=True, args=(job_id, {
                    "segments": result.get("segments") or [],
                    "vocab_additions": result.get("vocab_additions") or [],
                })).start()
            elif result.get("status") == "error":
                threading.Thread(target=_archive_job_result, daemon=True,
                                 args=(job_id, {"error": str(result.get("error"))[:2000]})).start()
        # Трекаем минуты ровно один раз когда транскрипция завершилась
        if (result.get("status") == "done"
                and job_id.startswith(JOB_PREFIX_TRANSCRIBE)
                and job_id not in _tracked_jobs
                and SUPABASE_SERVICE_ROLE_KEY
                and g.user_id):
            segments = result.get("segments") or []
            if segments:
                duration_mins = max(s.get("end", 0) for s in segments) / 60
                try:
                    _add_minutes(g.user_id, duration_mins)
                    _tracked_jobs.add(job_id)
                except Exception as e:
                    print(f"[usage] tracking failed: {e}")
            # Сохраняем persona vocabulary additions из Gemini correction
            vocab_additions = result.get("vocab_additions") or []
            if vocab_additions:
                lang = _job_language.get(job_id)
                try:
                    _save_vocabulary_additions(g.user_id, vocab_additions, lang)
                except Exception as e:
                    print(f"[vocab] save failed: {e}")
            # Cleanup tracking dicts
            _job_language.pop(job_id, None)
            _job_user.pop(job_id, None)
            _job_progress_keys.pop(job_id, None)
            # Снять отметку активной джобы юзера (zombie-guard)
            if g.user_id and _user_active_job.get(g.user_id) == job_id:
                _user_active_job.pop(g.user_id, None)
        return jsonify(result)

    # Local: обычный uuid hex
    _cleanup_local_jobs()
    job = _get_local_job(job_id)
    if not job:
        return jsonify({"error": "job not found or expired"}), 404
    return jsonify({k: v for k, v in job.items() if not isinstance(v, datetime)})


def _terminate_modal_job(job_id: str | None) -> bool:
    """Принудительно гасит запущенный Modal FunctionCall + чистит трекинг-словари.

    Best-effort и идемпотентно: на уже завершённой/отменённой джобе Modal cancel —
    no-op. Возвращает True если это Modal-джоба (была попытка терминирования).
    Используется и из cancel-эндпоинта, и при старте новой транскрипции (чтобы
    предыдущая активная джоба того же юзера не висела зомби-контейнером).
    """
    if not (USE_MODAL and job_id and len(job_id) > 2 and job_id[1] == "_"):
        return False
    call_id = job_id[2:]
    try:
        _modal.FunctionCall.from_id(call_id).cancel()
    except Exception as e:
        # Джоба могла уже завершиться — это нормально.
        print(f"[cancel] modal terminate non-fatal for {job_id}: {e}", flush=True)
    _job_language.pop(job_id, None)
    _job_user.pop(job_id, None)
    _job_progress_keys.pop(job_id, None)
    # Снять отметку активной джобы (ключ — user_id, значение — job_id).
    for uid, jid in list(_user_active_job.items()):
        if jid == job_id:
            _user_active_job.pop(uid, None)
    return True


@app.route("/api/jobs/<job_id>/cancel", methods=["POST"])
def job_cancel_endpoint(job_id):
    """Cancel an in-flight Modal job. Used by frontend's Cancel button
    on the processing screen.

    For Modal jobs: FunctionCall.cancel() terminates the running container.
    For local mode: best-effort, sets a cancel flag in the job dict.

    Idempotent: cancelling an already-finished or already-cancelled job
    returns 200 OK with status: 'noop'.
    """
    if not job_id:
        return jsonify({"error": "job_id required"}), 400

    # Modal: prefix-encoded call_id — гасим контейнер + чистим трекинг.
    if USE_MODAL and len(job_id) > 2 and job_id[1] == "_":
        try:
            _terminate_modal_job(job_id)
            return jsonify({"ok": True, "status": "cancelled"})
        except Exception as e:
            return jsonify({"error": f"cancel failed: {e}"}), 500

    # Local mode — set cancel flag, the polling endpoint will return
    job = _get_local_job(job_id)
    if not job:
        return jsonify({"ok": True, "status": "noop"})
    job["status"] = "cancelled"
    job["error"] = "cancelled by user"
    return jsonify({"ok": True, "status": "cancelled"})


def _ollama_generate(prompt: str, *, max_tokens: int = 60, temperature: float = 0.4, timeout: int = 60) -> str:
    """LLM inference: Modal (USE_MODAL=true) или локальная Ollama."""
    if USE_MODAL:
        return _transcriptor.run_llm.remote(prompt, max_tokens=max_tokens, temperature=temperature)

    r = requests.post(
        f"{OLLAMA_URL}/api/generate",
        json={
            "model": OLLAMA_MODEL,
            "prompt": prompt,
            "stream": False,
            "options": {"temperature": temperature, "num_predict": max_tokens},
        },
        timeout=timeout,
    )
    r.raise_for_status()
    return (r.json().get("response") or "").strip()


_CORRECTION_INSTRUCTIONS: dict[str, str] = {
    "ru": (
        "Исправь ТОЛЬКО очевидные фонетические ошибки распознавания речи (STT). "
        "НЕ меняй смысл, стиль, порядок слов, пунктуацию, регистр. "
        "НЕ добавляй и НЕ удаляй слова. Язык оставляй русским. "
        "Если не уверен — оставь как есть."
    ),
    "uk": (
        "Виправ ЛИШЕ очевидні фонетичні помилки розпізнавання мовлення (STT). "
        "НЕ змінюй зміст, стиль, порядок слів, пунктуацію, регістр. "
        "НЕ додавай і НЕ видаляй слова. Мова залишається українською. "
        "Якщо не впевнений — залиш як є."
    ),
    "en": (
        "Fix ONLY obvious phonetic speech-to-text (STT) errors. "
        "Do NOT change meaning, style, word order, punctuation, or capitalization. "
        "Do NOT add or remove words. If unsure, leave as is."
    ),
}


def _llm_correct_segments(segments: list[dict], language: str | None) -> list[dict]:
    """Постобработка: LLM исправляет фонетические STT-ошибки, ничего больше.

    Обрабатывает батчами по 40 сегментов. Если LLM недоступна или батч
    не парсится — тихо возвращает оригинал для этого батча.
    """
    if not segments:
        return segments

    instruction = _CORRECTION_INSTRUCTIONS.get(language or "", _CORRECTION_INSTRUCTIONS["en"])
    batch_size = 40
    corrected = [dict(s) for s in segments]

    for batch_start in range(0, len(segments), batch_size):
        batch = segments[batch_start:batch_start + batch_size]
        lines_in = "\n".join(f"{i + 1}. {seg['text']}" for i, seg in enumerate(batch))

        prompt = (
            f"{instruction}\n\n"
            "Return ONLY the same numbered lines with corrections applied. "
            "Keep numbering and format identical.\n\n"
            f"{lines_in}"
        )

        try:
            # max_tokens: ~2x input length in chars converted to rough token estimate
            max_tok = max(256, len(lines_in) // 2)
            raw = _ollama_generate(prompt, max_tokens=max_tok, temperature=0.0, timeout=120)

            parsed: dict[int, str] = {}
            for line in raw.splitlines():
                m = re.match(r'^(\d+)\.\s+(.+)$', line.strip())
                if m:
                    idx = int(m.group(1)) - 1
                    if 0 <= idx < len(batch):
                        parsed[idx] = m.group(2).strip()

            for idx, text in parsed.items():
                orig = batch[idx]["text"]
                # Отклоняем по двум признакам галлюцинации:
                # 1. Текст сильно изменился по длине (>40%)
                if len(text) == 0 or abs(len(text) - len(orig)) / max(len(orig), 1) > 0.4:
                    continue
                # 2. Кириллический оригинал получил латиницу которой не было —
                #    признак что модель вставила иностранное слово
                orig_latin = sum(1 for c in orig if c.isascii() and c.isalpha())
                new_latin  = sum(1 for c in text if c.isascii() and c.isalpha())
                orig_cyrillic = sum(1 for c in orig if 'Ѐ' <= c <= 'ӿ')
                if orig_cyrillic > len(orig) * 0.5 and new_latin > orig_latin + 1:
                    continue
                corrected[batch_start + idx]["text"] = text

        except Exception as e:
            print(f"[llm-correct] batch {batch_start // batch_size} failed: {e}", flush=True)

    return corrected


@app.route("/api/profile", methods=["GET"])
def profile_endpoint():
    """Возвращает план и использованные минуты для текущего пользователя."""
    if not g.user_id or not SUPABASE_SERVICE_ROLE_KEY:
        return jsonify({"plan": "free", "minutes_used": 0, "minutes_limit": 60,
                        "bonus_minutes": 0, "referral_code": None})
    try:
        profile = _get_user_profile(g.user_id)
        # Effective plan considers Team workspace membership
        plan = _get_effective_plan(g.user_id, g.user_email, profile)
        limits = PLAN_LIMITS.get(plan, PLAN_LIMITS["free"])
        bonus = int(profile.get("bonus_minutes") or 0)
        # Count successful referrals (people who used this user's code)
        ref_count = 0
        try:
            refs = _sb_admin("user_profiles",
                             params={"referred_by": f"eq.{g.user_id}", "select": "id"})
            ref_count = len(refs or [])
        except Exception:
            pass
        return jsonify({
            "plan": plan,
            "minutes_used": profile.get("minutes_used", 0),
            "minutes_limit": limits["minutes"] + bonus,  # effective limit
            "minutes_limit_base": limits["minutes"],
            "bonus_minutes": bonus,
            "referral_code": profile.get("referral_code"),
            "referral_count": ref_count,
            "was_referred": bool(profile.get("referred_by")),
            "notion_connected":      bool(profile.get("notion_access_token")),
            "notion_workspace_name": profile.get("notion_workspace_name"),
            "privacy_mode":          bool(profile.get("privacy_mode")),
            "privacy_mode_available": plan in PRIVACY_MODE_ALLOWED_PLANS,
            "is_admin":              _is_admin(),
            "vocabulary":            profile.get("vocabulary") or [],  # для Insights дашборда
            "presets":               profile.get("presets") or [],
            "team_presets":          _get_workspace_presets(g.user_id),
        })
    except Exception as e:
        print(f"[profile] error: {e}")
        return jsonify({"plan": "free", "minutes_used": 0, "minutes_limit": 60,
                        "bonus_minutes": 0, "referral_code": None})


# ── Personal vocabulary management (ручное редактирование) ───────
@app.route("/api/vocabulary", methods=["POST"])
def update_vocabulary_endpoint():
    """Заменяет персональный словарь юзера присланным списком.

    Ручное управление из Insights дашборда: rename / delete / add терминов
    (когда auto-learned термин определился неверно). Принимает весь массив,
    валидирует/санитизирует, кладёт в user_profiles.vocabulary через service role.
    Возвращает канонический (очищенный) список для синка фронта.
    """
    if not g.user_id:
        return jsonify({"error": "auth required"}), 401
    if not SUPABASE_SERVICE_ROLE_KEY:
        return jsonify({"error": "service unavailable"}), 503

    data = request.get_json(silent=True) or {}
    items = data.get("vocabulary")
    if not isinstance(items, list):
        return jsonify({"error": "vocabulary must be a list"}), 400

    now_iso = datetime.now().isoformat()
    cleaned: list[dict] = []
    seen: set[str] = set()
    for it in items:
        if not isinstance(it, dict):
            continue
        term = (it.get("term") or "").strip()
        if not term or len(term) > 80:
            continue
        key = term.lower()
        if key in seen:
            continue
        seen.add(key)
        entry = {
            "term": term,
            "freq": max(1, min(9999, int(it.get("freq") or 1))),
            "lang": (it.get("lang") or "manual"),
            "last_seen": it.get("last_seen") or now_iso,
        }
        wrong = (it.get("wrong") or "").strip()
        if wrong:
            entry["wrong"] = wrong[:80]
        cleaned.append(entry)

    cleaned = sorted(cleaned, key=lambda x: (-int(x.get("freq", 1)), x.get("last_seen", "")))[:VOCAB_MAX_ITEMS]
    try:
        _sb_admin("user_profiles", method="PATCH",
                  params={"id": f"eq.{g.user_id}"},
                  data={"vocabulary": cleaned})
    except Exception as e:
        print(f"[vocab] manual update failed: {e}")
        return jsonify({"error": f"save failed: {e}"}), 500
    return jsonify({"ok": True, "vocabulary": cleaned})


# ── Personal Presets management ────────────────────────────────
@app.route("/api/presets", methods=["POST"])
def update_presets_endpoint():
    """Replace the calling user's personal presets array.

    Body: {presets: [{id, name, prompt, scope}, ...]}
    Returns: {ok: true, presets: [...canonical...]}
    """
    if not g.user_id:
        return jsonify({"error": "auth required"}), 401
    if not SUPABASE_SERVICE_ROLE_KEY:
        return jsonify({"error": "service unavailable"}), 503

    data = request.get_json(silent=True) or {}
    items = data.get("presets")
    if not isinstance(items, list):
        return jsonify({"error": "presets must be a list"}), 400

    cleaned: list[dict] = []
    seen_ids: set[str] = set()
    for it in items:
        if not isinstance(it, dict):
            continue
        pid = (it.get("id") or "").strip()
        name = (it.get("name") or "").strip()[:PRESET_NAME_MAX]
        prompt = _sanitize_preset_prompt(it.get("prompt") or "")
        if not pid or not name or not prompt:
            continue
        if pid in seen_ids:
            continue
        seen_ids.add(pid)
        cleaned.append({
            "id":    pid,
            "name":  name,
            "prompt": prompt,
            "scope": "personal",
        })
        if len(cleaned) >= PRESET_MAX_PERSONAL:
            break

    try:
        _sb_admin("user_profiles", method="PATCH",
                  params={"id": f"eq.{g.user_id}"},
                  data={"presets": cleaned})
    except Exception as e:
        return jsonify({"error": f"save failed: {e}"}), 500
    return jsonify({"ok": True, "presets": cleaned})


# ── Team Presets management (owner only) ──────────────────────
@app.route("/api/workspace/presets", methods=["POST"])
def update_workspace_presets_endpoint():
    """Replace the workspace's team presets array. Owner only.

    Body: {presets: [{id, name, prompt, scope}, ...]}
    Returns: {ok: true, presets: [...canonical...]}
    """
    if not g.user_id:
        return jsonify({"error": "auth required"}), 401
    if not SUPABASE_SERVICE_ROLE_KEY:
        return jsonify({"error": "service unavailable"}), 503

    ws_rows = _sb_admin("workspaces", params={
        "owner_id": f"eq.{g.user_id}", "select": "id", "limit": "1",
    })
    if not ws_rows:
        return jsonify({"error": "You must be a workspace owner to manage team presets."}), 403

    ws_id = ws_rows[0]["id"]
    data = request.get_json(silent=True) or {}
    items = data.get("presets")
    if not isinstance(items, list):
        return jsonify({"error": "presets must be a list"}), 400

    cleaned: list[dict] = []
    seen_ids: set[str] = set()
    for it in items:
        if not isinstance(it, dict):
            continue
        pid = (it.get("id") or "").strip()
        name = (it.get("name") or "").strip()[:PRESET_NAME_MAX]
        prompt = _sanitize_preset_prompt(it.get("prompt") or "")
        if not pid or not name or not prompt:
            continue
        if pid in seen_ids:
            continue
        seen_ids.add(pid)
        cleaned.append({
            "id":         pid,
            "name":       name,
            "prompt":     prompt,
            "scope":      "team",
            "created_by": g.user_id,
        })
        if len(cleaned) >= PRESET_MAX_TEAM:
            break

    try:
        _sb_admin("workspaces", method="PATCH",
                  params={"id": f"eq.{ws_id}"},
                  data={"presets": cleaned})
    except Exception as e:
        return jsonify({"error": f"save failed: {e}"}), 500
    return jsonify({"ok": True, "presets": cleaned})


# ── Privacy Mode toggle ────────────────────────────────────────
@app.route("/api/profile/privacy-mode", methods=["POST"])
def set_privacy_mode():
    """Toggle Privacy Mode for the calling user. Gated to Max + Team plans.
    Body: {enabled: bool}"""
    if not g.user_id:
        return jsonify({"error": "auth required"}), 401
    if not SUPABASE_SERVICE_ROLE_KEY:
        return jsonify({"error": "service unavailable"}), 503

    data = request.get_json(silent=True) or {}
    enabled = bool(data.get("enabled"))

    profile = _get_user_profile(g.user_id)
    eff_plan = _get_effective_plan(g.user_id, g.user_email, profile)
    if enabled and eff_plan not in PRIVACY_MODE_ALLOWED_PLANS:
        return jsonify({
            "error": "Privacy Mode requires Max or Team plan.",
            "upgrade_required": True,
        }), 402

    try:
        _sb_admin("user_profiles", method="PATCH",
                  params={"id": f"eq.{g.user_id}"},
                  data={"privacy_mode": enabled})
        print(f"[privacy] {g.user_id} → privacy_mode={enabled}", flush=True)
    except Exception as e:
        return jsonify({"error": f"save failed: {e}"}), 500

    return jsonify({"ok": True, "privacy_mode": enabled})


# ── Referral redeem ────────────────────────────────────────────
REFERRAL_BONUS_MINUTES = 60  # awarded to BOTH inviter and invitee


@app.route("/api/referral/redeem", methods=["POST"])
def referral_redeem():
    """Apply a referral code to the current user (one-time only).

    Front-end calls this once after signup if a ?ref=CODE was captured at
    landing-time. Awards REFERRAL_BONUS_MINUTES to both sides.
    Body: {code: "abc12345"}.
    Idempotent: silently no-ops if user already has referred_by set.
    """
    if not g.user_id:
        return jsonify({"error": "auth required"}), 401
    if not SUPABASE_SERVICE_ROLE_KEY:
        return jsonify({"error": "service unavailable"}), 503

    data = request.get_json(silent=True) or {}
    code = (data.get("code") or "").strip().lower()
    if not code or len(code) < 4 or len(code) > 32:
        return jsonify({"error": "invalid code"}), 400

    # 1. Current user — must not already be referred (one-time bonus)
    profile = _get_user_profile(g.user_id)
    if profile.get("referred_by"):
        return jsonify({"ok": True, "already_redeemed": True})

    # 2. Find inviter by code
    try:
        rows = _sb_admin("user_profiles",
                         params={"referral_code": f"eq.{code}", "select": "id,bonus_minutes"})
    except Exception as e:
        print(f"[referral] lookup failed: {e}")
        return jsonify({"error": "lookup failed"}), 500
    if not rows:
        return jsonify({"error": "code not found"}), 404
    inviter_id = rows[0]["id"]
    if inviter_id == g.user_id:
        return jsonify({"error": "cannot use own code"}), 400

    # 3. Atomically award bonus to both
    bonus = REFERRAL_BONUS_MINUTES
    try:
        # Invitee — set referred_by + bonus
        _sb_admin("user_profiles", method="PATCH",
                  params={"id": f"eq.{g.user_id}"},
                  data={"referred_by": inviter_id,
                        "bonus_minutes": int(profile.get("bonus_minutes") or 0) + bonus})
        # Inviter — bump bonus
        inviter_bonus = int(rows[0].get("bonus_minutes") or 0) + bonus
        _sb_admin("user_profiles", method="PATCH",
                  params={"id": f"eq.{inviter_id}"},
                  data={"bonus_minutes": inviter_bonus})
        print(f"[referral] redeem ok: invitee={g.user_id} inviter={inviter_id} +{bonus} each", flush=True)
    except Exception as e:
        print(f"[referral] redeem failed: {e}")
        return jsonify({"error": "redeem failed"}), 500

    return jsonify({"ok": True, "bonus": bonus})


@app.route("/api/stripe/checkout", methods=["POST"])
def stripe_checkout():
    """Создаёт Stripe Checkout Session и возвращает URL для редиректа.

    Поддерживает три плана:
      • pro / max  — личная подписка (quantity=1).
      • team       — командный апселл из пустого экрана Workspace. Юзер ещё НЕ
                     имеет воркспейса: вводит имя, мы кладём его в metadata как
                     `pending_workspace_name`. Вебхук на checkout.session.completed
                     (type=personal_team_create) создаёт воркспейс с этим именем
                     сразу после оплаты. quantity = TEAM_MIN_SEATS.
    """
    import stripe as _stripe
    _stripe.api_key = STRIPE_SECRET_KEY
    if not STRIPE_SECRET_KEY:
        return jsonify({"error": "Stripe not configured"}), 503
    if not g.user_id:
        return jsonify({"error": "auth required"}), 401

    data    = request.get_json(silent=True) or {}
    plan    = (data.get("plan") or "pro").lower()
    billing = (data.get("billing") or "monthly").lower()
    if plan not in ("pro", "max", "team"):
        plan = "pro"
    if billing not in ("monthly", "annual"):
        billing = "monthly"

    price_id = data.get("price_id") or (STRIPE_PRICE_MAP.get((plan, billing), lambda: "")())
    if not price_id:
        return jsonify({"error": f"price_id for {plan}/{billing} not configured in secrets"}), 400

    origin = request.headers.get("Origin", "https://skriptly.io")
    base = origin + "/app"

    # ── Team upsell: pay first, auto-create the workspace via webhook ──────────
    if plan == "team":
        # Guard: user must not already belong to a workspace.
        existing_ws = _get_user_workspace(g.user_id, g.user_email)
        if existing_ws:
            return jsonify({"error": "You already belong to a workspace."}), 409

        pending_name = (data.get("pending_workspace_name") or "").strip()[:64]
        if not pending_name:
            return jsonify({"error": "Workspace name is required."}), 400

        meta = {
            "type": "personal_team_create",
            "user_id": g.user_id or "",
            "pending_workspace_name": pending_name,
            "billing": billing,
        }
        try:
            session = _stripe.checkout.Session.create(
                mode="subscription",
                payment_method_types=["card"],
                line_items=[{"price": price_id, "quantity": TEAM_MIN_SEATS}],
                success_url=base + "?checkout=success&team=1",
                cancel_url=base + "?checkout=cancelled",
                client_reference_id=g.user_id,
                customer_email=g.user_email or "",
                metadata=meta,
                # Mirror onto the subscription so we can re-tag it post-creation.
                subscription_data={"metadata": meta},
                allow_promotion_codes=True,
            )
            return jsonify({"url": session.url})
        except Exception as e:
            print(f"[stripe] team checkout create failed: {e}", flush=True)
            return jsonify({"error": str(e)}), 500

    # ── Personal Pro / Max subscription ────────────────────────────────────────
    try:
        session = _stripe.checkout.Session.create(
            mode="subscription",
            payment_method_types=["card"],
            line_items=[{"price": price_id, "quantity": 1}],
            success_url=base + "?checkout=success",
            cancel_url=base + "?checkout=cancelled",
            client_reference_id=g.user_id,
            customer_email=g.user_email or "",
            metadata={"plan": plan, "user_id": g.user_id or "", "billing": billing},
            allow_promotion_codes=True,   # enables "Add promotion code" on Stripe Checkout
        )
        return jsonify({"url": session.url})
    except Exception as e:
        print(f"[stripe] checkout create failed: {e}", flush=True)
        return jsonify({"error": str(e)}), 500


@app.route("/api/stripe/portal", methods=["POST"])
def stripe_portal():
    """Stripe Customer Portal — управление подпиской (отмена, смена плана, карточка).

    Требует stripe_customer_id в user_profiles — сохраняется вебхуком на checkout.session.completed.

    Никогда не должен падать с голым 500 на ожидаемых состояниях:
      • нет customer_id (юзер ещё не платил)  → 400 {"error": "Stripe customer ID missing"}.
      • Stripe API / lookup упал              → лог + чистый JSON с понятным сообщением.

    Returns: {"url": "https://billing.stripe.com/..."} — редиректим туда фронт.
    """
    import stripe as _stripe
    _stripe.api_key = STRIPE_SECRET_KEY
    if not STRIPE_SECRET_KEY:
        return jsonify({"error": "Stripe not configured"}), 503

    if not g.user_id:
        return jsonify({"error": "auth required"}), 401

    # ── 1. Вычитываем stripe_customer_id из user_profiles ──────────────────────
    try:
        rows = _sb_admin("user_profiles",
                         params={"id": f"eq.{g.user_id}", "select": "stripe_customer_id"})
    except Exception as e:
        print(f"[stripe-portal] profile lookup failed for user={g.user_id}: {e}", flush=True)
        return jsonify({"error": "Could not load your billing profile. Please try again."}), 502

    customer_id = (rows[0].get("stripe_customer_id") or "") if rows else ""

    # Missing / None customer id is an EXPECTED state (never subscribed) — clean 400,
    # not a 500. Frontend surfaces this as a toast instead of hanging in a loader.
    if not customer_id:
        print(f"[stripe-portal] no stripe_customer_id for user={g.user_id}", flush=True)
        return jsonify({
            "error": "Stripe customer ID missing",
            "no_subscription": True,
        }), 400

    # ── 2. Создаём сессию Customer Portal ──────────────────────────────────────
    origin = request.headers.get("Origin", "https://skriptly.io")
    return_url = origin + "/app?portal=return"
    try:
        session = _stripe.billing_portal.Session.create(
            customer=customer_id,
            return_url=return_url,
        )
        return jsonify({"url": session.url})
    except Exception as e:
        msg = str(e)
        # ── Stale / mismatched customer (защита от утечки тестовых cus_) ──────
        # Типовой кейс: в базе лежит тестовый customer (cus_…), а ключ — Live
        # (или наоборот). Stripe бросает InvalidRequestError "No such customer".
        # Стираем мусорный stripe_customer_id, чтобы следующий checkout создал
        # свежего валидного клиента, и говорим фронту уйти на обычный checkout.
        if "No such customer" in msg:
            try:
                _sb_admin("user_profiles", method="PATCH",
                          params={"id": f"eq.{g.user_id}"},
                          data={"stripe_customer_id": None})
                print(f"[stripe-portal] cleared invalid customer={customer_id} "
                      f"for user={g.user_id}", flush=True)
            except Exception as e2:
                print(f"[stripe-portal] failed clearing bad customer={customer_id}: {e2}", flush=True)
            return jsonify({
                "error": "invalid_customer",
                "message": "Stripe ID mismatched. Please clear checkout again.",
            }), 400
        # Иначе — чаще всего "default configuration has not been created" (портал
        # не настроен в Stripe Dashboard). Логируем полностью, отдаём читаемый текст.
        print(f"[stripe-portal] billing_portal.Session.create failed "
              f"(customer={customer_id}): {e}", flush=True)
        return jsonify({"error": f"Could not open billing portal: {e}"}), 502


# ── Speaker rename ────────────────────────────────────────────
@app.route("/api/entries/<entry_id>/rename-speaker", methods=["POST"])
def rename_speaker(entry_id):
    """Глобально переименовать спикера в одной записи (запись = transcripts row).

    Body (JSON): {"old_name": "<speaker key>", "new_name": "Артем"}.

    `old_name` — СТАБИЛЬНЫЙ ключ спикера: raw-лейбл диаризации ("SPEAKER_01",
    который в UI отображается как "Speaker 2"). Имя сохраняем в JSONB-карту
    `transcripts.speaker_names` (label → отображаемое имя), а сами `segments`
    оставляем с raw-лейблами. Так переименование применяется ко ВСЕМ блокам
    спикера разом (UI рендерит имя через эту карту), и при этом НЕ ломаются
    цвета спикеров (они назначаются по индексу raw-лейбла). Пустой `new_name`
    — сброс к дефолтному "Speaker N".

    Идемпотентно. Service role + ручная проверка владельца (RLS обходим).
    """
    if not g.user_id:
        return jsonify({"error": "auth required"}), 401

    data = request.get_json(silent=True) or {}
    old_name = (data.get("old_name") or "").strip()
    new_name = (data.get("new_name") or "").strip()[:80]
    if not old_name:
        return jsonify({"error": "old_name required"}), 400

    try:
        rows = _sb_admin("transcripts",
                         params={"id": f"eq.{entry_id}",
                                 "select": "user_id,speaker_names"})
    except Exception as e:
        return jsonify({"error": f"transcript fetch failed: {e}"}), 502
    if not rows:
        return jsonify({"error": "entry not found"}), 404
    if rows[0].get("user_id") != g.user_id:
        return jsonify({"error": "not your transcript"}), 403

    names = rows[0].get("speaker_names")
    if not isinstance(names, dict):
        names = {}
    if new_name:
        names[old_name] = new_name
    else:
        names.pop(old_name, None)   # revert to default label

    try:
        _sb_admin("transcripts", method="PATCH",
                  params={"id": f"eq.{entry_id}"},
                  data={"speaker_names": names})
    except Exception as e:
        return jsonify({"error": f"save failed: {e}"}), 502

    return jsonify({"ok": True, "speaker_names": names})


# ── Notion integration ────────────────────────────────────────
# Public OAuth integration. Flow:
#   1. Frontend GET /api/notion/oauth/start → returns Notion auth URL
#   2. User authorizes at notion.so → redirect to /api/notion/oauth/callback
#   3. Callback exchanges code for token, stores in user_profiles, redirects to /app
#   4. Frontend can POST /api/notion/send to push a transcript as a new page
#   5. POST /api/notion/disconnect clears the token


def _notion_request(method: str, path: str, token: str, body: dict | None = None):
    """Authenticated request to Notion API. Returns parsed JSON or raises."""
    url = f"https://api.notion.com/v1{path}"
    headers = {
        "Authorization": f"Bearer {token}",
        "Notion-Version": NOTION_API_VERSION,
        "Content-Type": "application/json",
    }
    r = requests.request(method, url, headers=headers, json=body, timeout=15)
    if r.status_code >= 400:
        raise RuntimeError(f"Notion API {r.status_code}: {r.text[:300]}")
    return r.json() if r.content else {}


@app.route("/api/notion/oauth/start", methods=["GET"])
def notion_oauth_start():
    """Returns Notion authorization URL. Frontend opens it (full redirect or popup)."""
    if not g.user_id:
        return jsonify({"error": "auth required"}), 401
    if not NOTION_OAUTH_CLIENT_ID:
        return jsonify({"error": "Notion not configured"}), 503
    # State carries the user_id so callback knows who to attach the token to.
    # In production add HMAC signing to prevent forgery; for now this is OK
    # because we double-check by also requiring a valid JWT on the original
    # /start call (state would be replayed by an attacker only if they had
    # the JWT, which means full account access already).
    import secrets, base64, json as _json
    nonce = secrets.token_urlsafe(12)
    state_obj = {"uid": g.user_id, "n": nonce}
    state = base64.urlsafe_b64encode(_json.dumps(state_obj).encode()).decode()
    params = {
        "client_id": NOTION_OAUTH_CLIENT_ID,
        "response_type": "code",
        "owner": "user",
        "redirect_uri": NOTION_REDIRECT_URI,
        "state": state,
    }
    qs = "&".join(f"{k}={requests.utils.quote(str(v), safe='')}" for k, v in params.items())
    return jsonify({"url": f"https://api.notion.com/v1/oauth/authorize?{qs}"})


@app.route("/api/notion/oauth/callback", methods=["GET"])
def notion_oauth_callback():
    """Notion redirects here after user authorizes. Exchanges code for token
    and saves it to user_profiles, then redirects back to /app.
    NOTE: this endpoint is in _PUBLIC_API_PATHS — Notion doesn't carry our JWT.
    Auth happens via state param which encodes the original user_id.
    """
    import base64, json as _json
    code  = request.args.get("code")
    state = request.args.get("state", "")
    err   = request.args.get("error")
    # If user clicked Cancel on Notion's auth screen
    if err or not code:
        return _notion_redirect_to_app("error", err or "no_code")
    try:
        state_obj = _json.loads(base64.urlsafe_b64decode(state.encode()).decode())
        user_id = state_obj.get("uid")
        if not user_id:
            raise ValueError("no uid in state")
    except Exception as e:
        print(f"[notion] bad state: {e}", flush=True)
        return _notion_redirect_to_app("error", "bad_state")

    # Exchange code → access_token (Basic auth with client_id:client_secret)
    try:
        import base64 as _b64
        basic = _b64.b64encode(
            f"{NOTION_OAUTH_CLIENT_ID}:{NOTION_OAUTH_CLIENT_SECRET}".encode()
        ).decode()
        r = requests.post(
            "https://api.notion.com/v1/oauth/token",
            headers={
                "Authorization": f"Basic {basic}",
                "Content-Type": "application/json",
                "Notion-Version": NOTION_API_VERSION,
            },
            json={
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": NOTION_REDIRECT_URI,
            },
            timeout=15,
        )
        if r.status_code >= 400:
            print(f"[notion] token exchange failed: {r.status_code} {r.text[:300]}", flush=True)
            return _notion_redirect_to_app("error", "exchange_failed")
        tok = r.json()
    except Exception as e:
        print(f"[notion] token exchange exception: {e}", flush=True)
        return _notion_redirect_to_app("error", "exchange_exception")

    # Save tokens
    try:
        _sb_admin("user_profiles", method="PATCH",
                  params={"id": f"eq.{user_id}"},
                  data={
                      "notion_access_token":   tok.get("access_token"),
                      "notion_bot_id":         tok.get("bot_id"),
                      "notion_workspace_id":   tok.get("workspace_id"),
                      "notion_workspace_name": tok.get("workspace_name"),
                      "notion_workspace_icon": tok.get("workspace_icon"),
                      "notion_connected_at":   datetime.utcnow().isoformat(),
                  })
    except Exception as e:
        print(f"[notion] save token failed: {e}", flush=True)
        return _notion_redirect_to_app("error", "save_failed")

    return _notion_redirect_to_app("connected", tok.get("workspace_name") or "")


def _notion_redirect_to_app(status: str, detail: str = ""):
    """Helper to bounce back to /app with status indicator in URL."""
    from flask import redirect
    origin = request.headers.get("Referer", "").split("?")[0]
    # Notion's redirect doesn't carry a Referer. Default to skriptly.io.
    if not origin or "notion.com" in origin:
        origin = "https://skriptly.io/app"
    params = f"?notion={status}"
    if detail:
        params += f"&detail={requests.utils.quote(detail, safe='')}"
    return redirect(origin + params, code=302)


@app.route("/api/notion/disconnect", methods=["POST"])
def notion_disconnect():
    """Clears Notion tokens for the user. Doesn't revoke on Notion's side
    (no API for that — user must revoke from their Notion settings if desired)."""
    if not g.user_id:
        return jsonify({"error": "auth required"}), 401
    try:
        _sb_admin("user_profiles", method="PATCH",
                  params={"id": f"eq.{g.user_id}"},
                  data={
                      "notion_access_token": None,
                      "notion_bot_id": None,
                      "notion_workspace_id": None,
                      "notion_workspace_name": None,
                      "notion_workspace_icon": None,
                      "notion_default_parent_id": None,
                      "notion_connected_at": None,
                  })
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


def _segments_to_notion_blocks(segments, speaker_names):
    """Convert transcript segments to Notion paragraph blocks with bolded speakers.
    Notion has a 2000-char limit per rich_text block; we group consecutive
    same-speaker segments and split if needed."""
    blocks = []
    if not segments:
        return blocks
    # Group consecutive same-speaker
    grouped = []
    cur = None
    for s in segments:
        spk_raw = s.get("speaker", "SPEAKER_UNKNOWN")
        spk = (speaker_names or {}).get(spk_raw, spk_raw)
        text = (s.get("text") or "").strip()
        if not text:
            continue
        if cur and cur["spk"] == spk:
            cur["text"] += " " + text
        else:
            if cur:
                grouped.append(cur)
            cur = {"spk": spk, "text": text}
    if cur:
        grouped.append(cur)

    for g_ in grouped:
        # Split if text > 1900 chars (leave room for speaker prefix)
        chunks = [g_["text"][i:i+1900] for i in range(0, len(g_["text"]), 1900)] or [""]
        for idx, chunk in enumerate(chunks):
            rich = []
            if idx == 0:
                rich.append({"type": "text", "text": {"content": f"{g_['spk']}: "},
                             "annotations": {"bold": True}})
            rich.append({"type": "text", "text": {"content": chunk}})
            blocks.append({
                "object": "block",
                "type": "paragraph",
                "paragraph": {"rich_text": rich},
            })
    return blocks


def _rich_text(text: str) -> list:
    """Inline markdown (bold/italic) → Notion rich_text array."""
    parts = []
    pattern = re.compile(r'\*\*(.+?)\*\*|\*(.+?)\*')
    last = 0
    src = text[:2000]
    for m in pattern.finditer(src):
        if m.start() > last:
            parts.append({"type": "text", "text": {"content": src[last:m.start()]}})
        if m.group(1) is not None:
            parts.append({"type": "text", "text": {"content": m.group(1)},
                          "annotations": {"bold": True}})
        else:
            parts.append({"type": "text", "text": {"content": m.group(2)},
                          "annotations": {"italic": True}})
        last = m.end()
    if last < len(src):
        parts.append({"type": "text", "text": {"content": src[last:]}})
    return parts or [{"type": "text", "text": {"content": src}}]


def _markdown_to_notion_blocks(md: str):
    """markdown → Notion blocks. Headings, bullets, to_do checkboxes, dividers, inline bold/italic."""
    if not md:
        return []
    blocks = []
    for raw_line in md.splitlines():
        line = raw_line.rstrip()
        stripped = line.strip()
        if not stripped:
            continue
        if stripped in ("---", "***", "___"):
            blocks.append({"object": "block", "type": "divider", "divider": {}})
        elif line.startswith("### "):
            blocks.append({"object": "block", "type": "heading_3",
                           "heading_3": {"rich_text": [{"type":"text","text":{"content": line[4:]}}]}})
        elif line.startswith("## "):
            blocks.append({"object": "block", "type": "heading_2",
                           "heading_2": {"rich_text": [{"type":"text","text":{"content": line[3:]}}]}})
        elif line.startswith("# "):
            blocks.append({"object": "block", "type": "heading_1",
                           "heading_1": {"rich_text": [{"type":"text","text":{"content": line[2:]}}]}})
        elif line.lstrip().startswith(("- ", "* ", "• ")):
            content = line.lstrip()[2:].strip()
            if content.startswith("[ ] ") or content == "[ ]":
                blocks.append({"object": "block", "type": "to_do",
                               "to_do": {"rich_text": _rich_text(content[4:].strip()), "checked": False}})
            elif content.lower().startswith("[x] ") or content.lower() == "[x]":
                blocks.append({"object": "block", "type": "to_do",
                               "to_do": {"rich_text": _rich_text(content[4:].strip()), "checked": True}})
            else:
                blocks.append({"object": "block", "type": "bulleted_list_item",
                               "bulleted_list_item": {"rich_text": _rich_text(content)}})
        elif line.lstrip().startswith(tuple(f"{i}. " for i in range(1, 10))):
            content = line.lstrip().split(". ", 1)[1] if ". " in line else line
            blocks.append({"object": "block", "type": "numbered_list_item",
                           "numbered_list_item": {"rich_text": _rich_text(content)}})
        else:
            blocks.append({"object": "block", "type": "paragraph",
                           "paragraph": {"rich_text": _rich_text(line)}})
    return blocks


@app.route("/api/notion/send", methods=["POST"])
def notion_send():
    """Create a Notion page with transcript + (optional) summary + action items.
    Body (JSON):
      title:        page title (defaults to 'Skriptly transcript')
      segments:     transcript segments
      speakerNames: {SPEAKER_00: 'Maya', ...}
      summary:      markdown summary (optional)
      actions:      markdown action items (optional)
      parent_id:    explicit Notion page/db id to nest under (optional;
                    if missing we pick the first accessible page via /search)
    Returns: {url: 'https://notion.so/...', page_id}
    """
    if not g.user_id:
        return jsonify({"error": "auth required"}), 401

    rows = _sb_admin("user_profiles",
                     params={"id": f"eq.{g.user_id}",
                             "select": "notion_access_token,notion_default_parent_id"})
    if not rows or not rows[0].get("notion_access_token"):
        return jsonify({"error": "Notion not connected"}), 400
    token = rows[0]["notion_access_token"]
    default_parent = rows[0].get("notion_default_parent_id")

    data = request.get_json(silent=True) or {}
    title    = (data.get("title") or "Skriptly transcript").strip()[:200]
    segments = data.get("segments") or []
    speakers = data.get("speakerNames") or {}
    summary  = (data.get("summary")  or "").strip()
    actions  = (data.get("actions")  or "").strip()
    parent_id = (data.get("parent_id") or default_parent or "").strip()

    # If no parent provided, find one via search (user granted us specific pages)
    if not parent_id:
        try:
            res = _notion_request("POST", "/search", token, body={
                "filter": {"value": "page", "property": "object"},
                "page_size": 5,
            })
            results = res.get("results") or []
            # Pick first non-archived page where we have write access
            for r in results:
                if r.get("object") == "page" and not r.get("archived"):
                    parent_id = r.get("id")
                    break
        except Exception as e:
            return jsonify({"error": f"Notion search failed: {e}"}), 502

    if not parent_id:
        return jsonify({
            "error": "No accessible pages in your Notion. Share a page with Skriptly first.",
            "no_parent": True,
        }), 400

    # Cache as default for next time
    if not default_parent:
        try:
            _sb_admin("user_profiles", method="PATCH",
                      params={"id": f"eq.{g.user_id}"},
                      data={"notion_default_parent_id": parent_id})
        except Exception:
            pass

    def _drop_first_heading(md: str) -> str:
        """Strip the very first h1/h2 line — caller adds its own section header."""
        lines = md.splitlines()
        for i, ln in enumerate(lines):
            s = ln.strip()
            if s.startswith("## ") or s.startswith("# "):
                return "\n".join(lines[:i] + lines[i + 1:]).lstrip("\n")
            elif s:
                break
        return md

    # Build page content: title + summary + actions + transcript
    children = []
    if summary:
        children.append({"object": "block", "type": "heading_2",
                         "heading_2": {"rich_text": [{"type":"text","text":{"content":"Summary"}}]}})
        children += _markdown_to_notion_blocks(summary)
    if actions:
        children.append({"object": "block", "type": "heading_2",
                         "heading_2": {"rich_text": [{"type":"text","text":{"content":"Action items"}}]}})
        # AI template always opens with ## Action items (translated) — drop it to avoid duplication
        children += _markdown_to_notion_blocks(_drop_first_heading(actions))
    if segments:
        children.append({"object": "block", "type": "heading_2",
                         "heading_2": {"rich_text": [{"type":"text","text":{"content":"Transcript"}}]}})
        children += _segments_to_notion_blocks(segments, speakers)

    # Notion caps children at 100 blocks per page creation request — split if needed
    try:
        page_body = {
            "parent": {"page_id": parent_id},
            "properties": {
                "title": {"title": [{"type": "text", "text": {"content": title}}]}
            },
            "children": children[:100],
        }
        page = _notion_request("POST", "/pages", token, body=page_body)
        page_id = page.get("id")
        page_url = page.get("url")
        # Append remaining children in chunks of 100
        if len(children) > 100:
            for i in range(100, len(children), 100):
                _notion_request("PATCH", f"/blocks/{page_id}/children", token,
                                body={"children": children[i:i+100]})
        return jsonify({"ok": True, "url": page_url, "page_id": page_id})
    except Exception as e:
        return jsonify({"error": str(e)}), 502


# ── Delete account (GDPR) ──────────────────────────────────────
@app.route("/api/account/delete", methods=["POST"])
def account_delete():
    """Permanently delete user account + all associated data.
    Required for GDPR compliance.

    Order matters:
    1. Cancel Stripe subscription (if active) — releases the customer's payment
       method and stops future charges. We don't delete the Stripe Customer
       itself — keeping it preserves invoice history for accounting.
    2. Delete transcripts (cascade — RLS only allows the user's own rows)
    3. Leave or delete workspace if owner / member
    4. Delete user_profiles row
    5. Delete Supabase auth.user (Admin API) — this revokes all sessions

    No undo. Frontend MUST require explicit confirmation before calling.
    """
    if not g.user_id:
        return jsonify({"error": "auth required"}), 401
    if not SUPABASE_SERVICE_ROLE_KEY or not SUPABASE_URL:
        return jsonify({"error": "service unavailable"}), 503

    user_id = g.user_id
    print(f"[delete-account] start user_id={user_id}", flush=True)

    # 1. Cancel Stripe subscription if any
    try:
        rows = _sb_admin("user_profiles",
                         params={"id": f"eq.{user_id}",
                                 "select": "stripe_subscription_id,stripe_customer_id"})
        sub_id = (rows[0].get("stripe_subscription_id") if rows else "") or ""
        if sub_id and STRIPE_SECRET_KEY:
            try:
                import stripe as _stripe
                _stripe.api_key = STRIPE_SECRET_KEY
                _stripe.Subscription.cancel(sub_id)
                print(f"[delete-account] stripe sub {sub_id} cancelled", flush=True)
            except Exception as e:
                # Sub might already be cancelled, expired, etc — don't block deletion
                print(f"[delete-account] stripe cancel non-fatal: {e}", flush=True)
    except Exception as e:
        print(f"[delete-account] stripe lookup failed: {e}", flush=True)

    # 2. Delete transcripts (own only — RLS via service role can bulk delete)
    try:
        _sb_admin("transcripts", method="DELETE",
                  params={"user_id": f"eq.{user_id}"})
    except Exception as e:
        print(f"[delete-account] transcripts delete failed: {e}", flush=True)

    # 3. Handle workspace membership
    try:
        # Remove memberships
        _sb_admin("workspace_members", method="DELETE",
                  params={"user_id": f"eq.{user_id}"})
        # If user owned any workspaces, delete them (members cleaned via cascade)
        _sb_admin("workspaces", method="DELETE",
                  params={"owner_id": f"eq.{user_id}"})
    except Exception as e:
        print(f"[delete-account] workspace cleanup failed: {e}", flush=True)

    # 4. Delete user_profile
    try:
        _sb_admin("user_profiles", method="DELETE",
                  params={"id": f"eq.{user_id}"})
    except Exception as e:
        print(f"[delete-account] profile delete failed: {e}", flush=True)

    # 5. Delete Supabase auth user (revokes all sessions)
    try:
        r = requests.delete(
            f"{SUPABASE_URL}/auth/v1/admin/users/{user_id}",
            headers={
                "apikey": SUPABASE_SERVICE_ROLE_KEY,
                "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
            },
            timeout=10,
        )
        if r.status_code not in (200, 204):
            print(f"[delete-account] auth delete returned {r.status_code}: {r.text}", flush=True)
    except Exception as e:
        print(f"[delete-account] auth delete failed: {e}", flush=True)
        return jsonify({"error": "Account data wiped but auth user deletion failed. Contact support.", "partial": True}), 500

    print(f"[delete-account] done user_id={user_id}", flush=True)
    return jsonify({"ok": True})


# ── Workspace ──────────────────────────────────────────────────
# Workspace = collaboration layer. Each user belongs to at most ONE workspace
# (either as owner or as active member — not both, not multiple).
# No shared billing: every member has their own plan/limits independently.
#
# Endpoints:
#   GET  /api/workspace             — get current user's workspace (owner or member)
#   POST /api/workspace             — create new workspace
#   DELETE /api/workspace           — delete workspace (owner only)
#   POST /api/workspace/invite      — invite member by email
#   DELETE /api/workspace/members/<id> — remove member (owner only)
#   POST /api/workspace/leave       — leave workspace (member only)
#   POST /api/workspace/accept      — accept pending invitation (by current email)


def _get_user_workspace(user_id: str, user_email: str | None = None) -> dict | None:
    """Returns workspace info for a user (owner or active member), or None."""
    # Check if user is owner of a workspace
    rows = _sb_admin("workspaces", params={
        "owner_id": f"eq.{user_id}", "select": "*", "limit": "1"
    })
    if rows:
        ws = dict(rows[0])
        ws["is_owner"] = True
        ws["members"] = _sb_admin("workspace_members", params={
            "workspace_id": f"eq.{ws['id']}", "select": "*", "order": "invited_at.asc"
        })
        return ws

    # Check if user is active member
    mem_rows = _sb_admin("workspace_members", params={
        "user_id": f"eq.{user_id}", "status": "eq.active", "select": "workspace_id", "limit": "1"
    })
    if mem_rows:
        ws_id = mem_rows[0]["workspace_id"]
        ws_rows = _sb_admin("workspaces", params={"id": f"eq.{ws_id}", "select": "*"})
        if ws_rows:
            ws = dict(ws_rows[0])
            ws["is_owner"] = False
            ws["members"] = _sb_admin("workspace_members", params={
                "workspace_id": f"eq.{ws_id}", "select": "*", "order": "invited_at.asc"
            })
            return ws

    return None


def _get_workspace_presets(user_id: str) -> list:
    """Return team presets for the workspace the user belongs to (owner or member).
    Returns [] if user has no workspace or workspace has no presets."""
    try:
        ws = _get_user_workspace(user_id)
        if not ws:
            return []
        return list(ws.get("presets") or [])
    except Exception as e:
        print(f"[presets] _get_workspace_presets error: {e}", flush=True)
        return []


def _load_preset_prompt(user_id: str, preset_id: str) -> tuple[str, str] | None:
    """Load (name, prompt) for a preset_id from personal or team presets.
    Returns None if not found."""
    try:
        profile = _get_user_profile(user_id)
        for p in (profile.get("presets") or []):
            if isinstance(p, dict) and p.get("id") == preset_id:
                return (p.get("name") or "Custom", p.get("prompt") or "")
        # Team presets
        ws_presets = _get_workspace_presets(user_id)
        for p in ws_presets:
            if isinstance(p, dict) and p.get("id") == preset_id:
                return (p.get("name") or "Custom", p.get("prompt") or "")
    except Exception as e:
        print(f"[presets] _load_preset_prompt error: {e}", flush=True)
    return None


def _count_workspace_seats(workspace_id: str) -> int:
    """Count current seats for a workspace = owner (always 1) + active members + invited members.
    Pending invites count because billing happens on invite send.
    Returns at least 1 (the owner)."""
    try:
        rows = _sb_admin("workspace_members", params={
            "workspace_id": f"eq.{workspace_id}",
            "status": "in.(active,invited)",
            "select": "id",
        })
        return 1 + len(rows or [])
    except Exception as e:
        print(f"[team] seat count failed: {e}", flush=True)
        return 1


def _update_stripe_team_seats(workspace_id: str, new_qty: int) -> bool:
    """Update Stripe subscription quantity for a workspace's Team plan.
    Returns True on success, False otherwise (logged but non-fatal).

    Stripe handles proration automatically — owner sees a prorated invoice
    line on their next bill. We don't change workspaces.seats here; the
    webhook (customer.subscription.updated) will reflect it back.
    """
    if not STRIPE_SECRET_KEY:
        return False
    try:
        rows = _sb_admin("workspaces", params={
            "id": f"eq.{workspace_id}",
            "select": "stripe_subscription_id,plan",
        })
        if not rows:
            return False
        sub_id = rows[0].get("stripe_subscription_id")
        if not sub_id or rows[0].get("plan") != "team":
            # Workspace isn't on Team plan — no Stripe sync needed
            return False
        new_qty = max(TEAM_MIN_SEATS, int(new_qty))

        import stripe as _stripe
        _stripe.api_key = STRIPE_SECRET_KEY
        sub = _stripe.Subscription.retrieve(sub_id)
        item_id = sub["items"]["data"][0]["id"]
        _stripe.Subscription.modify(sub_id, items=[{"id": item_id, "quantity": new_qty}],
                                    proration_behavior="create_prorations")
        print(f"[team] stripe seats updated: ws={workspace_id} qty={new_qty}", flush=True)
        return True
    except Exception as e:
        print(f"[team] stripe seats sync failed: {e}", flush=True)
        return False


def _get_effective_plan(user_id: str, user_email: str | None = None,
                        own_profile: dict | None = None) -> str:
    """Return the plan that's actually in effect for this user.

    Resolution order:
    1. If user belongs to a Team workspace (owner or active member) → 'team'
    2. Otherwise → user_profiles.plan (own subscription, default 'free')

    Pending invites do NOT grant team access — only accepted ones do.
    """
    # Quick path: own paid plan beats workspace if we already know it
    own_plan = (own_profile or {}).get("plan", "free")

    # Owner of a Team workspace?
    try:
        rows = _sb_admin("workspaces", params={
            "owner_id": f"eq.{user_id}",
            "plan": "eq.team",
            "select": "id", "limit": "1",
        })
        if rows:
            return "team"
    except Exception as e:
        print(f"[plan] team owner lookup failed: {e}", flush=True)

    # Active member of a Team workspace?
    try:
        rows = _sb_admin("workspace_members", params={
            "user_id": f"eq.{user_id}",
            "status": "eq.active",
            "select": "workspace_id", "limit": "1",
        })
        if rows:
            ws_rows = _sb_admin("workspaces", params={
                "id": f"eq.{rows[0]['workspace_id']}",
                "plan": "eq.team",
                "select": "id", "limit": "1",
            })
            if ws_rows:
                return "team"
    except Exception as e:
        print(f"[plan] team member lookup failed: {e}", flush=True)

    return own_plan


def _lookup_user_id_by_email(email: str) -> str | None:
    """Looks up a registered user's ID by email via Supabase Admin API."""
    if not SUPABASE_SERVICE_ROLE_KEY or not SUPABASE_URL:
        return None
    try:
        r = requests.get(
            f"{SUPABASE_URL}/auth/v1/admin/users",
            headers={
                "apikey": SUPABASE_SERVICE_ROLE_KEY,
                "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
            },
            params={"page": 1, "per_page": 1000},
            timeout=5,
        )
        if r.status_code == 200:
            for u in (r.json().get("users") or []):
                if (u.get("email") or "").lower() == email.lower():
                    return u.get("id")
    except Exception as e:
        print(f"[workspace] user lookup failed: {e}")
    return None


@app.route("/api/workspace", methods=["GET"])
def workspace_get():
    """Return current user's workspace (as owner or member)."""
    ws = _get_user_workspace(g.user_id, g.user_email)
    return jsonify({"workspace": ws})


@app.route("/api/workspace", methods=["POST"])
def workspace_create():
    """Create a new workspace. User must not already belong to one."""
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"error": "name required"}), 400
    if len(name) > 64:
        return jsonify({"error": "name too long (max 64 chars)"}), 400

    existing = _get_user_workspace(g.user_id, g.user_email)
    if existing:
        return jsonify({"error": "You already belong to a workspace."}), 409

    rows = _sb_admin("workspaces", method="POST", data={
        "name": name, "owner_id": g.user_id,
    })
    if not rows:
        return jsonify({"error": "failed to create workspace"}), 500

    ws = dict(rows[0])
    ws["is_owner"] = True
    ws["members"] = []
    return jsonify({"workspace": ws}), 201


@app.route("/api/workspace", methods=["DELETE"])
def workspace_delete():
    """Delete workspace entirely. Owner only. Unshares all transcripts.
    Cancels any active Stripe Team subscription (keeps Customer record)."""
    ws_rows = _sb_admin("workspaces", params={
        "owner_id": f"eq.{g.user_id}",
        "select": "id,stripe_subscription_id,plan",
    })
    if not ws_rows:
        return jsonify({"error": "You don't own a workspace."}), 404
    ws_id = ws_rows[0]["id"]

    # Cancel active Team subscription so owner stops being billed
    sub_id = ws_rows[0].get("stripe_subscription_id")
    if sub_id and STRIPE_SECRET_KEY:
        try:
            import stripe as _stripe
            _stripe.api_key = STRIPE_SECRET_KEY
            _stripe.Subscription.cancel(sub_id)
            print(f"[team] cancelled sub {sub_id} on workspace delete", flush=True)
        except Exception as e:
            # Sub might already be cancelled — don't block workspace deletion
            print(f"[team] cancel sub non-fatal: {e}", flush=True)

    # Unshare all transcripts that belonged to this workspace
    try:
        _sb_admin("transcripts", method="PATCH",
                  params={"workspace_id": f"eq.{ws_id}"},
                  data={"workspace_id": None, "visibility": "private"})
    except Exception as e:
        print(f"[workspace delete] unshare failed (non-fatal): {e}")

    # Delete workspace — members cascade via FK
    _sb_admin("workspaces", method="DELETE", params={"id": f"eq.{ws_id}"})
    return jsonify({"ok": True})


@app.route("/api/workspace/upgrade-team", methods=["POST"])
def workspace_upgrade_team():
    """Start Stripe Checkout for upgrading a workspace to Team plan.

    Body (JSON): {billing: "monthly" | "annual"}
    Owner only. Minimum quantity is TEAM_MIN_SEATS (currently 2).
    On webhook completion, workspaces.plan='team' + stripe ids are saved.
    Returns: {url: "https://checkout.stripe.com/..."}
    """
    import stripe as _stripe
    _stripe.api_key = STRIPE_SECRET_KEY
    if not STRIPE_SECRET_KEY:
        return jsonify({"error": "Stripe not configured"}), 503

    ws_rows = _sb_admin("workspaces", params={
        "owner_id": f"eq.{g.user_id}", "select": "id,name,plan"
    })
    if not ws_rows:
        return jsonify({"error": "You must own a workspace to upgrade it."}), 403
    ws = ws_rows[0]
    if ws.get("plan") == "team":
        return jsonify({"error": "Workspace is already on Team plan."}), 409

    data = request.get_json(silent=True) or {}
    billing = (data.get("billing") or "monthly").lower()
    if billing not in ("monthly", "annual"):
        billing = "monthly"
    price_id = STRIPE_PRICE_MAP.get(("team", billing), lambda: "")()
    if not price_id:
        return jsonify({"error": f"Team {billing} price not configured"}), 500

    # Initial quantity = max(min, current seat count). Owner alone → use min.
    current_seats = _count_workspace_seats(ws["id"])
    qty = max(TEAM_MIN_SEATS, current_seats)

    origin = request.headers.get("Origin", "https://skriptly.io")
    try:
        session = _stripe.checkout.Session.create(
            mode="subscription",
            line_items=[{"price": price_id, "quantity": qty}],
            success_url=origin + "/app?team_subscribed=1",
            cancel_url=origin + "/app?team_subscribed=0",
            customer_email=g.user_email or None,
            client_reference_id=ws["id"],
            metadata={"type": "workspace_team", "workspace_id": ws["id"],
                      "billing": billing, "owner_id": g.user_id},
            subscription_data={
                "metadata": {"type": "workspace_team", "workspace_id": ws["id"],
                             "billing": billing}
            },
            allow_promotion_codes=True,
        )
        return jsonify({"url": session.url, "qty": qty})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/workspace/billing-portal", methods=["POST"])
def workspace_billing_portal():
    """Open Stripe Customer Portal for the workspace's owner. Owner only."""
    import stripe as _stripe
    _stripe.api_key = STRIPE_SECRET_KEY
    if not STRIPE_SECRET_KEY:
        return jsonify({"error": "Stripe not configured"}), 503

    ws_rows = _sb_admin("workspaces", params={
        "owner_id": f"eq.{g.user_id}",
        "select": "id,stripe_customer_id,plan",
    })
    if not ws_rows:
        return jsonify({"error": "You must own a workspace."}), 403
    customer_id = ws_rows[0].get("stripe_customer_id")
    if not customer_id:
        return jsonify({"error": "No active Team subscription found.",
                        "no_subscription": True}), 404

    origin = request.headers.get("Origin", "https://skriptly.io")
    try:
        session = _stripe.billing_portal.Session.create(
            customer=customer_id,
            return_url=origin + "/app?portal=team_return",
        )
        return jsonify({"url": session.url})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/workspace/invite", methods=["POST"])
def workspace_invite():
    """Invite a user by email. Owner only.

    If the email belongs to an existing registered user → creates active member immediately.
    If not registered yet → creates 'invited' row; they can accept via /api/workspace/accept.
    """
    data = request.get_json(silent=True) or {}
    email = (data.get("email") or "").strip().lower()
    if not email or "@" not in email:
        return jsonify({"error": "valid email required"}), 400

    # Must be workspace owner
    ws_rows = _sb_admin("workspaces", params={
        "owner_id": f"eq.{g.user_id}", "select": "id,name"
    })
    if not ws_rows:
        return jsonify({"error": "You must own a workspace to invite members."}), 403
    ws_id = ws_rows[0]["id"]

    # Can't invite yourself
    if email == (g.user_email or "").lower():
        return jsonify({"error": "You cannot invite yourself."}), 400

    # Check if already a member/invited
    existing = _sb_admin("workspace_members", params={
        "workspace_id": f"eq.{ws_id}", "email": f"eq.{email}", "select": "id,status"
    })
    if existing:
        st = existing[0].get("status")
        if st == "active":
            return jsonify({"error": "This user is already a member."}), 409
        if st == "invited":
            return jsonify({"error": "Invitation already sent to this email."}), 409

    # Look up if this email belongs to a registered user
    invited_user_id = _lookup_user_id_by_email(email)

    # If user exists, check they don't already belong to another workspace
    if invited_user_id:
        their_ws = _get_user_workspace(invited_user_id)
        if their_ws:
            return jsonify({"error": "This user already belongs to a workspace."}), 409

    # Create invite row
    invite_data = {
        "workspace_id": ws_id,
        "email": email,
        "role": "member",
        "status": "active" if invited_user_id else "invited",
        "invited_by": g.user_id,
    }
    if invited_user_id:
        invite_data["user_id"] = invited_user_id
        invite_data["joined_at"] = datetime.utcnow().isoformat()

    rows = _sb_admin("workspace_members", method="POST", data=invite_data)
    if not rows:
        return jsonify({"error": "failed to create invite"}), 500

    # If workspace is on Team plan, bump Stripe seat count (bill on invite send).
    # _update_stripe_team_seats is no-op for free workspaces.
    new_qty = _count_workspace_seats(ws_id)
    _update_stripe_team_seats(ws_id, new_qty)

    status = invite_data["status"]
    return jsonify({"member": rows[0], "status": status}), 201


@app.route("/api/workspace/members/<member_id>", methods=["DELETE"])
def workspace_remove_member(member_id):
    """Remove a member from the workspace. Owner only."""
    ws_rows = _sb_admin("workspaces", params={
        "owner_id": f"eq.{g.user_id}", "select": "id"
    })
    if not ws_rows:
        return jsonify({"error": "You must own a workspace to remove members."}), 403
    ws_id = ws_rows[0]["id"]

    mem_rows = _sb_admin("workspace_members", params={
        "id": f"eq.{member_id}", "workspace_id": f"eq.{ws_id}", "select": "id"
    })
    if not mem_rows:
        return jsonify({"error": "Member not found in your workspace."}), 404

    _sb_admin("workspace_members", method="DELETE", params={"id": f"eq.{member_id}"})
    # Decrement Stripe seat count if Team plan (Stripe enforces TEAM_MIN_SEATS floor)
    _update_stripe_team_seats(ws_id, _count_workspace_seats(ws_id))
    return jsonify({"ok": True})


@app.route("/api/workspace/leave", methods=["POST"])
def workspace_leave():
    """Leave workspace. Member only (owner must delete instead)."""
    rows = _sb_admin("workspace_members", params={
        "user_id": f"eq.{g.user_id}", "status": "eq.active",
        "select": "id,workspace_id"
    })
    if not rows:
        return jsonify({"error": "You are not a member of any workspace."}), 404
    ws_id = rows[0]["workspace_id"]

    _sb_admin("workspace_members", method="DELETE", params={"id": f"eq.{rows[0]['id']}"})
    # Free up a seat on the owner's Team subscription
    _update_stripe_team_seats(ws_id, _count_workspace_seats(ws_id))
    return jsonify({"ok": True})


@app.route("/api/workspace/accept", methods=["POST"])
def workspace_accept():
    """Accept a pending invitation matched by current user's email.

    Called when user logs in and might have a pending invite.
    Returns {has_invite: false} if none found — safe to call on every login.
    """
    email = (g.user_email or "").lower()
    if not email:
        return jsonify({"error": "email not in token"}), 400

    rows = _sb_admin("workspace_members", params={
        "email": f"eq.{email}", "status": "eq.invited", "select": "*", "limit": "1"
    })
    if not rows:
        return jsonify({"has_invite": False})

    member = rows[0]

    # Check if user already belongs to another workspace
    existing = _get_user_workspace(g.user_id, g.user_email)
    if existing:
        return jsonify({"error": "You already belong to a workspace."}), 409

    # Activate the invite
    _sb_admin("workspace_members", method="PATCH",
              params={"id": f"eq.{member['id']}"},
              data={
                  "user_id": g.user_id,
                  "status": "active",
                  "joined_at": datetime.utcnow().isoformat(),
              })

    ws = _get_user_workspace(g.user_id, g.user_email)
    return jsonify({"has_invite": True, "workspace": ws})


@app.route("/api/stripe/webhook", methods=["POST"])
def stripe_webhook():
    """Stripe отправляет сюда события подписок. Обновляем план в Supabase."""
    import stripe as _stripe
    _stripe.api_key = STRIPE_SECRET_KEY
    if not STRIPE_SECRET_KEY or not STRIPE_WEBHOOK_SECRET:
        return jsonify({"error": "Stripe not configured"}), 503

    payload = request.get_data()
    sig = request.headers.get("Stripe-Signature", "")
    try:
        event = _stripe.Webhook.construct_event(payload, sig, STRIPE_WEBHOOK_SECRET)
    except Exception as e:
        return jsonify({"error": str(e)}), 400

    etype = event["type"]
    obj = event["data"]["object"]

    # Stripe SDK v5+ objects are not dicts — use getattr(..., None) instead of .get()
    def _g(o, key, default=None):
        try:
            return getattr(o, key, default)
        except Exception:
            return default

    def _meta_get(o, key):
        m = _g(o, "metadata") or {}
        if isinstance(m, dict):
            return m.get(key)
        return getattr(m, key, None)

    if etype == "checkout.session.completed":
        meta_type = _meta_get(obj, "type") or ""
        # ── Workspace Team subscription ─────────────────────────────
        if meta_type == "workspace_team":
            workspace_id = _meta_get(obj, "workspace_id")
            billing      = (_meta_get(obj, "billing") or "monthly")
            customer     = _g(obj, "customer")
            sub_id       = _g(obj, "subscription")
            # Fetch subscription to get quantity (seat count)
            qty = TEAM_MIN_SEATS
            try:
                import stripe as _stripe
                _stripe.api_key = STRIPE_SECRET_KEY
                sub = _stripe.Subscription.retrieve(sub_id)
                qty = sub["items"]["data"][0].get("quantity", TEAM_MIN_SEATS)
            except Exception as e:
                print(f"[webhook] team sub retrieve failed: {e}", flush=True)
            if workspace_id:
                _sb_admin("workspaces", method="PATCH",
                          params={"id": f"eq.{workspace_id}"},
                          data={
                              "plan": "team",
                              "billing": billing,
                              "stripe_customer_id": customer,
                              "stripe_subscription_id": sub_id,
                              "seats": int(qty),
                          })
                print(f"[webhook] workspace {workspace_id} → team, seats={qty}", flush=True)
                # Notify admin: new Team subscription
                amount = (_g(obj, "amount_total") or 0) / 100
                currency = (_g(obj, "currency") or "usd").upper()
                discount = _stripe_session_discount_summary(obj)
                _notify_admin(
                    f"💰 <b>New Team subscription</b>\n\n"
                    f"💵 {amount:.2f} {currency} ({billing}, {qty} seats)\n"
                    f"🏢 workspace: <code>{workspace_id}</code>\n"
                    f"{discount}"
                )
            return jsonify({"ok": True})

        # ── Team upsell: auto-create the workspace from the typed name ──
        # The user had no workspace; they paid for Team via /api/stripe/checkout
        # (plan=team) with `pending_workspace_name` in metadata. Create the
        # workspace now, link the subscription, and re-tag the subscription so
        # future updated/deleted events route through the workspace_team branch.
        if meta_type == "personal_team_create":
            owner_id     = _g(obj, "client_reference_id") or _meta_get(obj, "user_id")
            pending_name = (_meta_get(obj, "pending_workspace_name") or "Workspace").strip() or "Workspace"
            billing      = (_meta_get(obj, "billing") or "monthly")
            customer     = _g(obj, "customer")
            sub_id       = _g(obj, "subscription")

            import stripe as _stripe
            _stripe.api_key = STRIPE_SECRET_KEY

            # Seat quantity from the subscription (falls back to the minimum).
            qty = TEAM_MIN_SEATS
            try:
                sub = _stripe.Subscription.retrieve(sub_id)
                qty = sub["items"]["data"][0].get("quantity", TEAM_MIN_SEATS)
            except Exception as e:
                print(f"[webhook] personal_team_create sub retrieve failed: {e}", flush=True)

            ws_id = None
            if owner_id:
                # Idempotency: if a workspace already exists for this owner (retry,
                # double webhook), patch it instead of creating a duplicate.
                try:
                    existing = _sb_admin("workspaces",
                                         params={"owner_id": f"eq.{owner_id}", "select": "id"})
                except Exception as e:
                    print(f"[webhook] personal_team_create owner lookup failed: {e}", flush=True)
                    existing = []

                ws_payload = {
                    "name": pending_name,
                    "plan": "team",
                    "billing": billing,
                    "stripe_customer_id": customer,
                    "stripe_subscription_id": sub_id,
                    "seats": int(qty),
                }
                if existing:
                    ws_id = existing[0]["id"]
                    _sb_admin("workspaces", method="PATCH",
                              params={"id": f"eq.{ws_id}"}, data=ws_payload)
                else:
                    rows = _sb_admin("workspaces", method="POST",
                                     data={**ws_payload, "owner_id": owner_id})
                    ws_id = rows[0]["id"] if rows else None

                print(f"[webhook] personal_team_create → workspace {ws_id} "
                      f"name={pending_name!r} seats={qty}", flush=True)

                # Re-tag the subscription so later updated/deleted events hit the
                # existing workspace_team branch (which keys on metadata.type).
                if ws_id and sub_id:
                    try:
                        _stripe.Subscription.modify(sub_id, metadata={
                            "type": "workspace_team",
                            "workspace_id": ws_id,
                            "billing": billing,
                        })
                    except Exception as e:
                        print(f"[webhook] personal_team_create sub re-tag failed: {e}", flush=True)

                amount = (_g(obj, "amount_total") or 0) / 100
                currency = (_g(obj, "currency") or "usd").upper()
                discount = _stripe_session_discount_summary(obj)
                _notify_admin(
                    f"💰 <b>New Team subscription (auto-workspace)</b>\n\n"
                    f"💵 {amount:.2f} {currency} ({billing}, {qty} seats)\n"
                    f"🏢 workspace: <code>{ws_id}</code> · {pending_name}\n"
                    f"🆔 <code>{owner_id}</code>\n"
                    f"{discount}"
                )
            else:
                print("[webhook] personal_team_create missing owner_id — skipped", flush=True)
            return jsonify({"ok": True})

        # ── Personal subscription (Pro/Max) ──────────────────────────
        user_id = _g(obj, "client_reference_id")
        plan_name = _meta_get(obj, "plan") or "pro"
        if plan_name not in ("pro", "max"):
            plan_name = "pro"
        print(f"[webhook] checkout.session.completed user_id={user_id} plan={plan_name}", flush=True)
        if user_id:
            _sb_admin("user_profiles", method="PATCH",
                      params={"id": f"eq.{user_id}"},
                      data={
                          "plan": plan_name,
                          "minutes_used": 0,
                          "stripe_customer_id": _g(obj, "customer"),
                          "stripe_subscription_id": _g(obj, "subscription"),
                      })
            print(f"[webhook] plan updated to {plan_name} + minutes reset for {user_id}", flush=True)
            # Notify admin: new paid subscription
            amount = (_g(obj, "amount_total") or 0) / 100
            currency = (_g(obj, "currency") or "usd").upper()
            email = _g(obj, "customer_email") or _g(obj, "customer_details") or "(unknown)"
            if hasattr(email, "get"):
                email = email.get("email", "(unknown)")
            elif isinstance(email, dict):
                email = email.get("email", "(unknown)")
            billing = _meta_get(obj, "billing") or ""
            discount = _stripe_session_discount_summary(obj)
            _notify_admin(
                f"💰 <b>New {plan_name.upper()} subscription</b>\n\n"
                f"💵 {amount:.2f} {currency}{(' ('+billing+')') if billing else ''}\n"
                f"📧 {email}\n"
                f"🆔 <code>{user_id}</code>\n"
                f"{discount}"
            )

    elif etype in ("customer.subscription.updated", "customer.subscription.deleted"):
        meta_type = _meta_get(obj, "type") or ""
        # ── Workspace Team subscription updates (seat changes, cancellations) ──
        if meta_type == "workspace_team":
            sub_id = _g(obj, "id")
            ws_rows = _sb_admin("workspaces", params={
                "stripe_subscription_id": f"eq.{sub_id}", "select": "id",
            })
            if ws_rows:
                ws_id = ws_rows[0]["id"]
                if etype == "customer.subscription.deleted":
                    _sb_admin("workspaces", method="PATCH",
                              params={"id": f"eq.{ws_id}"},
                              data={"plan": "free", "seats": 1,
                                    "stripe_subscription_id": None})
                    print(f"[webhook] team sub deleted → workspace {ws_id} downgraded to free", flush=True)
                    _notify_admin(
                        f"⚠️ <b>Team subscription cancelled</b>\n\n"
                        f"🏢 workspace: <code>{ws_id}</code>\n"
                        f"downgraded to free"
                    )
                else:
                    status = _g(obj, "status")
                    qty = 1
                    try:
                        items = _g(obj, "items")
                        data_arr = items.get("data") if isinstance(items, dict) else items.data
                        qty = (data_arr[0].get("quantity") if isinstance(data_arr[0], dict)
                               else data_arr[0].quantity)
                    except Exception:
                        pass
                    new_plan = "team" if status in ("active", "trialing") else "free"
                    _sb_admin("workspaces", method="PATCH",
                              params={"id": f"eq.{ws_id}"},
                              data={"plan": new_plan, "seats": int(qty)})
                    print(f"[webhook] team sub {etype} → workspace {ws_id} plan={new_plan} seats={qty}", flush=True)
            return jsonify({"ok": True})

        # ── Personal subscription updates ────────────────────────────
        customer_id = _g(obj, "customer")
        rows = _sb_admin("user_profiles",
                         params={"stripe_customer_id": f"eq.{customer_id}", "select": "id"})
        if rows:
            uid = rows[0]["id"]
            if etype == "customer.subscription.deleted":
                plan = "free"
            else:
                plan = "pro" if _g(obj, "status") in ("active", "trialing") else "free"
            _sb_admin("user_profiles", method="PATCH",
                      params={"id": f"eq.{uid}"}, data={"plan": plan})
            print(f"[webhook] {etype} → plan={plan} for {uid}", flush=True)
            if etype == "customer.subscription.deleted":
                _notify_admin(
                    f"⚠️ <b>Subscription cancelled</b>\n\n"
                    f"🆔 <code>{uid}</code>\n"
                    f"downgraded to free"
                )

    return jsonify({"ok": True})


@app.route("/api/title", methods=["POST"])
def title_endpoint():
    """Генерация короткого названия транскрипта через локальную LLM.

    Body (JSON):
      text:     транскрипт (склеенный или первые сегменты — что хочешь подать)
      language: "ru" | "uk" | "en" — на каком языке писать заголовок (опционально)

    Returns: {"title": "..."}
    """
    data = request.get_json(silent=True) or {}
    text = (data.get("text") or "").strip()
    if not text:
        return jsonify({"error": "text required"}), 400

    language = (data.get("language") or "").lower()
    # Autodetect: пытаемся понять язык по содержимому, чтобы LLM не сваливалась в EN
    if not language:
        language = _detect_transcript_language(text) or ""
    lang_hint = {
        "ru": "Напиши заголовок на русском.",
        "uk": "Напиши заголовок українською.",
        "en": "Write the title in English.",
        "pl": "Napisz tytuł po polsku.",
        "cs": "Napiš název v češtině.",
    }.get(language, "Write the title in the same language as the transcript.")

    # Ограничиваем контекст ~3000 символов — для заголовка достаточно
    excerpt = text[:3000]

    prompt = (
        "You generate concise, descriptive titles for meeting transcripts. "
        f"{lang_hint} "
        "The title must be 3 to 7 words, capture the main topic, "
        "no quotes, no period at the end, no labels like 'Title:'.\n\n"
        f"Transcript:\n{excerpt}\n\nTitle:"
    )

    try:
        raw = _ollama_generate(prompt, max_tokens=40, temperature=0.4)
    except requests.exceptions.ConnectionError:
        return jsonify({"error": "ollama unreachable (is it running?)"}), 503
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({"error": f"ollama failed: {e}"}), 500

    # Чистим вывод: первая строка, без кавычек/префиксов
    title = raw.split("\n")[0].strip()
    title = re.sub(r'^["\'«»\s]+|["\'«»\s.]+$', "", title)
    title = re.sub(r'^(title|заголовок|назва)\s*[:\-—]\s*', "", title, flags=re.IGNORECASE)
    # Обрезаем до 80 символов на всякий случай
    title = title[:80].strip()

    return jsonify({"title": title or None})


CHAT_SYSTEM_PROMPT = (
    "You answer questions about a meeting transcript. Be concise and factual. "
    "Cite specific speakers when relevant (e.g., 'Lisa mentioned that…'). "
    "If the answer isn't in the transcript, say so honestly — don't make things up. "
    "{lang_hint}"
)


@app.route("/api/tags", methods=["POST"])
def tags_endpoint():
    """LLM-генерация 2-4 тегов категории транскрипта.

    Body (JSON):
      segments:     [{speaker, start, end, text}]
      speakerNames: optional

    Returns: {"tags": ["sales", "pricing", "client"]}
    """
    data = request.get_json(silent=True) or {}
    segments = data.get("segments") or []
    if not segments:
        return jsonify({"error": "segments required"}), 400

    speaker_names = data.get("speakerNames") or {}
    text = _format_segments_for_llm(segments, speaker_names)[:5000]

    prompt = (
        "Categorize this meeting transcript with 2-4 short tags. "
        "Tags MUST be in English (so they're easy to filter across languages). "
        "Each tag is 1-3 words, lowercase, no quotes, no #. "
        "Examples: sales, technical, hiring, 1-on-1, client onboarding, product roadmap.\n\n"
        f"Transcript:\n{text}\n\n"
        "Reply with ONLY the tags separated by commas. No explanation."
    )

    try:
        raw = _ollama_generate(prompt, max_tokens=80, temperature=0.3)
    except requests.exceptions.ConnectionError:
        return jsonify({"error": "ollama unreachable"}), 503
    except Exception as e:
        return jsonify({"error": f"ollama failed: {e}"}), 500

    # Парсим: первая строка, разделитель — запятая. Чистим мусор.
    first_line = raw.split("\n")[0]
    tags_raw = [t.strip().lower() for t in first_line.split(",")]
    tags = []
    for t in tags_raw:
        # убираем кавычки, #, лишние пробелы
        t = re.sub(r"[#'\"`*]", "", t).strip()
        # обрезаем если длинный (>30 символов скорее ошибка LLM)
        if 1 <= len(t) <= 30 and t not in tags:
            tags.append(t)
        if len(tags) >= 4:
            break

    return jsonify({"tags": tags})


@app.route("/api/chat", methods=["POST"])
def chat_endpoint():
    """Async чат по транскрипту. LLM получает транскрипт + историю чата + новый вопрос.

    Body (JSON):
      segments:     [{speaker, start, end, text}] — обязательно
      speakerNames: {raw_label: custom_name} — опционально
      messages:     [{role: "user"|"assistant", content: "..."}] — предыдущая переписка
      question:     новый вопрос пользователя — обязательно

    Returns: {"job_id": "...", "status": "queued"}
    Poll: GET /api/jobs/<job_id> → {"status": "done", "answer": "..."}
    """
    data = request.get_json(silent=True) or {}
    segments = data.get("segments") or []
    question = (data.get("question") or "").strip()
    if not segments:
        return jsonify({"error": "segments required"}), 400
    if not question:
        return jsonify({"error": "question required"}), 400

    speaker_names = data.get("speakerNames") or {}
    messages = data.get("messages") or []
    language = (data.get("language") or "").lower()
    if not language:
        language = _detect_transcript_language(segments) or ""
    lang_hint = LANG_HINTS.get(language, "Reply in the same language as the user's question.")

    transcript = _format_segments_for_llm(segments, speaker_names)[:12000]

    # Собираем prompt: system + transcript + chat history + new question
    history_text = ""
    for m in messages[-10:]:  # последние 10 сообщений, чтобы не раздувать контекст
        role = m.get("role", "user")
        content = (m.get("content") or "").strip()
        if not content: continue
        prefix = "User" if role == "user" else "Assistant"
        history_text += f"{prefix}: {content}\n"

    prompt = (
        f"{CHAT_SYSTEM_PROMPT.format(lang_hint=lang_hint)}\n\n"
        f"Transcript:\n{transcript}\n\n"
    )
    if history_text:
        prompt += f"Previous conversation:\n{history_text}\n"
    prompt += f"User: {question}\nAssistant:"

    # Modal path: spawn LLM напрямую
    if USE_MODAL:
        try:
            call = _transcriptor.run_llm.spawn(prompt, max_tokens=500, temperature=0.4)
        except Exception as e:
            return jsonify({"error": f"modal spawn failed: {e}"}), 502
        return jsonify({"job_id": JOB_PREFIX_CHAT + call.object_id, "status": "queued"})

    # Local path: фоновый поток + Ollama
    job_id = _create_local_job("chat")

    def worker():
        try:
            _update_local_job(job_id, status="processing", progress="thinking")
            answer = _ollama_generate(prompt, max_tokens=500, temperature=0.4, timeout=120)
            _update_local_job(job_id, status="done", answer=answer.strip())
        except requests.exceptions.ConnectionError:
            _update_local_job(job_id, status="error", error="ollama unreachable")
        except Exception as e:
            _update_local_job(job_id, status="error", error=f"chat failed: {e}")

    threading.Thread(target=worker, daemon=True).start()
    return jsonify({"job_id": job_id, "status": "queued"})


@app.route("/api/generate", methods=["POST"])
def generate_endpoint():
    """Async LLM-обработка транскрипта по шаблону. Возвращает job_id для polling.

    Body (JSON):
      segments:     [{speaker, start, end, text}] — обязательно
      speakerNames: {raw_label: custom_name} — опционально
      template:     "summary" | "actions" | "sales_call" | "one_on_one" | "standup"

    Returns: {"job_id": "...", "status": "queued"}
    Poll: GET /api/jobs/<job_id> → {"status": "done", "result": "..."}
    """
    # Plan check: AI tools only for Pro+
    if SUPABASE_SERVICE_ROLE_KEY and g.user_id:
        try:
            profile = _get_user_profile(g.user_id)
            if PLAN_LIMITS.get(profile.get("plan", "free"), {}).get("ai") is False:
                return jsonify({
                    "error": "AI analysis requires Pro plan.",
                    "upgrade_required": True,
                }), 402
        except Exception as e:
            print(f"[plan check] failed: {e}")

    data = request.get_json(silent=True) or {}
    segments = data.get("segments") or []
    if not segments:
        return jsonify({"error": "segments required"}), 400

    template_name = (data.get("template") or "summary").lower()

    language = (data.get("language") or "").lower()
    if not language:
        language = _detect_transcript_language(segments) or ""

    speaker_names = data.get("speakerNames") or {}
    full_text = _format_segments_for_llm(segments, speaker_names)

    # ── Custom preset path — resolve before GENERATE_TEMPLATES check ──
    if template_name == "custom":
        preset_id = (data.get("preset_id") or "").strip()
        if not preset_id or not g.user_id:
            return jsonify({"error": "preset_id required for custom template"}), 400
        found = _load_preset_prompt(g.user_id, preset_id)
        if not found:
            return jsonify({"error": f"preset not found: {preset_id}"}), 404
        preset_name, user_prompt = found
        # Build prompt: hard-rules frame + user instructions + transcript.
        # str.replace (not .format) so user's curly braces don't throw.
        prompt = CUSTOM_PRESET_HARD_RULES.replace("{user_prompt}", user_prompt).replace(
            "<<TRANSCRIPT_TEXT>>", full_text
        )
        if USE_MODAL:
            try:
                gemini_fn = _modal.Function.from_name("transcriptor-v2", "gemini_generate")
                call = gemini_fn.spawn(prompt, max_output_tokens=6000, temperature=0.4)
            except Exception as e:
                return jsonify({"error": f"custom preset spawn failed: {e}"}), 502
            return jsonify({"job_id": JOB_PREFIX_GENERATE + call.object_id,
                            "status": "queued", "preset_name": preset_name})
        # Local fallback
        job_id = _create_local_job("custom")
        def custom_worker():
            try:
                _update_local_job(job_id, status="processing", progress="generating")
                result = _ollama_generate(prompt, max_tokens=2000, temperature=0.4, timeout=300)
                _update_local_job(job_id, status="done", result=result.strip())
            except Exception as e:
                _update_local_job(job_id, status="error", error=f"custom failed: {e}")
        threading.Thread(target=custom_worker, daemon=True).start()
        return jsonify({"job_id": job_id, "status": "queued", "preset_name": preset_name})

    if template_name not in GENERATE_TEMPLATES:
        return jsonify({"error": f"unknown template: {template_name}",
                        "available": sorted(GENERATE_TEMPLATES.keys())}), 400

    lang_hint = LANG_HINTS.get(language, LANG_HINT_DEFAULT)

    # Resolve Privacy Mode — when ON, route summary/actions through
    # self-hosted LabGPTOSS20B instead of Gemini Pro.
    privacy_mode = False
    if SUPABASE_SERVICE_ROLE_KEY and g.user_id and template_name in GEMINI_TEMPLATES:
        try:
            profile = _get_user_profile(g.user_id)
            eff_plan = _get_effective_plan(g.user_id, g.user_email, profile)
            privacy_mode = _privacy_mode_active(profile, eff_plan)
        except Exception as e:
            print(f"[privacy] generate resolve failed: {e}")

    use_gemini = USE_MODAL and template_name in GEMINI_TEMPLATES and not privacy_mode

    # Gemini 2.5 Pro: контекст 2M токенов, влезает любой созвон без обрезки.
    # Privacy (gpt-oss-20b): полный текст уходит в map-reduce (см. ниже).
    # Qwen 7B (legacy fallback) — режем до 12k символов, иначе деградирует.
    text = full_text if use_gemini else full_text[:12000]
    # Детальность вывода + фокус (опционально, дефолт = базовое поведение)
    extras = _build_generate_extras(data.get("detail"), data.get("focus") or "")

    # Privacy Mode path: self-hosted gpt-oss-20b on Modal L40S, no Gemini API
    # call. Текст не вшивается в один промпт — generate_mapreduce сам режет
    # длинный транскрипт на окна (eager attention OOM'ится на длинном
    # контексте, ISS-1); короткий идёт одним вызовом как раньше.
    if privacy_mode:
        reduce_prompt = GENERATE_TEMPLATES[template_name].format(
            text=PRIVACY_TEXT_SLOT, lang_hint=lang_hint, **extras)
        map_prompt = PRIVACY_MAP_PROMPT.format(lang_hint=lang_hint)
        try:
            cls = _modal.Cls.from_name("transcriptor-v2", "LabGPTOSS20B")
            inst = cls()
            call = inst.generate_mapreduce.spawn(
                full_text, reduce_prompt, map_prompt, 4096, 0.3)
        except Exception as e:
            return jsonify({"error": f"privacy generate spawn failed: {e}"}), 502
        return jsonify({"job_id": JOB_PREFIX_GENERATE + call.object_id,
                        "status": "queued", "privacy_mode": True})

    prompt = GENERATE_TEMPLATES[template_name].format(text=text, lang_hint=lang_hint, **extras)

    # Gemini-путь для summary/actions: внешний LLM, отдельная Modal функция.
    if use_gemini:
        try:
            gemini_fn = _modal.Function.from_name("transcriptor-v2", "gemini_generate")
            call = gemini_fn.spawn(prompt, max_output_tokens=8000, temperature=0.3)
        except Exception as e:
            return jsonify({"error": f"gemini spawn failed: {e}"}), 502
        return jsonify({"job_id": JOB_PREFIX_GENERATE + call.object_id, "status": "queued"})

    # Modal path с Qwen: для шаблонов вне GEMINI_TEMPLATES (сейчас не используется,
    # но оставлено на случай возврата лёгких шаблонов).
    if USE_MODAL:
        try:
            call = _transcriptor.run_llm.spawn(prompt, max_tokens=800, temperature=0.5)
        except Exception as e:
            return jsonify({"error": f"modal spawn failed: {e}"}), 502
        return jsonify({"job_id": JOB_PREFIX_GENERATE + call.object_id, "status": "queued"})

    # Local path: фоновый поток + Ollama
    job_id = _create_local_job(f"generate:{template_name}")

    def worker():
        try:
            _update_local_job(job_id, status="processing", progress="generating")
            result = _ollama_generate(prompt, max_tokens=2000, temperature=0.3, timeout=300)
            _update_local_job(job_id, status="done", result=result.strip())
        except requests.exceptions.ConnectionError:
            _update_local_job(job_id, status="error", error="ollama unreachable (is it running?)")
        except Exception as e:
            _update_local_job(job_id, status="error", error=f"ollama failed: {e}")

    threading.Thread(target=worker, daemon=True).start()
    return jsonify({"job_id": job_id, "status": "queued"})


# ── Lab: model comparison harness ──────────────────────────────
# Admin-only. Runs the same prompt through multiple LLMs in parallel,
# returns side-by-side results so we can pick the best candidate for
# Privacy Mode (Max + Team feature replacing Gemini with self-hosted).

# mamaylm (LabMamayLM9B) удалён из деплоя 2026-06-10 — сравнение завершено,
# для Privacy Mode выбран gpt-oss-20b. Вернуть: git history (modal_app.py).
LAB_MODELS = {
    "gemini":    {"label": "Gemini 2.5 Pro",                "modal_fn": ("gemini_generate", None)},
    "gptoss20b": {"label": "gpt-oss-20b (L40S MXFP4)",      "modal_fn": ("LabGPTOSS20B",  "generate")},
}


@app.route("/api/lab/compare", methods=["POST"])
def lab_compare():
    """Spawn N model calls in parallel. Returns job_ids (one per model)
    that the frontend polls via the existing /api/jobs/<id> endpoint.
    Async — avoids HTTP gateway timeouts on slow cold starts (Modal HTTP
    proxy drops connections after ~5 min of no response data).

    Body (JSON):
      transcript_id: uuid of an existing transcript in the calling user's history
      task:          'summary' | 'actions' (any key in GENERATE_TEMPLATES)
      models:        list of LAB_MODELS keys to compare

    Result: {job_ids: {model_key: 'g_<call_id>'|None}, errors: {model_key: msg}}
    """
    if not _is_admin():
        return jsonify({"error": "admin only"}), 403
    if not USE_MODAL:
        return jsonify({"error": "lab requires USE_MODAL=true"}), 503

    data = request.get_json(silent=True) or {}
    transcript_id = (data.get("transcript_id") or "").strip()
    task = (data.get("task") or "summary").lower()
    models = data.get("models") or []
    if not transcript_id or task not in GENERATE_TEMPLATES or not models:
        return jsonify({"error": "transcript_id, task in GENERATE_TEMPLATES, and models[] required"}), 400
    unknown = [m for m in models if m not in LAB_MODELS]
    if unknown:
        return jsonify({"error": f"unknown models: {unknown}", "available": list(LAB_MODELS.keys())}), 400

    # Fetch transcript (service role bypasses RLS — but check ownership ourselves)
    try:
        rows = _sb_admin("transcripts",
                         params={"id": f"eq.{transcript_id}",
                                 "select": "user_id,segments,speaker_names,language"})
    except Exception as e:
        return jsonify({"error": f"transcript fetch failed: {e}"}), 500
    if not rows:
        return jsonify({"error": "transcript not found"}), 404
    t = rows[0]
    if t.get("user_id") != g.user_id:
        return jsonify({"error": "not your transcript"}), 403

    segments = t.get("segments") or []
    speaker_names = t.get("speaker_names") or {}
    language = (t.get("language") or "").lower()

    # Build the EXACT prompt production would build (same _format_segments_for_llm,
    # same GENERATE_TEMPLATES) so the comparison is honest.
    full_text = _format_segments_for_llm(segments, speaker_names)
    if not language:
        language = _detect_transcript_language(segments) or ""
    lang_hint = LANG_HINTS.get(language, LANG_HINT_DEFAULT)
    text = full_text[:200000]   # defensive cap, all 3 models have ≥32K context
    prompt = GENERATE_TEMPLATES[task].format(text=text, lang_hint=lang_hint,
                                             **_build_generate_extras("medium", ""))

    job_ids = {}
    errors = {}

    for key in models:
        cfg = LAB_MODELS[key]
        cls_or_fn, method = cfg["modal_fn"]
        try:
            if method is None:
                fn = _modal.Function.from_name("transcriptor-v2", cls_or_fn)
                call = fn.spawn(prompt, max_output_tokens=8000, temperature=0.3)
            else:
                cls = _modal.Cls.from_name("transcriptor-v2", cls_or_fn)
                inst = cls()
                bound = getattr(inst, method)
                call = bound.spawn(prompt, 4096, 0.3)
            # Re-use 'g_' prefix so existing /api/jobs/<id> handler treats
            # these as generate-style jobs (result = plain string).
            job_ids[key] = JOB_PREFIX_GENERATE + call.object_id
        except Exception as e:
            errors[key] = f"spawn failed: {e}"

    return jsonify({
        "ok": True,
        "task": task,
        "language": language,
        "transcript_id": transcript_id,
        "segments_count": len(segments),
        "input_chars": len(text),
        "job_ids": job_ids,
        "errors": errors,
    })


@app.route("/api/admin/recordings", methods=["GET"])
def admin_recordings():
    """Admin: archived recordings (newest first) with their capture telemetry."""
    if not _is_admin():
        return jsonify({"error": "admin only"}), 403
    rows = _sb_admin("recordings", params={
        "select": "id,user_id,user_email,source,duration_sec,language,num_speakers,quality,"
                  "size_bytes,content_type,created_at,completed_at,error",
        "expires_at": f"gt.{datetime.utcnow().isoformat()}Z",
        "order": "created_at.desc",
        "limit": "100",
    })
    if rows:
        ids = ",".join(r["id"] for r in rows)
        stats = {s["recording_id"]: s for s in _sb_admin("capture_stats", params={"recording_id": f"in.({ids})"})}
        for r in rows:
            r["capture"] = stats.get(r["id"])
    return jsonify({"recordings": rows})


def _admin_recording_row(rid: str) -> dict | None:
    try:
        rid = str(uuid.UUID(rid))
    except ValueError:
        return None
    rows = _sb_admin("recordings", params={"id": f"eq.{rid}", "select": "*"})
    return rows[0] if rows else None


@app.route("/api/admin/recordings/<rid>", methods=["GET"])
def admin_recording_detail(rid):
    """Admin: one recording — raw pipeline segments, error, capture telemetry."""
    if not _is_admin():
        return jsonify({"error": "admin only"}), 403
    rec = _admin_recording_row(rid)
    if not rec:
        return jsonify({"error": "not found"}), 404
    stats = _sb_admin("capture_stats", params={"recording_id": f"eq.{rec['id']}"})
    rec["capture"] = stats[0] if stats else None
    return jsonify(rec)


@app.route("/api/admin/recordings/<rid>/audio", methods=["GET"])
def admin_recording_audio(rid):
    """Admin: stream the archived audio from R2 (proxied — no bucket CORS needed)."""
    if not _is_admin():
        return jsonify({"error": "admin only"}), 403
    rec = _admin_recording_row(rid)
    if not rec:
        return jsonify({"error": "not found"}), 404
    try:
        obj = _r2().get_object(Bucket=R2_BUCKET, Key=rec["storage_key"])
    except Exception as e:
        return jsonify({"error": f"audio unavailable: {e}"}), 404
    return Response(
        obj["Body"].iter_chunks(1 << 20),
        mimetype=rec.get("content_type") or "application/octet-stream",
        headers={"Content-Length": str(obj["ContentLength"])},
    )


@app.route("/api/lab/info", methods=["GET"])
def lab_info():
    """Admin discovery — returns available models + GENERATE_TEMPLATES keys
    so the frontend can build the UI without hardcoding the list."""
    if not _is_admin():
        return jsonify({"error": "admin only"}), 403
    return jsonify({
        "models": [{"key": k, "label": v["label"]} for k, v in LAB_MODELS.items()],
        "tasks":  sorted(GENERATE_TEMPLATES.keys()),
    })


@app.route("/api/transcribe-chunk", methods=["POST"])
def transcribe_chunk_endpoint():
    """Быстрая транскрипция чанка во время записи — только whisper, без диаризации.
    Используется фронтом для live-текста по ходу созвона.
    Returns: {"text": "..."}
    """
    audio_file = request.files.get("audio")
    if not audio_file:
        return jsonify({"error": "audio file required"}), 400

    language = request.form.get("language") or None
    if language and language not in ALLOWED_LANGUAGES:
        return jsonify({"error": f"language must be one of {sorted(ALLOWED_LANGUAGES)}"}), 400

    prompt = request.form.get("prompt") or None

    filename = datetime.now().strftime("%Y%m%d-%H%M%S-%f") + ".webm"
    webm_path = os.path.join(RECORDINGS_DIR, filename)
    audio_file.save(webm_path)

    wav_path = None
    try:
        wav_path = _webm_to_wav(webm_path)
        segments = transcribe(wav_path, language=language, prompt=prompt)
        text = " ".join(s["text"] for s in segments).strip()
        return jsonify({"text": text})
    except Exception as e:
        return jsonify({"error": f"chunk transcription failed: {e}"}), 500
    finally:
        for p in (webm_path, wav_path):
            if p:
                try: os.remove(p)
                except OSError: pass


@app.route("/api/transcribe", methods=["POST"])
def transcribe_endpoint():
    """Async-транскрипция с диаризацией. Возвращает job_id для polling.

    Form fields:
      audio:        файл (WebM/Opus, WAV, MP3 — любой что понимает ffmpeg)
      language:     "ru" | "uk" | "en" | пусто (auto)
      prompt:       контекст для Whisper (опционально)
      num_speakers: точное число спикеров (опционально, улучшает качество диаризации)

    Returns: {"job_id": "...", "status": "queued"}
    Poll: GET /api/jobs/<job_id>
      → {"status": "processing", "progress": "transcribing"}  (промежуточное)
      → {"status": "done", "segments": [...]}                 (финал)
      → {"status": "error", "error": "..."}                   (ошибка)
    """
    storage_url = request.form.get("storage_url", "").strip()
    audio_file = request.files.get("audio")

    if not storage_url and not audio_file:
        return jsonify({"error": "audio or storage_url required"}), 400

    language = request.form.get("language") or None
    if language and language not in ALLOWED_LANGUAGES:
        return jsonify({"error": f"language must be one of {sorted(ALLOWED_LANGUAGES)}"}), 400

    prompt = request.form.get("prompt") or None
    num_speakers_raw = request.form.get("num_speakers")
    num_speakers = int(num_speakers_raw) if num_speakers_raw and num_speakers_raw.isdigit() else None
    quality = (request.form.get("quality") or "fast").lower()
    if quality not in ("fast", "best"):
        quality = "fast"

    # Длительность записи (сек) от фронта — для роутинга в long-pipeline.
    # Фоллбэк на оценку по размеру блоба если фронт не прислал.
    duration_sec_raw = request.form.get("duration_sec")
    try:
        duration_sec = float(duration_sec_raw) if duration_sec_raw else 0.0
    except ValueError:
        duration_sec = 0.0

    # Archive linkage: the client's recording_id ties this audio to its capture_stats.
    try:
        recording_id = str(uuid.UUID(request.form.get("recording_id") or ""))
    except ValueError:
        recording_id = str(uuid.uuid4())
    source = request.form.get("source") if request.form.get("source") in ("record", "upload") else "upload"

    # Plan limits check + best-quality gating + vocabulary fetch
    user_vocab_prompt = ""
    correction_hints = ""  # пары wrong→right для Gemini correction
    if SUPABASE_SERVICE_ROLE_KEY and g.user_id:
        try:
            profile = _get_user_profile(g.user_id)
            plan = _get_effective_plan(g.user_id, g.user_email, profile)
            limits = PLAN_LIMITS.get(plan, PLAN_LIMITS["free"])
            effective_limit = limits["minutes"] + int(profile.get("bonus_minutes") or 0)
            if profile.get("minutes_used", 0) >= effective_limit:
                return jsonify({
                    "error": f"Monthly limit reached ({effective_limit} min). Upgrade to continue.",
                    "upgrade_required": True,
                }), 402
            if not limits["diarization"]:
                num_speakers = 1  # Free: транскрипция без разделения по спикерам
            # Best Quality (large-v3) — только для Max плана. Effective Team plan
            # ≠ Max, but personal Max subscription always overrides.
            own_plan = profile.get("plan", "free")
            if quality == "best" and plan != "max" and own_plan != "max":
                quality = "fast"
            # Personal vocabulary — у всех залогиненных юзеров.
            # Правые формы → в Whisper prompt; пары wrong→right → в Gemini hints.
            vocab_items = profile.get("vocabulary") or []
            if isinstance(vocab_items, list) and vocab_items:
                user_vocab_prompt = _build_vocab_prompt(vocab_items)
                correction_hints = _build_correction_hints(vocab_items)
        except Exception as e:
            print(f"[limits] check failed: {e}")

    if language in FORCE_BEST_QUALITY_LANGUAGES:
        quality = "best"

    # Подмешиваем персональный словарь к пользовательскому prompt
    if user_vocab_prompt:
        prompt = f"{user_vocab_prompt} {prompt}" if prompt else user_vocab_prompt

    # ── Modal path: spawn() возвращает FunctionCall сразу, обработка идёт в облаке
    if USE_MODAL:
        # Зомби-защита: если у юзера уже есть активная транскрипция (быстрый
        # рестарт / не дождался отмены) — принудительно гасим её ПЕРЕД новым
        # spawn'ом, чтобы не копить параллельные контейнеры в очереди Modal.
        if g.user_id:
            prev_job = _user_active_job.get(g.user_id)
            if prev_job:
                print(f"[transcribe] terminating user's previous job {prev_job}", flush=True)
                _terminate_modal_job(prev_job)

        # Storage-URL path: download bytes from Supabase Storage signed URL.
        # Used for large files (>200MB) that exceed Modal's ~250MB request body limit.
        if storage_url:
            try:
                dl = requests.get(storage_url, timeout=300, stream=False)
                dl.raise_for_status()
                audio_bytes = dl.content
                audio_ctype = dl.headers.get("Content-Type", "")
            except Exception as e:
                return jsonify({"error": f"storage download failed: {e}"}), 502
        else:
            audio_bytes = audio_file.read()
            audio_ctype = audio_file.mimetype or ""
        progress_key = uuid.uuid4().hex  # уникальный ключ для modal.Dict прогресса
        # Resolve Privacy Mode for this user — if on, Modal will skip Gemini
        # correction entirely (falls back to local Qwen on the same GPU)
        privacy_mode = False
        try:
            if g.user_id and SUPABASE_SERVICE_ROLE_KEY:
                profile = _get_user_profile(g.user_id)
                eff_plan = _get_effective_plan(g.user_id, g.user_email, profile)
                privacy_mode = _privacy_mode_active(profile, eff_plan)
        except Exception as e:
            print(f"[privacy] resolve failed: {e}")

        # Роутинг по длительности: длинные записи (> LONG_AUDIO_THRESHOLD_S)
        # идут в chunked-оркестратор transcribe_long (режет на ~20-мин куски,
        # обрабатывает параллельно, глобально сшивает спикеров). Короткие —
        # в монолитный transcribe_full как раньше. Фоллбэк на оценку
        # длительности по размеру блоба если фронт не прислал duration_sec.
        est_duration = duration_sec or (len(audio_bytes) * 8 / 32000)
        use_long = est_duration > LONG_AUDIO_THRESHOLD_S
        try:
            if use_long:
                long_fn = _modal.Function.from_name("transcriptor-v2", "transcribe_long")
                call = long_fn.spawn(
                    audio_bytes, language, num_speakers, prompt, progress_key, quality, privacy_mode, correction_hints,
                )
                print(f"[transcribe] long-pipeline: ~{est_duration:.0f}s")
            else:
                call = _transcriptor.transcribe_full.spawn(
                    audio_bytes, language, num_speakers, prompt, progress_key, quality, privacy_mode, correction_hints,
                )
        except Exception as e:
            return jsonify({"error": f"modal spawn failed: {e}"}), 502
        job_id = JOB_PREFIX_TRANSCRIBE + call.object_id
        _job_progress_keys[job_id] = progress_key  # сохраняем для polling
        # сохраняем язык и user_id для последующего vocab save (см. /api/jobs polling)
        _job_language[job_id] = language
        if g.user_id:
            _job_user[job_id] = g.user_id
            _user_active_job[g.user_id] = job_id  # отметка активной джобы (zombie-guard)
        if R2_BUCKET and g.user_id and not privacy_mode:
            threading.Thread(target=_archive_recording, daemon=True, args=(audio_bytes, audio_ctype), kwargs=dict(
                recording_id=recording_id, user_id=g.user_id, user_email=g.user_email, job_id=job_id,
                source=source, duration_sec=duration_sec, language=language,
                num_speakers=num_speakers, quality=quality,
            )).start()
        return jsonify({"job_id": job_id, "status": "queued", "recording_id": recording_id})

    # ── Local path: пишем на диск, обрабатываем в фоновом потоке
    filename = datetime.now().strftime("%Y%m%d-%H%M%S-%f") + ".webm"
    webm_path = os.path.join(RECORDINGS_DIR, filename)
    if storage_url:
        try:
            dl = requests.get(storage_url, timeout=300, stream=False)
            dl.raise_for_status()
            with open(webm_path, "wb") as _f:
                _f.write(dl.content)
        except Exception as e:
            return jsonify({"error": f"storage download failed: {e}"}), 502
    else:
        audio_file.save(webm_path)

    job_id = _create_local_job("transcribe")

    def worker():
        wav_path = None
        try:
            _update_local_job(job_id, status="processing", progress="converting")
            wav_path = _webm_to_wav(webm_path)

            _update_local_job(job_id, progress="transcribing")
            segments = transcribe(wav_path, language=language, prompt=prompt)

            if not segments:
                _update_local_job(job_id, status="done", segments=[])
                return

            _update_local_job(job_id, progress="diarizing")
            speaker_turns = diarize(wav_path, num_speakers=num_speakers)

            _update_local_job(job_id, progress="merging")
            merged = merge(segments, speaker_turns)

            _update_local_job(job_id, progress="correcting")
            merged = _llm_correct_segments(merged, language)

            _update_local_job(job_id, status="done", segments=merged)

        except Exception as e:
            _update_local_job(job_id, status="error", error=f"processing failed: {e}")
        finally:
            for p in (webm_path, wav_path):
                if p:
                    try:
                        os.remove(p)
                    except OSError:
                        pass

    threading.Thread(target=worker, daemon=True).start()
    return jsonify({"job_id": job_id, "status": "queued"})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False)
