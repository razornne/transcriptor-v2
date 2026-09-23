"""Side-by-side саммари разных LLM на одном транскрипте тем же промптом, что в проде.

Запуск:  python tests/compare_summaries.py eval_set/archive_uk_upload.json [--template summary]
Модели: Gemini 2.5 Pro (задеплоенный gemini_generate на Modal), GPT-6 Sol, GPT-6 Luna
(OPENAI_API_KEY из .env). Пишет eval_set/summaries_<template>.json: текст, время, токены, $.
"""
import argparse
import ast
import json
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).parent))
from score_stt import ENV  # noqa: E402

# $ за 1M токенов (input, output), стандартный тариф, короткий контекст — 2026-09
PRICES = {"gemini-2.5-pro": (1.25, 10.0), "gpt-6-sol": (2.0, 10.0), "gpt-6-luna": (0.10, 0.50)}


def prod_prompt_builder():
    """Промпт-шаблоны и форматтер транскрипта — ровно те, что в app.py."""
    ns: dict = {"re": re}
    tree = ast.parse((ROOT / "app.py").read_text(encoding="utf-8"))
    for node in tree.body:
        if (isinstance(node, ast.Assign) and any(getattr(t, "id", None) in {
                "GENERATE_TEMPLATES", "SPEAKERS_BLOCK", "GENERATE_DETAILS", "LANG_HINTS", "LANG_HINT_DEFAULT"}
                for t in node.targets)) or (
                isinstance(node, ast.FunctionDef) and node.name in {"_build_generate_extras", "_format_segments_for_llm"}):
            exec(compile(ast.Module(body=[node], type_ignores=[]), "app.py", "exec"), ns)
    return ns


def gemini(prompt: str) -> dict:
    import modal

    t0 = time.time()
    text = modal.Function.from_name("transcriptor-v2", "gemini_generate").remote(prompt)
    # Токены Gemini функция не возвращает — оценка: ~3.5 симв/токен вход (смешанный текст), ~2 выход (кириллица)
    return {"text": text, "wall_s": time.time() - t0,
            "in_tokens": int(len(prompt) / 3.5), "out_tokens": int(len(text) / 2), "tokens_estimated": True}


def openai_model(model: str):
    def call(prompt: str) -> dict:
        t0 = time.time()
        r = requests.post("https://api.openai.com/v1/responses", timeout=600,
                          headers={"Authorization": f"Bearer {ENV['OPENAI_API_KEY']}"},
                          json={"model": model, "input": prompt, "max_output_tokens": 32768})
        if not r.ok:
            raise RuntimeError(f"{model} {r.status_code}: {r.text[:300]}")
        data = r.json()
        text = "".join(c.get("text", "") for item in data.get("output", []) if item.get("type") == "message"
                       for c in item.get("content", []) if c.get("type") == "output_text")
        u = data.get("usage") or {}
        return {"text": text.strip(), "wall_s": time.time() - t0, "status": data.get("status"),
                "in_tokens": u.get("input_tokens", 0), "out_tokens": u.get("output_tokens", 0)}
    return call


MODELS = {"gemini-2.5-pro": gemini, "gpt-6-sol": openai_model("gpt-6-sol"), "gpt-6-luna": openai_model("gpt-6-luna")}


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("transcript", type=Path)
    ap.add_argument("--template", default="summary", choices=["summary", "actions"])
    ap.add_argument("--models", default=",".join(MODELS))
    args = ap.parse_args()

    ns = prod_prompt_builder()
    rec = json.loads(args.transcript.read_text(encoding="utf-8"))
    lang = rec.get("language") or ""
    prompt = ns["GENERATE_TEMPLATES"][args.template].format(
        text=ns["_format_segments_for_llm"](rec["segments"], {}),
        lang_hint=ns["LANG_HINTS"].get(lang, ns["LANG_HINT_DEFAULT"]),
        **ns["_build_generate_extras"]("medium", ""))
    print(f"prompt: {len(prompt)} chars, transcript {rec.get('duration_sec', 0) / 60:.0f} min, lang={lang}")

    names = [m for m in args.models.split(",") if m]
    with ThreadPoolExecutor(max_workers=len(names)) as pool:
        futs = {m: pool.submit(MODELS[m], prompt) for m in names}
    out = {}
    for m, f in futs.items():
        try:
            res = f.result()
        except Exception as e:
            print(f"{m}: ERROR {e}")
            continue
        pin, pout = PRICES[m]
        res["cost_usd"] = res["in_tokens"] / 1e6 * pin + res["out_tokens"] / 1e6 * pout
        out[m] = res
        print(f"{m}: {len(res['text'])} chars, {res['wall_s']:.0f}s, in={res['in_tokens']} out={res['out_tokens']}"
              f"{' (est.)' if res.get('tokens_estimated') else ''}, ${res['cost_usd']:.3f}")
    dest = ROOT / "eval_set" / f"summaries_{args.template}.json"
    dest.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"saved {dest}")
