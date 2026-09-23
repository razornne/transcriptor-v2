"""Сравнение STT-систем на реальных записях без эталонного текста.

Без эталона WER не посчитать, поэтому смотрим:
  • сколько спикеров нашла система (если известно реальное число — сравниваем);
  • сколько слов выдала (сильный недобор относительно других = потерянные куски);
  • взаимное расхождение систем (WER одной относительно другой).

Запуск:  python tests/compare_real.py eval_set/real/uk_team4.ogg --lang uk --speakers 4 \
            --baseline eval_set/archive_uk_upload.json
--baseline: сохранённый ответ прода (JSON с segments) — вместо повторного прогона.
Сохраняет расшифровки в eval_set/real/<name>.<system>.txt для чтения глазами.
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from score_stt import SYSTEMS, _norm  # noqa: E402


def disagreement(hyp: list[dict], ref: list[dict]) -> float:
    """WER hyp относительно ref. rapidfuzz (C++): чистый DP на часовой записи — гигабайты."""
    from rapidfuzz.distance import Levenshtein

    r = [x for x in (_norm(w["word"]) for w in ref) if x]
    h = [x for x in (_norm(w["word"]) for w in hyp) if x]
    return Levenshtein.distance(r, h) / max(len(r), 1)


def to_text(words: list[dict]) -> str:
    lines, cur, spk = [], [], None
    for w in words:
        if w["speaker"] != spk and cur:
            lines.append(f"[{spk}] " + " ".join(cur))
            cur = []
        spk = w["speaker"]
        cur.append(w["word"])
    if cur:
        lines.append(f"[{spk}] " + " ".join(cur))
    return "\n".join(lines)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("audio", type=Path)
    ap.add_argument("--lang", required=True)
    ap.add_argument("--speakers", type=int, default=None, help="реальное число участников, если известно")
    ap.add_argument("--baseline", type=Path, default=None, help="JSON прода с segments (система skriptly)")
    ap.add_argument("--systems", default="soniox_async,soniox_rt")
    args = ap.parse_args()

    outs: dict[str, list[dict]] = {}
    if args.baseline:
        segs = json.loads(args.baseline.read_text(encoding="utf-8"))["segments"]
        outs["skriptly"] = [{"word": w, "speaker": s["speaker"]} for s in segs for w in s["text"].split()]
    for name in [s for s in args.systems.split(",") if s]:
        try:
            res = SYSTEMS[name](args.audio, args.lang)
        except Exception as e:
            print(f"{name}: ERROR {e}")
            continue
        outs[name] = res["words"]
        extra = f", finalize lag {res['finalize_lag_s']:.1f}s" if res.get("finalize_lag_s") is not None else ""
        print(f"{name}: done in {res['wall_s']:.0f}s{extra}", flush=True)

    print(f"\n{args.audio.name}: real speakers = {args.speakers or 'unknown'}")
    print("| system | words | speakers found |")
    print("|---|---|---|")
    for name, words in outs.items():
        n_spk = len({w["speaker"] for w in words})
        mark = "" if args.speakers is None else (" ✓" if n_spk == args.speakers else " ✗")
        print(f"| {name} | {len(words)} | {n_spk}{mark} |")
        (args.audio.parent / f"{args.audio.stem}.{name}.txt").write_text(to_text(words), encoding="utf-8")

    names = list(outs)
    if len(names) > 1:
        print("\nDisagreement (WER of row vs column as reference):")
        print("| | " + " | ".join(names) + " |")
        print("|---|" + "---|" * len(names))
        for a in names:
            cells = []
            for b in names:
                cells.append("—" if a == b else f"{disagreement(outs[a], outs[b]):.0%}")
            print(f"| {a} | " + " | ".join(cells) + " |")
