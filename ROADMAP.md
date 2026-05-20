# Roadmap

Что планируется делать дальше. Порядок примерный — приоритеты пересматриваются по фидбеку.

---

## 🎯 Next up

Прямо следующие задачи, активно обсуждаемые.

### Context prompt для Whisper
**Зачем:** на жаргоне / именах / спецтерминах Whisper угадывает по фонетике и часто промахивается. Самое заметное улучшение качества при минимуме работы.

**Как:** поле «Тема/контекст» в UI до записи → уходит в Whisper как `initial_prompt`. Уже есть инфраструктура (`prompt` параметр прокидывается через весь стек).

**Сложность:** ~1-2 часа.

### Publish OAuth consent screen
**Зачем:** сейчас Google login только для добавленных test users (max 100). Чтобы любой Google-юзер мог войти — нужно опубликовать app.

**Требования:**
- Privacy Policy URL (страница в landing)
- Terms of Service URL (страница в landing)
- Возможно verification от Google (sensitive scopes у нас нет — должно пройти автоматом)

**Сложность:** ~1-2 часа (большая часть — написать копи для Privacy/Terms).

### Mobile responsive polish
**Зачем:** базовый mobile sweep сделан, но визуально не идеально. Юзеры на iPhone/Android должны получить нормальный экспириенс.

**Как:** реальное тестирование на телефоне, точечные фиксы CSS под виды боли. Особенно — hero, app mockup, pricing на узких экранах.

**Сложность:** ~2-4 часа.

### Cache headers на Modal HTML
**Зачем:** Vercel может кэшировать `/app` HTML с Modal на edge. Когда деплою Modal — юзеры видят старую версию.

**Как:** `Cache-Control: no-cache, max-age=0` на Flask response для HTML.

**Сложность:** 5 минут.

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

### Stage 2C — Landing + production domain (just shipped)
- ✅ Next.js 15 лендинг на `skriptly.io` (Vercel), порт из Claude Design прототипа
- ✅ Direction C (immersive glass hero) + светлая/тёмная темы, переключатель в nav
- ✅ EN/UA локализация с автосвапом шрифта на Onest для кириллицы
- ✅ Все 9 секций: Nav, Hero (typewriter + parallax blobs), Social, How it works, Features, Breakout, Pricing (4 плана + monthly/annual toggle с tweened price), Final CTA, Footer
- ✅ Vercel rewrites: `/app` → Modal, `/api/*` → Modal (fallback)
- ✅ Frontend на `/app` ходит на API **напрямую** в Modal (обходит Vercel 4MB body limit)
- ✅ DNS skriptly.io → Vercel (Porkbun A + CNAME для www)
- ✅ Mobile responsive sweep (базовый — точечная полировка ещё впереди)
- ✅ Кастомное text selection (CTA-цвет с прозрачностью вместо чёрного дефолта)
- ✅ Server-side language detection (Cyrillic vs Latin + UA-specific) — фикс "summary на английском при autodetect"

### Stage 2B — Auth + cloud history
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
