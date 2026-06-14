# Legacy — archived 2026-06-14

## templates/index.html
The original single-file Flask-served frontend (HTML + CSS + JS inline, ~5200 lines).
Served by Modal Flask `GET /` until Sprint 7 cutover.

After cutover:
- `app.py GET /` returns 301 → `https://skriptly.io/app`
- `landing/app/app/` (Next.js) is now the production frontend at `skriptly.io/app`
- This file is archived for reference only — do not import or bundle.
