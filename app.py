"""Flask backend для transcriptor-v2.

Полный пайплайн: WebM аудио → faster-whisper → pyannote → merge → JSON со спикерами.
Доп. эндпоинт /api/title использует локальную LLM через Ollama
(http://localhost:11434) для генерации заголовка по транскрипту.

CORS открыт по умолчанию — рассчитан на фронт на отдельном домене (Vercel)
или localhost. Для прода настроить allowed origins через ENV.
"""
import os
import re
import subprocess
import threading
import uuid
from datetime import datetime, timedelta

import requests
from flask import Flask, render_template, jsonify, request
from flask_cors import CORS
from dotenv import load_dotenv

from transcriber import transcribe
from diarizer import diarize
from merger import merge


# ── Async jobs registry ────────────────────────────────────────
# Долгие обработки (transcribe ~1-3 мин, generate ~30-90 с) запускаются
# в фоне, фронт опрашивает /api/jobs/<id> каждые 2 с. Это обходит
# 100-секундный таймаут Cloudflare Quick Tunnel.
JOBS: dict[str, dict] = {}
JOBS_LOCK = threading.Lock()
JOB_TTL_MINUTES = 30


def _create_job(kind: str) -> str:
    job_id = uuid.uuid4().hex
    with JOBS_LOCK:
        JOBS[job_id] = {
            "kind": kind,
            "status": "queued",
            "created_at": datetime.utcnow(),
        }
    return job_id


def _update_job(job_id: str, **fields):
    with JOBS_LOCK:
        if job_id in JOBS:
            JOBS[job_id].update(fields)


def _get_job(job_id: str) -> dict | None:
    with JOBS_LOCK:
        return dict(JOBS[job_id]) if job_id in JOBS else None


def _cleanup_jobs():
    """Удаляем job'ы старше TTL — чтобы dict не разрастался."""
    cutoff = datetime.utcnow() - timedelta(minutes=JOB_TTL_MINUTES)
    with JOBS_LOCK:
        stale = [j for j, v in JOBS.items()
                 if v.get("created_at", datetime.utcnow()) < cutoff]
        for j in stale:
            del JOBS[j]

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

load_dotenv()

RECORDINGS_DIR = os.path.join(os.path.dirname(__file__), "recordings")
os.makedirs(RECORDINGS_DIR, exist_ok=True)

app = Flask(__name__)
# Разрешаем все origins для dev — в проде заменить на список доменов
CORS(app, resources={r"/api/*": {"origins": "*"}})

ALLOWED_LANGUAGES = {"ru", "uk", "en"}


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
    """Опрос статуса фоновой задачи. Клиент опрашивает раз в 2 секунды."""
    _cleanup_jobs()
    job = _get_job(job_id)
    if not job:
        return jsonify({"error": "job not found or expired"}), 404
    # datetime не сериализуется в JSON — пропускаем
    return jsonify({k: v for k, v in job.items() if not isinstance(v, datetime)})


def _ollama_generate(prompt: str, *, max_tokens: int = 60, temperature: float = 0.4, timeout: int = 60) -> str:
    """Дёргаем локальную Ollama через её HTTP API."""
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

    job_id = _create_job("chat")

    def worker():
        try:
            _update_job(job_id, status="processing", progress="thinking")
            answer = _ollama_generate(prompt, max_tokens=500, temperature=0.4, timeout=120)
            _update_job(job_id, status="done", answer=answer.strip())
        except requests.exceptions.ConnectionError:
            _update_job(job_id, status="error", error="ollama unreachable")
        except Exception as e:
            _update_job(job_id, status="error", error=f"chat failed: {e}")

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

    job_id = _create_job(f"generate:{template_name}")

    def worker():
        try:
            _update_job(job_id, status="processing", progress="generating")
            result = _ollama_generate(prompt, max_tokens=800, temperature=0.5, timeout=180)
            _update_job(job_id, status="done", result=result.strip())
        except requests.exceptions.ConnectionError:
            _update_job(job_id, status="error", error="ollama unreachable (is it running?)")
        except Exception as e:
            _update_job(job_id, status="error", error=f"ollama failed: {e}")

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

    # Сохраняем аудио сразу — загрузка должна успеть в течении CF лимита,
    # а вот обработка уйдёт в фон
    filename = datetime.now().strftime("%Y%m%d-%H%M%S-%f") + ".webm"
    webm_path = os.path.join(RECORDINGS_DIR, filename)
    audio_file.save(webm_path)

    job_id = _create_job("transcribe")

    def worker():
        wav_path = None
        try:
            _update_job(job_id, status="processing", progress="converting")
            wav_path = _webm_to_wav(webm_path)

            _update_job(job_id, progress="transcribing")
            segments = transcribe(wav_path, language=language, prompt=prompt)

            if not segments:
                _update_job(job_id, status="done", segments=[])
                return

            _update_job(job_id, progress="diarizing")
            speaker_turns = diarize(wav_path, num_speakers=num_speakers)

            _update_job(job_id, progress="merging")
            merged = merge(segments, speaker_turns)

            _update_job(job_id, status="done", segments=merged)
        except Exception as e:
            _update_job(job_id, status="error", error=f"processing failed: {e}")
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
