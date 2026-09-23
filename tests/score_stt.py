"""Eval harness for Фаза 1.2 (skriptly-plan v2) — сравнение realtime STT-вендоров
(Deepgram / AssemblyAI / Soniox) на собственном eval-наборе: WER, deletion rate,
грубая speaker error rate, стоимость.

Запуск:  python tests/score_stt.py --eval-dir eval_set
Чистый stdlib + requests (requests уже используется в проекте для Gemini).

Формат eval-набора (eval_set/):
  call1.wav
  call1.reference.txt   <- построчно "SPEAKER_LABEL: текст реплики"
  call2.mp3
  call2.reference.txt
  ...

Ключи вендоров — через переменные окружения (НЕ хардкодить, не коммитить):
  DEEPGRAM_API_KEY, ASSEMBLYAI_API_KEY, SONIOX_API_KEY

ВАЖНО: цены ниже — по памяти на момент написания плана (2026-09), вендоры
меняют прайсинг часто. Перед тем как на них полагаться в юнит-экономике —
свериться с текущим pricing page вендора и поправить PRICES_PER_MIN.
"""
import argparse
import json
import os
import sys
import wave
from pathlib import Path

import requests

# $ за минуту аудио. Грубые ориентиры — ПРОВЕРИТЬ перед реальными расчётами.
PRICES_PER_MIN = {
    "deepgram": 0.0077,   # Nova-3, streaming pay-as-you-go, ориентир
    "assemblyai": 0.0062, # Universal-Streaming, ориентир
    "soniox": 0.0020,     # realtime, ориентир (~$0.12/ч из плана)
    "modal_selfhost": 0.018,  # текущий A10G self-host, ~$1.10/ч / 60
}


# ── Vendor adapters ──────────────────────────────────────────────────────
# Каждый адаптер принимает путь к аудиофайлу и возвращает список слов:
# [{"word": str, "speaker": str, "start": float, "end": float}, ...]
# Это единый прогон через batch/prerecorded endpoint вендора — прокси для
# качества модели диаризации (та же модель что и в realtime-режиме), сама
# latency/стабильность сокета замеряется отдельно вручную (см. план 1.2).

def deepgram_transcribe(audio_path: Path) -> list[dict]:
    api_key = os.environ.get("DEEPGRAM_API_KEY")
    if not api_key:
        raise RuntimeError("DEEPGRAM_API_KEY не задан")
    mime = "audio/wav" if audio_path.suffix.lower() == ".wav" else "audio/mpeg"
    resp = requests.post(
        "https://api.deepgram.com/v1/listen",
        params={"model": "nova-3", "diarize": "true", "punctuate": "true", "smart_format": "true"},
        headers={"Authorization": f"Token {api_key}", "Content-Type": mime},
        data=audio_path.read_bytes(),
        timeout=300,
    )
    resp.raise_for_status()
    data = resp.json()
    words = data["results"]["channels"][0]["alternatives"][0]["words"]
    return [
        {"word": w["word"], "speaker": f"SPEAKER_{w.get('speaker', 0)}",
         "start": w["start"], "end": w["end"]}
        for w in words
    ]


def assemblyai_transcribe(audio_path: Path) -> list[dict]:
    # TODO: реализовать по тому же контракту, что deepgram_transcribe.
    # Docs: https://www.assemblyai.com/docs — POST /v2/upload затем /v2/transcript
    # с speaker_labels=true, поллинг статуса до completed.
    raise NotImplementedError("assemblyai adapter: заполнить по TODO в файле")


def soniox_transcribe(audio_path: Path) -> list[dict]:
    # TODO: реализовать по тому же контракту. Docs: https://soniox.com/docs
    raise NotImplementedError("soniox adapter: заполнить по TODO в файле")


VENDORS = {
    "deepgram": deepgram_transcribe,
    "assemblyai": assemblyai_transcribe,
    "soniox": soniox_transcribe,
}


# ── Reference parsing ────────────────────────────────────────────────────

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


def audio_duration_sec(path: Path) -> float:
    if path.suffix.lower() == ".wav":
        with wave.open(str(path), "rb") as f:
            return f.getnframes() / float(f.getframerate())
    # для mp3/m4a точную длительность без ffprobe не вытащить — грубая оценка
    # по битрейту не нужна для этого скрипта, используем 0 (не участвует в WER)
    return 0.0


# ── Word-level alignment (Levenshtein DP) для WER + грубой speaker error ──

def _norm(w: str) -> str:
    return "".join(ch for ch in w.lower() if ch.isalnum())


def align(ref: list[str], hyp: list[str]) -> list[tuple[str, int | None, int | None]]:
    """Возвращает backtrace: список (op, ref_idx, hyp_idx), op in match/sub/del/ins."""
    n, m = len(ref), len(hyp)
    dp = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n + 1):
        dp[i][0] = i
    for j in range(m + 1):
        dp[0][j] = j
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            cost = 0 if _norm(ref[i - 1]) == _norm(hyp[j - 1]) else 1
            dp[i][j] = min(
                dp[i - 1][j] + 1,       # deletion
                dp[i][j - 1] + 1,       # insertion
                dp[i - 1][j - 1] + cost,  # match/substitution
            )
    ops = []
    i, j = n, m
    while i > 0 or j > 0:
        if i > 0 and j > 0 and dp[i][j] == dp[i - 1][j - 1] + (0 if _norm(ref[i - 1]) == _norm(hyp[j - 1]) else 1):
            op = "match" if _norm(ref[i - 1]) == _norm(hyp[j - 1]) else "sub"
            ops.append((op, i - 1, j - 1))
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
    ref_text = [w["word"] for w in ref_words]
    hyp_text = [w["word"] for w in hyp_words]
    ops = align(ref_text, hyp_text)
    subs = sum(1 for op, *_ in ops if op == "sub")
    dels = sum(1 for op, *_ in ops if op == "del")
    inss = sum(1 for op, *_ in ops if op == "ins")
    ref_len = max(len(ref_text), 1)
    wer = (subs + dels + inss) / ref_len

    # грубая speaker error rate: на matched-словах сопоставляем ref-спикера
    # с hyp-спикером через жадный маппинг по максимальному пересечению
    matched = [(ri, hi) for op, ri, hi in ops if op == "match"]
    overlap: dict[tuple[str, str], int] = {}
    for ri, hi in matched:
        key = (ref_words[ri]["speaker"], hyp_words[hi]["speaker"])
        overlap[key] = overlap.get(key, 0) + 1
    ref_speakers = sorted({ref_words[ri]["speaker"] for ri, _ in matched})
    hyp_speakers_used: set[str] = set()
    mapping: dict[str, str] = {}
    for rs in sorted(ref_speakers, key=lambda s: -max((c for (r, h), c in overlap.items() if r == s), default=0)):
        candidates = sorted(
            ((c, h) for (r, h), c in overlap.items() if r == rs and h not in hyp_speakers_used),
            reverse=True,
        )
        if candidates:
            mapping[rs] = candidates[0][1]
            hyp_speakers_used.add(candidates[0][1])
    speaker_errs = sum(
        1 for ri, hi in matched
        if mapping.get(ref_words[ri]["speaker"]) != hyp_words[hi]["speaker"]
    )
    speaker_error_rate = speaker_errs / max(len(matched), 1)

    return {
        "wer": wer, "substitutions": subs, "deletions": dels, "insertions": inss,
        "deletion_rate": dels / ref_len, "ref_len": ref_len,
        "speaker_error_rate": speaker_error_rate, "matched_words": len(matched),
    }


# ── Runner ────────────────────────────────────────────────────────────────

def run_eval(eval_dir: Path, vendor_names: list[str]) -> dict:
    results: dict[str, list[dict]] = {v: [] for v in vendor_names}
    audio_files = sorted(
        p for p in eval_dir.iterdir()
        if p.suffix.lower() in (".wav", ".mp3", ".m4a", ".opus") and not p.name.endswith(".reference.txt")
    )
    if not audio_files:
        print(f"Нет аудиофайлов в {eval_dir}", file=sys.stderr)
        sys.exit(1)

    for audio_path in audio_files:
        ref_path = audio_path.with_suffix("").with_suffix(".reference.txt")
        if not ref_path.exists():
            ref_path = audio_path.parent / f"{audio_path.stem}.reference.txt"
        if not ref_path.exists():
            print(f"  пропуск {audio_path.name}: нет {ref_path.name}")
            continue
        ref_words = parse_reference(ref_path)
        duration = audio_duration_sec(audio_path)

        for vendor in vendor_names:
            fn = VENDORS[vendor]
            try:
                hyp_words = fn(audio_path)
            except NotImplementedError as e:
                print(f"  {vendor}/{audio_path.name}: SKIP ({e})")
                continue
            except Exception as e:
                print(f"  {vendor}/{audio_path.name}: ERROR {e}")
                continue
            stats = wer_stats(ref_words, hyp_words)
            stats["file"] = audio_path.name
            stats["duration_sec"] = duration
            stats["cost_usd"] = (duration / 60.0) * PRICES_PER_MIN.get(vendor, 0.0)
            results[vendor].append(stats)
            print(
                f"  {vendor}/{audio_path.name}: WER={stats['wer']:.1%} "
                f"del={stats['deletion_rate']:.1%} spk_err={stats['speaker_error_rate']:.1%}"
            )
    return results


def summarize(results: dict) -> None:
    print("\n| vendor | files | avg WER | avg deletion | avg speaker err | est. $/hour |")
    print("|---|---|---|---|---|---|")
    for vendor, rows in results.items():
        if not rows:
            print(f"| {vendor} | 0 | — | — | — | — |")
            continue
        n = len(rows)
        avg_wer = sum(r["wer"] for r in rows) / n
        avg_del = sum(r["deletion_rate"] for r in rows) / n
        avg_spk = sum(r["speaker_error_rate"] for r in rows) / n
        total_cost = sum(r["cost_usd"] for r in rows)
        total_hours = sum(r["duration_sec"] for r in rows) / 3600.0
        per_hour = total_cost / total_hours if total_hours > 0 else 0.0
        print(f"| {vendor} | {n} | {avg_wer:.1%} | {avg_del:.1%} | {avg_spk:.1%} | ${per_hour:.3f} |")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--eval-dir", default="eval_set", type=Path)
    parser.add_argument("--vendors", default="deepgram,assemblyai,soniox")
    parser.add_argument("--json-out", type=Path, default=None)
    args = parser.parse_args()

    vendor_names = [v.strip() for v in args.vendors.split(",") if v.strip()]
    for v in vendor_names:
        if v not in VENDORS:
            print(f"Неизвестный вендор: {v} (доступны: {', '.join(VENDORS)})", file=sys.stderr)
            sys.exit(1)

    results = run_eval(args.eval_dir, vendor_names)
    summarize(results)

    if args.json_out:
        args.json_out.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"\nJSON сохранён в {args.json_out}")
