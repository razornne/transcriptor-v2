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

GENERATE_TEMPLATES = {
    "summary": (
        "You are summarizing a meeting transcript. {lang_hint} "
        "Be factual and concise. Write in markdown.\n\n"
        "Structure:\n"
        "- A 1-2 sentence topic at the very top (no heading).\n"
        "- `## Key points` — 3-7 bullet points.\n"
        "- `## Decisions` — bullet list, or 'No explicit decisions.' if none.\n\n"
        "Transcript:\n{text}"
    ),
    "actions": (
        "Extract action items from this meeting transcript. {lang_hint} "
        "Use markdown checklist format:\n\n"
        "- [ ] Task description — @speaker (if mentioned) — by date (if mentioned)\n\n"
        "Only list items where someone clearly committed to doing something. "
        "If no clear actions, reply with a single line: 'No action items identified.'\n\n"
        "Transcript:\n{text}"
    ),
    "sales_call": (
        "This is a sales call transcript. {lang_hint} "
        "Write a structured report in markdown:\n\n"
        "## Client\nBrief description of the prospect.\n\n"
        "## Pain points\nBullet list of stated pain points or challenges.\n\n"
        "## Solution discussed\nWhat was proposed.\n\n"
        "## Objections\nAny hesitations or concerns raised.\n\n"
        "## Next steps\n- [ ] Concrete next action — @owner — by date\n\n"
        "Transcript:\n{text}"
    ),
    "one_on_one": (
        "This is a 1-on-1 meeting transcript. {lang_hint} "
        "Write structured notes in markdown:\n\n"
        "## What's going well\nBullet list.\n\n"
        "## Concerns / blockers\nBullet list.\n\n"
        "## Feedback exchanged\nBrief summary.\n\n"
        "## Action items\n- [ ] item — @owner\n\n"
        "Transcript:\n{text}"
    ),
    "standup": (
        "This is a daily stand-up transcript. {lang_hint} "
        "For each speaker who participated, write a section in markdown:\n\n"
        "### @SpeakerName\n"
        "- **Yesterday:** what they did\n"
        "- **Today:** what they plan\n"
        "- **Blockers:** what's blocking them (or 'none')\n\n"
        "Skip speakers who didn't give an update.\n\n"
        "Transcript:\n{text}"
    ),
}


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
# JWT подписан HS256 + SUPABASE_JWT_SECRET (Settings → API → JWT Secret
# в Supabase Dashboard).
SUPABASE_JWT_SECRET = os.environ.get("SUPABASE_JWT_SECRET", "")

# Эндпоинты которые работают без auth (служебные, открытые)
_PUBLIC_API_PATHS = {"/api/health"}


@app.before_request
def _require_jwt():
    """Гард: все /api/* кроме PUBLIC требуют валидный Supabase JWT."""
    # CORS preflight всегда пропускаем
    if request.method == "OPTIONS":
        return None

    path = request.path
    if not path.startswith("/api/") or path in _PUBLIC_API_PATHS:
        return None

    # Если секрет не задан — считаем что auth не настроен (для локальной разработки).
    # На Modal он должен быть выставлен через Secret.
    if not SUPABASE_JWT_SECRET:
        return None

    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        return jsonify({"error": "missing token"}), 401

    token = auth_header[7:].strip()
    try:
        payload = pyjwt.decode(
            token,
            SUPABASE_JWT_SECRET,
            algorithms=["HS256"],
            audience="authenticated",
        )
    except pyjwt.ExpiredSignatureError:
        return jsonify({"error": "token expired"}), 401
    except pyjwt.InvalidTokenError as e:
        return jsonify({"error": f"invalid token: {e}"}), 401

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
        return jsonify(_modal_job_status(job_id))

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
    data = request.get_json(silent=True) or {}
    segments = data.get("segments") or []
    if not segments:
        return jsonify({"error": "segments required"}), 400

    template_name = (data.get("template") or "summary").lower()
    if template_name not in GENERATE_TEMPLATES:
        return jsonify({"error": f"unknown template: {template_name}",
                        "available": sorted(GENERATE_TEMPLATES.keys())}), 400

    language = (data.get("language") or "").lower()
    lang_hint = LANG_HINTS.get(language, LANG_HINT_DEFAULT)

    speaker_names = data.get("speakerNames") or {}
    text = _format_segments_for_llm(segments, speaker_names)[:12000]
    prompt = GENERATE_TEMPLATES[template_name].format(text=text, lang_hint=lang_hint)

    # Modal path: spawn LLM напрямую
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
            result = _ollama_generate(prompt, max_tokens=800, temperature=0.5, timeout=180)
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
