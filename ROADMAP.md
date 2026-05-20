# Roadmap

Что планируется делать дальше. Порядок примерный — приоритеты пересматриваются по фидбеку.

---

## 🎯 Next up

Прямо следующие задачи, активно обсуждаемые.

### Stage 2C — Vercel landing + переезд на skriptly.io
**Зачем:** красивый бренд и нормальный URL. Лендинг продаёт, `/app` — сервис.

**Как:**
- Vercel-проект, дизайн лендинга из Claude Design экспортируем как Next.js
- `skriptly.io` — лендинг, `skriptly.io/app` — текущий transcriptor (через Vercel rewrites или отдельный subproject)
- `vercel.json` rewrites: `/api/*` → `https://razornne--transcriptor-v2-flask-app.modal.run/api/*` (CORS не нужен, единый origin)
- DNS в Porkbun → Vercel
- Обновить Supabase Site URL + Google OAuth Authorized origins на `skriptly.io`
- Publish OAuth consent screen в Google (выйти из testing mode для широкой аудитории)

**Сложность:** ~1-2 дня (зависит от готовности лендинга).

### Context prompt для Whisper (отложено)
**Зачем:** на жаргоне / именах / спецтерминах Whisper угадывает по фонетике и часто промахивается.

**Как:** поле «Тема/контекст» в UI до записи → уходит в Whisper как `initial_prompt`.

**Сложность:** ~1-2 часа. Делаем после лендинга.

---

## 🚀 Medium term

После Stage 2C.

### Custom SMTP для Supabase (Resend / SendGrid)
- Снимает лимит 4 magic-link письма в час
- Свой `noreply@skriptly.io` адрес
- 10 минут настройки

### Apple Sign-In
- Требует Apple Developer Program ($99/год) — отложено до спроса
- UI в Supabase уже готов, надо только заполнить Service ID + Key

### Workspace + sharing
- Юзер создаёт workspace («Marketing agency»), приглашает по email
- Транскрипты можно шарить внутри workspace или конкретным людям
- В UI переключатель «My transcripts / Workspace»

### Pre-recording template mode
- До записи можно выбрать «Sales call mode» / «1-on-1» / «Stand-up»
- После Stop **автоматически** запускается генерация Summary с правильным шаблоном

### Pricing model
Когда будет понятен реальный паттерн использования. Варианты:
- Per-seat subscription (B2B), per-minute pay-as-you-go (B2C), Freemium, Workspace plans

---

## 🛠 Quality of life

Небольшие фичи и полировка.

### Better Whisper quality на UA/RU
- Попробовать `whisper-large-v3` fine-tuned на украинских данных (community models на HF, нужна конверсия в CTranslate2)
- Подобрать оптимальные параметры для каждого языка отдельно

### Speaker enrollment
- Юзер записывает ~30 сек своего голоса как эталон
- pyannote сравнивает embeddings и автоматически подписывает «Никита» вместо «Speaker 1»
- Полезно особенно в командах — все эталоны хранятся в workspace

### Stats / Dashboard
- Отдельная страница: сколько часов созвонов за неделю / месяц
- Топ-собеседники (если есть speaker enrollment), частые темы, время дня
- Простая визуализация на чём проводишь время

### Slack / Notion export
- Кнопка под транскриптом «Send to Slack» → саммари + ссылка в выбранный канал
- «Send to Notion» → создаёт страницу с транскриптом, action items как checkbox

### Realtime streaming
- Текст появляется не по чанкам (раз в 3 минуты), а **по слову** через WebSocket
- Требует streaming Whisper-варианта (whisper.cpp или Faster-Whisper streaming branch)
- Большая работа, ~1-2 дня

### Telegram / WhatsApp bot
- Пересылаешь голосовое в бота → получаешь обратно транскрипт со спикерами
- Отдельная инфра, но переиспользует Modal-бэк

---

## 🖥 Desktop app (Electron)

Когда web-варианта станет недостаточно. Решает проблемы:
- Mobile carriers, блокирующие QUIC (подруга на мобильном)
- Tab discard в Chrome даже с keep-alive трюками (брат)
- Permission ритуал каждую запись (Mac особенно строг)

**Стек:** Electron + наш HTML/JS реюзается ~95%. Тонкая прослойка для:
- Прямой захват аудио через native APIs (`desktopCapturer.getSources` + `loopback`)
- System tray + global hotkey для начала записи
- Auto-update через GitHub Releases

**Стоимость:**
- $0 без code signing (юзеры увидят one-time warning «приложение не верифицировано»)
- $99/год Apple Developer для Mac signing
- $200-400/год Windows EV cert для no-friction установки

**Сделать когда:** будет 5-10+ платящих юзеров или агентство решит купить.

---

## 🔮 Long term / нет приоритета

### Glossary с UI
Apart от basic context prompt — полноценная фича: workspace может вести список терминов / имён / клиентов, автоподставляется в каждый transcript.

### Custom AI templates
Юзеры могут писать свои промпт-шаблоны: «Investor pitch», «Therapy session», whatever. Сохраняются в workspace.

### RAG over прошлые транскрипты
При генерации саммари LLM видит контекст похожих прошлых созвонов с тем же клиентом. Сильно улучшает осмысленность.

### Whisper fine-tune на корректировках
Когда у юзеров накопится 100+ inline-edit правок — собрать датасет, fine-tune. Через несколько месяцев — заметно лучше на их специфике.

### Calendar integration (Zoom / Google Meet hooks)
Автоматически запускать запись для запланированных созвонов из календаря.

### Admin panel
Для коммерческого этапа — управление юзерами, биллинг, статистика workspace.

### GDPR compliance
Privacy policy, data export / deletion, audit log. Перед коммерческим запуском в EU.

---

## ❄️ Currently behind feature flags (готово, но скрыто)

Эти фичи есть в коде, но `FEATURE_X = false` в начале JS. Включаются одной правкой когда станет нужно.

### Chat with transcript (`FEATURE_CHAT`)
Поле «Ask anything about this call…» под AI tools. LLM отвечает на вопросы по транскрипту. **Скрыто** потому что на текущей модели (qwen2.5:3b) качество ответов посредственное — нужна модель побольше или RAG для real ценности.

### Auto-tags (`FEATURE_TAGS`)
LLM авто-генерит 2-4 тега категории (sales / hiring / brainstorm). Чипы в UI, фильтр в History. **Скрыто** потому что без БД и аккаунтов теги одиночного пользователя не очень полезны — заиграет когда появится workspace и нужно фильтровать сотни созвонов.

---

## 📝 Done so far (changelog highlights)

### Stage 2B — Auth + cloud history (just shipped)
- ✅ Supabase Auth: Google OAuth + Email magic link
- ✅ JWT validation на бэке через JWKS endpoint Supabase (HS256 + ES256/RS256)
- ✅ История в Postgres + RLS (юзер видит только свои)
- ✅ Raw fetch обёртка над Supabase REST (SDK PostgrestClient зависал в нашей среде)
- ✅ Login overlay + sign out button

### Stage 2A — Backend on Modal (ноут выключен)
- ✅ Flask на Modal как `@modal.wsgi_app()` — лёгкий CPU контейнер, scale-to-zero
- ✅ `FunctionCall.spawn()` + `from_id().get()` вместо in-memory JOBS dict
- ✅ Job ID с префиксами `t_/g_/c_` чтобы знать тип на polling'е
- ✅ Native Python типы в return (никаких numpy в payload — Flask контейнер их не парсит)
- ✅ Cloudflare Tunnel больше не нужен

### Stage 1 — ML миграция на Modal
- ✅ Modal `@app.cls(gpu="A10G")` пайплайн: whisper + pyannote + LLM на одном GPU
- ✅ CUDA 12.4 base image (libcublas.so.12 системно — без библиотечных конфликтов)
- ✅ large-v3-turbo по дефолту (`WHISPER_MODEL` env override)
- ✅ Qwen2.5-7B-Instruct 4-bit для LLM correction + title (`LLM_MODEL` env override)
- ✅ Persistent Volume `transcriptor-models` (~12 GB моделей кэшируются)
- ✅ Word-level speaker alignment в merger (правильно режет быстрый диалог)
- ✅ Smoothing порог конфигурируемый (`SMOOTH_THRESHOLD_S`, default 0 = выключено)
- ✅ Forward-fill для SPEAKER_UNKNOWN на первых словах сегмента

### Quality improvements
- ✅ Whisper параметры под качество UA/RU + переход на large-v3
- ✅ Internal language prompts (priming алфавитом + лексикой)
- ✅ LLM correction pass с safety checks (length ratio + Cyrillic→Latin injection)
- ✅ Word timestamps (`word_timestamps=True`)

### Frontend
- ✅ Browser-side audio capture (mic + getDisplayMedia)
- ✅ Inline edit транскрипта, переименование спикеров и заголовка
- ✅ Auto-title с progressive UI («✨ thinking…»)
- ✅ History с поиском, подсветкой и jump-to
- ✅ Markdown renderer + export
- ✅ Keyboard shortcuts + cheatsheet
- ✅ Light/dark theme с persistence
- ✅ Notes + AI tools (Summary / Actions / Sales call / 1-on-1 / Standup)
- ✅ Audio safety net: lastRecordingBlob + IndexedDB autosave + recovery
- ✅ Tab keep-alive: silent audio, wake lock, OS notifications, battery warning
- ✅ Feature flags для отложенных фич (Chat, Auto-tags)

См. git history для детальной картины.
