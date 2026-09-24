"""Ошибка разметки спикеров: Soniox как есть vs переразметка по голосу (speakers.py).

  venv\\Scripts\\python tests/eval_speaker_relabel.py [--eval-dir eval_set/tts]

Soniox batch (ключ SONIOX_API из .env) → реплики → эмбеддинги wespeaker локально
(нужны torch + pyannote.audio + HF_TOKEN) → relabel(k = число спикеров эталона) →
speaker_error_rate из tests/score_stt.py для обоих вариантов.
"""
import argparse
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))

import soniox  # noqa: E402
import speakers  # noqa: E402
from score_stt import ENV, eval_files, parse_reference, wer_stats  # noqa: E402


def load_embedder():
    import torch
    from pyannote.audio import Inference, Model

    model = Model.from_pretrained("pyannote/wespeaker-voxceleb-resnet34-LM", token=ENV["HF_TOKEN"])
    dev = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    inf = Inference(model, window="whole", device=dev)

    def embed(audio: np.ndarray, sr: int, segs: list[dict]) -> list:
        out = []
        for s in segs:
            a, b = float(s["start"]), float(s["end"])
            if b - a < speakers.MIN_EMBED_S:
                out.append(None)
                continue
            b = min(b, a + speakers.MAX_EMBED_S)
            wav = torch.from_numpy(audio[int(a * sr):int(b * sr)]).unsqueeze(0)
            out.append(np.asarray(inf({"waveform": wav, "sample_rate": sr})).reshape(-1))
        return out

    return embed


def decode(path: Path) -> tuple[np.ndarray, int]:
    import soundfile as sf

    with tempfile.TemporaryDirectory() as d:
        wav = os.path.join(d, "a.wav")
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(path), "-ac", "1", "-ar", "16000", wav], check=True)
        audio, sr = sf.read(wav, dtype="float32")
    return audio, sr


def words_with(segs: list[dict], labels: list[str]) -> list[dict]:
    out = []
    for s, lab in zip(segs, labels):
        for w in s["words"]:
            out.append({"word": w["word"].strip(), "speaker": lab})
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--eval-dir", default=str(ROOT / "eval_set" / "tts"))
    args = ap.parse_args()
    key = ENV.get("SONIOX_API") or ENV.get("SONIOX_API_KEY")
    embed = load_embedder()
    rows = []
    for path, ref_path, lang in eval_files(Path(args.eval_dir)):
        ref = parse_reference(ref_path)
        k = len({w["speaker"] for w in ref})
        tokens = soniox.transcribe(key, str(path), lang, diarize=True)
        segs = soniox.words_to_segments(soniox.tokens_to_words(tokens))
        audio, sr = decode(path)
        new, info = speakers.relabel(segs, embed(audio, sr, segs), k=k)
        before = wer_stats(ref, words_with(segs, [s["speaker"] for s in segs]))
        after = wer_stats(ref, words_with(segs, new))
        rows.append((path.name, k, before, after, info))
        print(f"{path.name:18} k={k}  soniox spk_err={before['speaker_error_rate']:6.1%} ({before['speakers_hyp']} spk)"
              f"  → relabel {after['speaker_error_rate']:6.1%} ({after['speakers_hyp']} spk)"
              f"  applied={info['applied']} sep={info.get('min_separation')}", flush=True)
    avg = lambda key, i: sum(r[i][key] for r in rows) / len(rows)  # noqa: E731
    print(f"\nmean speaker error: soniox {avg('speaker_error_rate', 2):.1%} → relabel {avg('speaker_error_rate', 3):.1%}")


if __name__ == "__main__":
    main()
