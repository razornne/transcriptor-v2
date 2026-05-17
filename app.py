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
from datetime import datetime

import requests
from flask import Flask, render_template, jsonify, request
from flask_cors import CORS
from dotenv import load_dotenv

from transcriber import transcribe
from diarizer import diarize
from merger import merge

OLLAMA_URL   = os.environ.get("OLLAMA_URL", "http://localhost:11434")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "llama3.2:3b")

# Шаблоны промптов для /api/generate.
# Каждый получает {text} — отформатированный транскрипт с [Speaker N]: метками.
# Просим модель писать в том же языке что и транскрипт, в markdown.
GENERATE_TEMPLATES = {
    "summary": (
        "You are summarizing a meeting transcript. Write in markdown, in the same language "
        "as the transcript. Be factual and concise.\n\n"
        "Structure:\n"
        "- A 1-2 sentence topic at the very top (no heading).\n"
        "- `## Key points` — 3-7 bullet points.\n"
        "- `## Decisions` — bullet list, or 'No explicit decisions.' if none.\n\n"
        "Transcript:\n{text}"
    ),
    "actions": (
        "Extract action items from this meeting transcript. Write in the same language as "
        "the transcript. Use markdown checklist format:\n\n"
        "- [ ] Task description — @speaker (if mentioned) — by date (if mentioned)\n\n"
        "Only list items where someone clearly committed to doing something. "
        "If no clear actions, reply with: 'No action items identified.'\n\n"
        "Transcript:\n{text}"
    ),
    "sales_call": (
        "This is a sales call transcript. Write a structured report in markdown, "
        "in the same language as the transcript:\n\n"
        "## Client\nBrief description of the prospect.\n\n"
        "## Pain points\nBullet list of stated pain points or challenges.\n\n"
        "## Solution discussed\nWhat was proposed.\n\n"
        "## Objections\nAny hesitations or concerns raised.\n\n"
        "## Next steps\n- [ ] Concrete next action — @owner — by date\n\n"
        "Transcript:\n{text}"
    ),
    "one_on_one": (
        "This is a 1-on-1 meeting transcript. Write structured notes in markdown, "
        "in the same language as the transcript:\n\n"
        "## What's going well\nBullet list.\n\n"
        "## Concerns / blockers\nBullet list.\n\n"
        "## Feedback exchanged\nBrief summary.\n\n"
        "## Action items\n- [ ] item — @owner\n\n"
        "Transcript:\n{text}"
    ),
    "standup": (
        "This is a daily stand-up transcript. For each speaker who participated, write "
        "a section in markdown (same language as the transcript):\n\n"
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


@app.route("/api/generate", methods=["POST"])
def generate_endpoint():
    """Универсальный endpoint для AI-обработок транскрипта через локальную LLM.

    Body (JSON):
      segments:     [{speaker, start, end, text}] — обязательно
      speakerNames: {raw_label: custom_name} — опционально
      template:     "summary" | "actions" | "sales_call" | "one_on_one" | "standup"

    Returns: {"result": "...markdown text..."}
    """
    data = request.get_json(silent=True) or {}
    segments = data.get("segments") or []
    if not segments:
        return jsonify({"error": "segments required"}), 400

    template_name = (data.get("template") or "summary").lower()
    if template_name not in GENERATE_TEMPLATES:
        return jsonify({"error": f"unknown template: {template_name}",
                        "available": sorted(GENERATE_TEMPLATES.keys())}), 400

    speaker_names = data.get("speakerNames") or {}
    text = _format_segments_for_llm(segments, speaker_names)
    # Ограничиваем размер контекста — llama3.2:3b держит до 128k, но мы экономим время
    text = text[:12000]

    prompt = GENERATE_TEMPLATES[template_name].format(text=text)

    try:
        result = _ollama_generate(prompt, max_tokens=800, temperature=0.5, timeout=120)
    except requests.exceptions.ConnectionError:
        return jsonify({"error": "ollama unreachable (is it running?)"}), 503
    except Exception as e:
        return jsonify({"error": f"ollama failed: {e}"}), 500

    return jsonify({"result": result.strip()})


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
    """Принимает аудиофайл, возвращает транскрипт с разделением по спикерам.

    Form fields:
      audio:        файл (WebM/Opus, WAV, MP3 — любой что понимает ffmpeg)
      language:     "ru" | "uk" | "en" | пусто (auto)
      prompt:       контекст для Whisper (опционально)
      num_speakers: точное число спикеров (опционально, улучшает качество диаризации)

    Returns: {"segments": [{"speaker", "start", "end", "text"}, ...]}
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

    # Сохраняем аудио
    filename = datetime.now().strftime("%Y%m%d-%H%M%S") + ".webm"
    webm_path = os.path.join(RECORDINGS_DIR, filename)
    audio_file.save(webm_path)

    wav_path = None
    try:
        # 0. Конвертация в WAV (нужно для pyannote/torchcodec на Windows)
        wav_path = _webm_to_wav(webm_path)

        # 1. Транскрипция с таймингами
        segments = transcribe(wav_path, language=language, prompt=prompt)
        if not segments:
            return jsonify({"segments": []})

        # 2. Диаризация
        speaker_turns = diarize(wav_path, num_speakers=num_speakers)

        # 3. Совмещение
        merged = merge(segments, speaker_turns)

        return jsonify({"segments": merged})

    except Exception as e:
        return jsonify({"error": f"processing failed: {e}"}), 500
    finally:
        for p in (webm_path, wav_path):
            if p:
                try:
                    os.remove(p)
                except OSError:
                    pass


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False)
