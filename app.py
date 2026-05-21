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
import uuid
from datetime import datetime, timedelta

import jwt as pyjwt
import requests
from flask import Flask, render_template, jsonify, request, g
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
        return {"status": "processing"}
    except _modal.exception.OutputExpiredError:
        return {"status": "error", "error": "result expired"}
    except Exception as e:
        return {"status": "error", "error": str(e)}

    # Возвращаем правильное поле в зависимости от типа задачи
    if kind == "transcribe":
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
}
LANG_HINT_DEFAULT = "Write the entire response in the same language as the transcript."


def _detect_transcript_language(segments_or_text) -> str | None:
    """Эвристика по содержимому: 'uk' / 'ru' / 'en' / None.

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

    if cyrillic == 0 and latin == 0:
        return None
    if cyrillic > latin:
        return 'uk' if uk_specific > 0 else 'ru'
    return 'en'

GENERATE_TEMPLATES = {
    "summary": (
        "You are a senior analyst writing a detailed written report on a meeting "
        "for someone who did not attend but needs to understand what happened "
        "deeply enough to act on it. This is NOT a TL;DR — it is a thorough "
        "analytical document.\n\n"
        "{lang_hint} Preserve speaker names exactly as given in the transcript "
        "(e.g. [Eli], [Speaker 1]). Write in clean markdown.\n\n"
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
        "important position especially well.\n\n"
        "==== ADAPTIVE STRUCTURE ====\n"
        "Choose 4-8 of the following sections — only the ones relevant to THIS "
        "meeting. Do not force sections that don't apply. Do not invent "
        "sections beyond this list. Order them to tell the story of the "
        "meeting clearly.\n\n"
        "- **Контекст / Context** (always include): 1-3 sentences — what kind "
        "of meeting, who participated, what was the purpose.\n"
        "- **Основні теми обговорення / Main topics**: narrative paragraphs "
        "(not just bullets) covering what was actually discussed and what came "
        "out of each topic.\n"
        "- **Позиції сторін / Positions of the parties**: include when "
        "different participants had distinct views. Give each side its own "
        "sub-section with their reasoning.\n"
        "- **Виявлені проблеми / Problems identified**: concrete issues that "
        "surfaced, with enough detail that the reader understands the root "
        "cause, not just the symptom.\n"
        "- **Рішення та домовленості / Decisions and agreements**: ONLY things "
        "explicitly agreed in the meeting. If none, omit this section.\n"
        "- **Ідеї та пропозиції / Ideas and proposals**: suggestions that were "
        "raised but not formally agreed. Attribute to whoever proposed them.\n"
        "- **Що можна покращити / What can be improved**: include only if the "
        "meeting itself surfaced recommendations for improvement (e.g. process "
        "feedback, retrospective points).\n"
        "- **Відкриті питання / Open questions**: things left unresolved that "
        "need follow-up.\n"
        "- **Подальші кроки та статус / Next steps and status**: concrete next "
        "actions and overall status (e.g. 'project continues', 'cooperation "
        "ends', 'follow-up meeting scheduled').\n\n"
        "==== DEPTH ====\n"
        "Target length scales with transcript length:\n"
        "- Short meeting (<15 min): 300-600 words.\n"
        "- Medium meeting (15-45 min): 700-1500 words.\n"
        "- Long meeting (>45 min): 1500-3000 words.\n"
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
        "2) `## Рекомендації / Recommendations` — IDEAS, SUGGESTIONS, AND "
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
        "review meetings) → include only `## Рекомендації / Recommendations`.\n"
        "- If neither — the transcript genuinely has no actionable content "
        "of either kind — reply with a single line in the target language, "
        "e.g. 'Конкретних action items та рекомендацій не зафіксовано.' / "
        "'No actionable takeaways were identified.'\n\n"
        "==== HARD RULES ====\n"
        "- Use ONLY content actually present in the transcript. Do not invent "
        "actions, recommendations, owners, or deadlines.\n"
        "- Do not duplicate the same item across both sections.\n"
        "- Things that already happened do not belong in either section.\n\n"
        "==== TRANSCRIPT ====\n"
        "{text}"
    ),
}

# Шаблоны которые идут через Gemini 2.5 Pro (для качества аналитики).
# Остальные (если появятся в будущем) — через локальный Qwen.
GEMINI_TEMPLATES = {"summary", "actions"}


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

ALLOWED_LANGUAGES = {"ru", "uk", "en"}


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

STRIPE_PRICE_MAP = {
    ("pro",  "monthly"): lambda: STRIPE_PRO_MONTHLY_PRICE,
    ("pro",  "annual"):  lambda: STRIPE_PRO_ANNUAL_PRICE,
    ("max",  "monthly"): lambda: STRIPE_MAX_MONTHLY_PRICE,
    ("max",  "annual"):  lambda: STRIPE_MAX_ANNUAL_PRICE,
}

PLAN_LIMITS = {
    "free": {"minutes": 60,   "diarization": False, "ai": False, "history": 5},
    "pro":  {"minutes": 600,  "diarization": True,  "ai": True,  "history": None},
    "max":  {"minutes": 2000, "diarization": True,  "ai": True,  "history": None},
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
        return profile
    # Создаём профиль если не существует
    rows = _sb_admin("user_profiles", method="POST", data={"id": user_id})
    return rows[0] if rows else {"plan": "free", "minutes_used": 0}


def _add_minutes(user_id: str, minutes: float):
    """Добавляет минуты через Postgres RPC (атомарно, без race condition)."""
    _sb_admin("rpc/add_minutes", method="POST",
              data={"user_id": user_id, "mins": max(1, int(minutes + 0.5))})

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
_PUBLIC_API_PATHS = {"/api/health", "/api/stripe/webhook"}


@app.before_request
def _require_jwt():
    """Гард: все /api/* кроме PUBLIC требуют валидный Supabase JWT."""
    # CORS preflight всегда пропускаем
    if request.method == "OPTIONS":
        return None

    path = request.path
    if not path.startswith("/api/") or path in _PUBLIC_API_PATHS:
        return None

    # Если SUPABASE_URL не задан — считаем что auth не настроен (локальная разработка).
    # На Modal должен быть выставлен через Secret.
    jwks_client = _get_jwks_client()
    if jwks_client is None:
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
    """Отдаём фронт с этого же сервера — удобно для dev.
    Когда фронт переедет на Vercel, этот роут можно удалить.
    """
    return render_template("index.html")


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
        return jsonify(result)

    # Local: обычный uuid hex
    _cleanup_local_jobs()
    job = _get_local_job(job_id)
    if not job:
        return jsonify({"error": "job not found or expired"}), 404
    return jsonify({k: v for k, v in job.items() if not isinstance(v, datetime)})


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
        return jsonify({"plan": "free", "minutes_used": 0, "minutes_limit": 60})
    try:
        profile = _get_user_profile(g.user_id)
        plan = profile.get("plan", "free")
        limits = PLAN_LIMITS.get(plan, PLAN_LIMITS["free"])
        return jsonify({
            "plan": plan,
            "minutes_used": profile.get("minutes_used", 0),
            "minutes_limit": limits["minutes"],
        })
    except Exception as e:
        print(f"[profile] error: {e}")
        return jsonify({"plan": "free", "minutes_used": 0, "minutes_limit": 60})


@app.route("/api/stripe/checkout", methods=["POST"])
def stripe_checkout():
    """Создаёт Stripe Checkout Session и возвращает URL для редиректа."""
    import stripe as _stripe
    _stripe.api_key = STRIPE_SECRET_KEY
    if not STRIPE_SECRET_KEY:
        return jsonify({"error": "Stripe not configured"}), 503

    data = request.get_json() or {}
    plan    = data.get("plan", "pro").lower()
    billing = data.get("billing", "monthly").lower()
    if plan not in ("pro", "max"):
        plan = "pro"

    price_id = data.get("price_id") or (STRIPE_PRICE_MAP.get((plan, billing), lambda: "")() )
    if not price_id:
        return jsonify({"error": f"price_id for {plan}/{billing} not configured in secrets"}), 400

    origin = request.headers.get("Origin", "https://skriptly.io")
    base = origin + "/app"
    try:
        session = _stripe.checkout.Session.create(
            mode="subscription",
            payment_method_types=["card"],
            line_items=[{"price": price_id, "quantity": 1}],
            success_url=base + "?checkout=success",
            cancel_url=base + "?checkout=cancelled",
            client_reference_id=g.user_id,
            customer_email=g.user_email or "",
            metadata={"plan": plan, "user_id": g.user_id or ""},
        )
        return jsonify({"url": session.url})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


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

    if etype == "checkout.session.completed":
        user_id = _g(obj, "client_reference_id")
        # Read plan from metadata (set at checkout creation), default pro
        meta = _g(obj, "metadata") or {}
        plan_name = (meta.get("plan") if isinstance(meta, dict) else getattr(meta, "plan", "pro")) or "pro"
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

    elif etype in ("customer.subscription.updated", "customer.subscription.deleted"):
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
    if template_name not in GENERATE_TEMPLATES:
        return jsonify({"error": f"unknown template: {template_name}",
                        "available": sorted(GENERATE_TEMPLATES.keys())}), 400

    language = (data.get("language") or "").lower()
    if not language:
        language = _detect_transcript_language(segments) or ""
    lang_hint = LANG_HINTS.get(language, LANG_HINT_DEFAULT)

    speaker_names = data.get("speakerNames") or {}
    full_text = _format_segments_for_llm(segments, speaker_names)

    use_gemini = USE_MODAL and template_name in GEMINI_TEMPLATES

    # Gemini 2.5 Pro: контекст 2M токенов, влезает любой созвон без обрезки.
    # Qwen 7B на A10G и локальный Ollama — режем до 12k символов, иначе деградирует.
    text = full_text if use_gemini else full_text[:12000]
    prompt = GENERATE_TEMPLATES[template_name].format(text=text, lang_hint=lang_hint)

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
    audio_file = request.files.get("audio")
    if not audio_file:
        return jsonify({"error": "audio file required"}), 400

    language = request.form.get("language") or None
    if language and language not in ALLOWED_LANGUAGES:
        return jsonify({"error": f"language must be one of {sorted(ALLOWED_LANGUAGES)}"}), 400

    prompt = request.form.get("prompt") or None
    num_speakers_raw = request.form.get("num_speakers")
    num_speakers = int(num_speakers_raw) if num_speakers_raw and num_speakers_raw.isdigit() else None

    # Plan limits check
    if SUPABASE_SERVICE_ROLE_KEY and g.user_id:
        try:
            profile = _get_user_profile(g.user_id)
            plan = profile.get("plan", "free")
            limits = PLAN_LIMITS.get(plan, PLAN_LIMITS["free"])
            if profile.get("minutes_used", 0) >= limits["minutes"]:
                return jsonify({
                    "error": f"Monthly limit reached ({limits['minutes']} min). Upgrade to continue.",
                    "upgrade_required": True,
                }), 402
            if not limits["diarization"]:
                num_speakers = 1  # Free: транскрипция без разделения по спикерам
        except Exception as e:
            print(f"[limits] check failed: {e}")

    # ── Modal path: spawn() возвращает FunctionCall сразу, обработка идёт в облаке
    if USE_MODAL:
        audio_bytes = audio_file.read()
        try:
            call = _transcriptor.transcribe_full.spawn(
                audio_bytes, language, num_speakers, prompt
            )
        except Exception as e:
            return jsonify({"error": f"modal spawn failed: {e}"}), 502
        return jsonify({"job_id": JOB_PREFIX_TRANSCRIBE + call.object_id, "status": "queued"})

    # ── Local path: пишем на диск, обрабатываем в фоновом потоке
    filename = datetime.now().strftime("%Y%m%d-%H%M%S-%f") + ".webm"
    webm_path = os.path.join(RECORDINGS_DIR, filename)
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
