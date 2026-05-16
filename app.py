"""Flask backend для transcriptor-v2.

Полный пайплайн: WebM аудио → faster-whisper → pyannote → merge → JSON со спикерами.

CORS открыт по умолчанию — рассчитан на фронт на отдельном домене (Vercel)
или localhost. Для прода настроить allowed origins через ENV.
"""
import os
import subprocess
from datetime import datetime

from flask import Flask, render_template, jsonify, request
from flask_cors import CORS
from dotenv import load_dotenv

from transcriber import transcribe
from diarizer import diarize
from merger import merge


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
