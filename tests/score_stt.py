"""Сравнение STT-систем на eval-наборе с эталоном: WER, доля пропущенных
слов (deletion), ошибки спикеров, найдено спикеров, время, стоимость часа.

Запуск:
  python tests/eval_make_tts.py                      # синтетический набор (один раз)
  python tests/score_stt.py                          # все системы на eval_set/tts
  python tests/score_stt.py --systems soniox_rt --eval-dir eval_set/tts --json-out out.json

Формат набора: <name>.<audio> + <name>.reference.txt (построчно "SPEAKER_X: текст").
Язык берётся из префикса имени файла (uk_clean.ogg → uk).
Ключи — из .env в корне проекта: SONIOX_API (или SONIOX_API_KEY), DEEPGRAM_API_KEY.
Системы:
  skriptly     — задеплоенный пайплайн на Modal с боевыми настройками
  soniox_async — Soniox stt-async-v5 (batch)
  soniox_rt    — Soniox stt-rt-v5 (WebSocket, как будет в живом транскрипте)
  deepgram     — Deepgram Nova-3 batch (если есть ключ)
"""
import argparse
import asyncio
import json
import os
import re
import subprocess
import sys
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent

# $ за час аудио — для сравнения порядка величин. skriptly считается по
# фактическому времени обработки (A10G ~$1.10/ч + коррекция Gemini Flash).
PRICE_PER_HOUR = {"soniox_async": 0.10, "soniox_rt": 0.12, "deepgram": 0.46}
A10G_PER_HOUR = 1.10
GEMINI_CORRECTION_PER_AUDIO_HOUR = 0.015


def load_env() -> dict:
    env = dict(os.environ)
    p = ROOT / ".env"
    if p.exists():
        for line in p.read_text(encoding="utf-8").splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                env.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    return env


ENV = load_env()


def soniox_key() -> str:
    key = ENV.get("SONIOX_API") or ENV.get("SONIOX_API_KEY")
    if not key:
        raise RuntimeError("SONIOX_API не задан в .env")
    return key


def duration_sec(path: Path) -> float:
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
                         capture_output=True, text=True, check=True)
    return float(out.stdout.strip())


# ── Адаптеры: path, lang → {"words": [{"word", "speaker"}], "wall_s", ...} ──

def skriptly(path: Path, lang: str) -> dict:
    import modal

    quality = "best" if lang in {"cs"} else "fast"  # как FORCE_BEST_QUALITY_LANGUAGES в app.py
    t0 = time.time()
    res = modal.Cls.from_name("transcriptor-v2", "Transcriptor")().transcribe_full.remote(
        path.read_bytes(), lang, None, None, uuid.uuid4().hex, quality, False, "")
    wall = time.time() - t0
    words = [{"word": w, "speaker": s["speaker"]} for s in res["segments"] for w in s["text"].split()]
    cost = wall / 3600 * A10G_PER_HOUR
    return {"words": words, "wall_s": wall, "cost_usd": cost, "per_hour_extra": GEMINI_CORRECTION_PER_AUDIO_HOUR}


def _tokens_to_words(tokens: list[dict]) -> list[dict]:
    """Soniox отдаёт суб-словные токены ("text" с ведущим пробелом = начало слова)."""
    words, cur, spk = [], "", None
    for t in tokens:
        text = t.get("text", "")
        if not text or (text.startswith("<") and text.endswith(">")):  # <end>, <fin> — служебные
            continue
        s = str(t.get("speaker", ""))
        for piece in re.split(r"(\s+)", text):
            if not piece:
                continue
            if piece.isspace():
                if cur:
                    words.append({"word": cur, "speaker": spk})
                cur = ""
                continue
            if not cur:
                spk = s
            cur += piece
    if cur:
        words.append({"word": cur, "speaker": spk})
    return words


SONIOX_API = "https://api.soniox.com/v1"


def soniox_async(path: Path, lang: str) -> dict:
    h = {"Authorization": f"Bearer {soniox_key()}"}
    t0 = time.time()
    with open(path, "rb") as f:
        r = requests.post(f"{SONIOX_API}/files", headers=h, files={"file": f}, timeout=300)
    r.raise_for_status()
    file_id = r.json()["id"]
    tr_id = None
    try:
        r = requests.post(f"{SONIOX_API}/transcriptions", headers=h, timeout=60, json={
            "model": "stt-async-v5", "file_id": file_id, "language_hints": [lang],
            "enable_speaker_diarization": True, "enable_language_identification": True,
        })
        if not r.ok:
            raise RuntimeError(f"soniox create {r.status_code}: {r.text[:300]}")
        tr_id = r.json()["id"]
        while True:
            st = requests.get(f"{SONIOX_API}/transcriptions/{tr_id}", headers=h, timeout=30).json()
            if st.get("status") == "completed":
                break
            if st.get("status") == "error":
                raise RuntimeError(f"soniox: {st.get('error_message')}")
            time.sleep(1.0)
        tokens = requests.get(f"{SONIOX_API}/transcriptions/{tr_id}/transcript", headers=h, timeout=60).json()["tokens"]
    finally:
        if tr_id:
            requests.delete(f"{SONIOX_API}/transcriptions/{tr_id}", headers=h, timeout=30)
        requests.delete(f"{SONIOX_API}/files/{file_id}", headers=h, timeout=30)
    return {"words": _tokens_to_words(tokens), "wall_s": time.time() - t0}


def soniox_rt(path: Path, lang: str, speedup: float = 4.0) -> dict:
    """Стрим PCM 16k mono кусками по 100 мс, в `speedup` раз быстрее реального
    времени. finalize_lag_s — сколько ждали финальных токенов после конца аудио."""
    import websockets

    pcm = subprocess.run(["ffmpeg", "-loglevel", "error", "-i", str(path), "-ar", "16000", "-ac", "1",
                          "-f", "s16le", "-"], capture_output=True, check=True).stdout

    async def run() -> dict:
        final: list[dict] = []
        sent_at = {"end": None}
        # ping_interval=None: Soniox не отвечает на WS-пинги — клиент рвал сессию по таймауту
        async with websockets.connect("wss://stt-rt.soniox.com/transcribe-websocket", max_size=None,
                                      ping_interval=None) as ws:
            await ws.send(json.dumps({
                "api_key": soniox_key(), "model": "stt-rt-v5",
                "audio_format": "pcm_s16le", "sample_rate": 16000, "num_channels": 1,
                "language_hints": [lang], "enable_speaker_diarization": True,
                "enable_language_identification": True,
            }))

            async def sender():
                step = 3200  # 100 мс
                try:
                    for i in range(0, len(pcm), step):
                        await ws.send(pcm[i:i + step])
                        await asyncio.sleep(0.1 / speedup)
                    sent_at["end"] = time.time()
                    await ws.send("")  # конец потока
                except websockets.ConnectionClosed:
                    pass  # сервер закрыл сессию (ошибка придёт сообщением)

            task = asyncio.create_task(sender())
            try:
                async for msg in ws:
                    data = json.loads(msg)
                    if data.get("error_code"):
                        raise RuntimeError(f"soniox rt {data['error_code']}: {data.get('error_message')}")
                    final.extend(t for t in data.get("tokens", []) if t.get("is_final"))
                    if data.get("finished"):
                        break
            finally:
                task.cancel()
        return {"tokens": final, "lag": time.time() - (sent_at["end"] or time.time())}

    t0 = time.time()
    out = asyncio.run(run())
    return {"words": _tokens_to_words(out["tokens"]), "wall_s": time.time() - t0,
            "finalize_lag_s": out["lag"]}


def deepgram(path: Path, lang: str) -> dict:
    key = ENV.get("DEEPGRAM_API_KEY")
    if not key:
        raise RuntimeError("DEEPGRAM_API_KEY не задан")
    t0 = time.time()
    r = requests.post("https://api.deepgram.com/v1/listen",
                      params={"model": "nova-3", "diarize": "true", "smart_format": "true", "language": lang},
                      headers={"Authorization": f"Token {key}"}, data=path.read_bytes(), timeout=300)
    r.raise_for_status()
    ws = r.json()["results"]["channels"][0]["alternatives"][0]["words"]
    return {"words": [{"word": w.get("punctuated_word", w["word"]), "speaker": str(w.get("speaker", 0))} for w in ws],
            "wall_s": time.time() - t0}


SYSTEMS = {"skriptly": skriptly, "soniox_async": soniox_async, "soniox_rt": soniox_rt, "deepgram": deepgram}


# ── Эталон и метрики ──────────────────────────────────────────────────────

def _norm(w: str) -> str:
    return "".join(ch for ch in w.lower() if ch.isalnum())


def parse_reference(path: Path) -> list[dict]:
    """'SPEAKER_00: привет как дела' построчно -> плоский список слов со спикером."""
    words = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or ":" not in line:
            continue
        speaker, text = line.split(":", 1)
        for w in text.strip().split():
            words.append({"word": w, "speaker": speaker.strip()})
    return words


def align(ref: list[str], hyp: list[str]) -> list[tuple[str, int | None, int | None]]:
    """Levenshtein по словам; backtrace (op, ref_idx, hyp_idx), op in match/sub/del/ins."""
    n, m = len(ref), len(hyp)
    dp = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n + 1):
        dp[i][0] = i
    for j in range(m + 1):
        dp[0][j] = j
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            cost = 0 if ref[i - 1] == hyp[j - 1] else 1
            dp[i][j] = min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost)
    ops = []
    i, j = n, m
    while i > 0 or j > 0:
        if i > 0 and j > 0 and dp[i][j] == dp[i - 1][j - 1] + (0 if ref[i - 1] == hyp[j - 1] else 1):
            ops.append(("match" if ref[i - 1] == hyp[j - 1] else "sub", i - 1, j - 1))
            i, j = i - 1, j - 1
        elif i > 0 and dp[i][j] == dp[i - 1][j] + 1:
            ops.append(("del", i - 1, None))
            i -= 1
        else:
            ops.append(("ins", None, j - 1))
            j -= 1
    ops.reverse()
    return ops


def wer_stats(ref_words: list[dict], hyp_words: list[dict]) -> dict:
    # Токены без букв/цифр ("%", "—") в сравнении не участвуют
    ref_words = [w for w in ref_words if _norm(w["word"])]
    hyp_words = [w for w in hyp_words if _norm(w["word"])]
    ops = align([_norm(w["word"]) for w in ref_words], [_norm(w["word"]) for w in hyp_words])
    subs = sum(1 for op, *_ in ops if op == "sub")
    dels = sum(1 for op, *_ in ops if op == "del")
    inss = sum(1 for op, *_ in ops if op == "ins")
    ref_len = max(len(ref_words), 1)

    # Ошибка спикеров: на совпавших словах — жадный маппинг ref-спикер → hyp-спикер
    # по максимальному пересечению (переименование лейблов ошибкой не считается).
    matched = [(ri, hi) for op, ri, hi in ops if op == "match"]
    overlap: dict[tuple[str, str], int] = {}
    for ri, hi in matched:
        key = (ref_words[ri]["speaker"], hyp_words[hi]["speaker"])
        overlap[key] = overlap.get(key, 0) + 1
    mapping: dict[str, str] = {}
    used: set[str] = set()
    for (r, h), _c in sorted(overlap.items(), key=lambda kv: -kv[1]):
        if r not in mapping and h not in used:
            mapping[r] = h
            used.add(h)
    spk_errs = sum(1 for ri, hi in matched if mapping.get(ref_words[ri]["speaker"]) != hyp_words[hi]["speaker"])

    return {
        "wer": (subs + dels + inss) / ref_len, "substitutions": subs, "deletions": dels, "insertions": inss,
        "deletion_rate": dels / ref_len, "ref_len": ref_len,
        "speaker_error_rate": spk_errs / max(len(matched), 1),
        "speakers_ref": len({w["speaker"] for w in ref_words}),
        "speakers_hyp": len({w["speaker"] for w in hyp_words}),
    }


# ── Runner ────────────────────────────────────────────────────────────────

def eval_files(eval_dir: Path) -> list[tuple[Path, Path, str]]:
    out = []
    for p in sorted(eval_dir.iterdir()):
        if p.suffix.lower() not in (".wav", ".mp3", ".m4a", ".ogg", ".opus", ".webm") or p.name.startswith("_"):
            continue
        ref = p.with_name(p.stem + ".reference.txt")
        if ref.exists():
            out.append((p, ref, p.stem.split("_")[0]))
    return out


def run_system(name: str, files: list[tuple[Path, Path, str]]) -> list[dict]:
    rows = []
    for audio, ref, lang in files:
        try:
            res = SYSTEMS[name](audio, lang)
        except Exception as e:
            print(f"  {name}/{audio.name}: ERROR {e}", flush=True)
            continue
        st = wer_stats(parse_reference(ref), res["words"])
        dur = duration_sec(audio)
        st.update(file=audio.name, lang=lang, duration_sec=dur, wall_s=res["wall_s"],
                  finalize_lag_s=res.get("finalize_lag_s"),
                  cost_per_hour=(res["cost_usd"] / dur * 3600 + res.get("per_hour_extra", 0))
                  if "cost_usd" in res else PRICE_PER_HOUR.get(name))
        rows.append(st)
        print(f"  {name}/{audio.name}: WER={st['wer']:.1%} del={st['deletion_rate']:.1%} "
              f"spk_err={st['speaker_error_rate']:.1%} speakers={st['speakers_hyp']}/{st['speakers_ref']} "
              f"wall={st['wall_s']:.0f}s", flush=True)
    return rows


def summarize(results: dict) -> None:
    def avg(rows, k):
        vals = [r[k] for r in rows if r.get(k) is not None]
        return sum(vals) / len(vals) if vals else None

    print("\n| system | files | WER | deletion | speaker err | speakers right | $/hour |")
    print("|---|---|---|---|---|---|---|")
    for name, rows in results.items():
        if not rows:
            print(f"| {name} | 0 | — | — | — | — | — |")
            continue
        right = sum(1 for r in rows if r["speakers_hyp"] == r["speakers_ref"])
        cph = avg(rows, "cost_per_hour")
        print(f"| {name} | {len(rows)} | {avg(rows, 'wer'):.1%} | {avg(rows, 'deletion_rate'):.1%} | "
              f"{avg(rows, 'speaker_error_rate'):.1%} | {right}/{len(rows)} | "
              f"{'$%.2f' % cph if cph is not None else '—'} |")

    langs = sorted({r["lang"] for rows in results.values() for r in rows})
    print("\nWER by language (clean / noisy):")
    print("| system | " + " | ".join(langs) + " |")
    print("|---|" + "---|" * len(langs))
    for name, rows in results.items():
        cells = []
        for lang in langs:
            c = [r["wer"] for r in rows if r["lang"] == lang and "_clean" in r["file"]]
            n = [r["wer"] for r in rows if r["lang"] == lang and "_noisy" in r["file"]]
            cells.append(f"{c[0]:.0%} / {n[0]:.0%}" if c and n else "—")
        print(f"| {name} | " + " | ".join(cells) + " |")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--eval-dir", default=str(ROOT / "eval_set" / "tts"), type=Path)
    parser.add_argument("--systems", default="skriptly,soniox_async,soniox_rt")
    parser.add_argument("--json-out", type=Path, default=None)
    args = parser.parse_args()

    names = [s.strip() for s in args.systems.split(",") if s.strip()]
    unknown = [s for s in names if s not in SYSTEMS]
    if unknown:
        sys.exit(f"Неизвестные системы: {unknown} (доступны: {', '.join(SYSTEMS)})")
    files = eval_files(args.eval_dir)
    if not files:
        sys.exit(f"Нет файлов с эталоном в {args.eval_dir}")

    with ThreadPoolExecutor(max_workers=len(names)) as pool:  # системы параллельно, файлы по очереди
        futures = {n: pool.submit(run_system, n, files) for n in names}
        results = {n: f.result() for n, f in futures.items()}
    summarize(results)
    if args.json_out:
        args.json_out.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"\nJSON: {args.json_out}")
