# Skriptly Landing

Next.js 14 (App Router) landing page для **skriptly.io**. Адаптирован из дизайн-прототипа Claude Design (Direction C + light/dark темы).

## Архитектура

- **/** → этот лендинг (Next.js, статика после `next build`)
- **/app** → проксируется через `next.config.mjs` rewrites на Modal (`razornne--transcriptor-v2-flask-app.modal.run/`)
- **/api/\*** → проксируется на Modal `/api/*` (бэк остался тот же, фронт переключился на single-origin через Vercel)

Это позволяет не трогать существующий деплой бэка / приложения — лендинг переезжает первым, остальное мигрирует когда руки дойдут.

## Запуск локально

```bash
cd landing
npm install
npm run dev   # → http://localhost:3000
```

## Деплой

Vercel автоматически детектит Next.js. Просто связываешь репо с `skriptly.io`, указываешь root = `landing/`. Готово.

## Что внутри

```
app/
  layout.tsx       — корневой layout, шрифты, theme bootstrap
  page.tsx         — точка входа, монтирует LandingClient
  globals.css      — все стили (Direction C + темы)
components/
  LandingClient.tsx — главный композер (управляет языком)
  Nav, Hero, Social, HowItWorks, Features, Breakout, Pricing, FinalCTA, Footer
  SegToggle.tsx    — sliding-pill segmented control (EN/UA)
  ThemeToggle.tsx  — переключатель light/dark
  AppMock.tsx      — мокап приложения с typewriter эффектом
  Logo.tsx
lib/
  content.ts       — EN/UA копирайтинг + структура тарифов
  hooks.ts         — useTypewriter / useReveal / useParallax
next.config.mjs    — rewrites /app + /api → Modal
```

## Темы

- `data-theme="light"` (по дефолту) — warm parchment + warm light blobs
- `data-theme="dark"` — deep navy + cool purple/blue/pink blobs

Тема сохраняется в `localStorage.skriptly-theme`. Inline-скрипт в `<head>` применяет тему до первого рендера — без flash-of-wrong-theme.

## Язык

- `data-lang="en"` или `"ua"` на `<html>`
- Сохраняется в `localStorage.skriptly-lang`
- При UA автоматически свапается шрифт `--display` с Bricolage на Unbounded (Bricolage слабо рендерит кириллицу), плюс уменьшается xxxl-scale (украинские слова длиннее)

## Что НЕ сделано из прототипа

- **Custom cursor** — убран (раздражает на трекпадах)
- **Tweaks panel** — убрана (финальный дизайн зафиксирован)
- **Annual/Monthly toggle** — убран (пока только monthly цены)
- **TweenedPrice** — не нужен без toggle
- **Glass A / B варианты** — убраны (Direction C финальный)
