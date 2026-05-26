# Roadmap

Что планируется делать дальше. Порядок примерный — приоритеты пересматриваются по фидбеку.

---

## 🎯 Next up

Прямо следующие задачи, активно обсуждаемые.

### Upload audio file
**Зачем:** запрос брата — записать звонок на iPhone Voice Memos / Android call recorder → загрузить .mp3/.m4a в Skriptly. Решает все сценарии где `getDisplayMedia` недоступен (cellular calls, WhatsApp, Signal).

**Как:** кнопка "Upload audio" рядом со Start. Принимает .mp3/.m4a/.wav/.opus. Отправляет в существующий `/api/transcribe` (бэкенд уже умеет работать с аудио-файлом).

**Сложность:** ~1 час.

### Mobile mic-only mode
**Зачем:** на iPhone Safari `getDisplayMedia` не работает → запись с телефона сейчас невозможна. Соня и её коллеги — на iPad/телефонах.

**Как:** детектить mobile / Safari → скрывать screen-share часть UI → писать только микрофон. Юзер может включить спикер на звонке, телефон рядом.

**Сложность:** ~1.5 часа.

### Mobile responsive polish (app side)
**Зачем:** лендинг отполирован, но `/app` на телефоне выглядит хуже. Sidebar history, modal'ы, recording controls.

**Сложность:** ~2-4 часа.

### Stripe — subscription.updated pro/max разграничение
Сейчас `customer.subscription.updated` webhook всегда ставит `plan=pro` при активной подписке, не различает pro/max. Нужно читать price_id из объекта подписки и маппить на план.

**Сложность:** ~30 мин.

---

## 🚀 Medium term

После запуска с первыми ~20-30 юзерами.

### OSVC / ФОП / sole-proprietor оформление
- Для Чехии — OSVC. Нужно регистрироваться когда доход появляется
- До этого Stripe принимает платежи без проблем, налоги задним числом

### Apple Sign-In
- Требует Apple Developer Program ($99/год) — отложено до спроса
- UI в Supabase уже готов, надо только заполнить Service ID + Key

### Pre-recording template mode
- До записи можно выбрать «Sales call mode» / «1-on-1» / «Stand-up»
- После Stop **автоматически** запускается генерация Summary с правильным шаблоном

### Stripe — server-side PostHog events
`subscription_activated` / `subscription_cancelled` из webhook — надёжнее чем client-side `payment_started` (юзер может закрыть вкладку до callback'а). Сейчас есть Telegram-уведомления; PostHog ивенты добавим когда нужна будет funnel-аналитика.

### Pricing (зафиксированно)
- **Free** $0 / 60 мин / без диаризации и AI / 5 транскриптов истории
- **Pro** $15/мес ($12 annual) / 600 мин / диаризация + Summary/Actions / безлимит истории
- **Max** $29/мес ($23 annual) / 2000 мин / Best Quality (large-v3) / **+ Privacy Mode** (toggle для bypass Gemini)
- **Team** $14/чел/мес ($11 annual) / 600 мин/seat / + Privacy Mode

### Live Stripe + UAH currency_options
- ✅ Live ключи + 6 price IDs (Pro/Max/Team × Monthly/Annual) подключены
- ⬜ UAH currency_options на каждом Price — Stripe Checkout автоматом покажет грн юзерам с UA IP. ~10 мин в Stripe Dashboard.

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

### Pre-launch wave (2026-05, late) — production-ready
- ✅ **Privacy Mode** (Max + Team) — toggle полностью bypass'ит Gemini:
  - STT correction → Qwen 7B на нашем A10G (вместо Gemini Flash)
  - Summary / Actions → gpt-oss-20b MXFP4 на L40S (вместо Gemini Pro)
  - Gated в UI + бэке двойной защитой (PRIVACY_MODE_ALLOWED_PLANS)
- ✅ **Live Stripe** — `sk_live_...`, webhook на production, 6 price IDs
  (Pro/Max/Team × Monthly/Annual). Promo codes включены через
  `allow_promotion_codes=True`.
- ✅ **Team subscription billing** (per-seat) — owner создаёт workspace
  → Upgrade to Team → Stripe Checkout с quantity=N. Add/remove member
  → автоматическая модификация Stripe quantity через API. Min 2 seats.
- ✅ **Notion integration** — public OAuth, save default parent page,
  "Send to Notion" под транскриптом → создаётся страница с Summary,
  Action items, и полным транскриптом по спикерам.
- ✅ **Lab harness** (admin only) — `/api/lab/compare` параллельный
  inference на нескольких LLM с одним промптом, side-by-side display
  в modal. Использовали для оценки MamayLM 9B vs gpt-oss-20b vs Qwen
  32B. Выбран gpt-oss-20b для Privacy Mode.
- ✅ **Hardened prompts** — anti-hallucination + anti-transliteration
  rules в GENERATE_TEMPLATES. Закрыли проблему "ДІМ-9000 → DIMM-9000"
  и выдуманных ролей у self-hosted моделей.
- ✅ **Demo transcript onboarding** — после welcome modal новый юзер
  видит готовый транскрипт (Eli/Sasha/Niko mock) с заполненными
  Summary/Actions — может потыкать табы, переименовать спикеров,
  ощутить ценность без записи реального звонка.
- ✅ **Cancel button** во время processing — clicks `FunctionCall.cancel()`
  на Modal + flip `pollCancelled` на фронте.
- ✅ **Settings tabs refactor** — sidebar с 7 табами (Account /
  Subscription / Workspace / Integrations / Friends / Preferences /
  Danger zone) вместо длинного scroll.
- ✅ **Telegram admin notifications** — отдельный `admin-secrets`,
  ping'и в личку на: новый signup, новая подписка (Pro/Max/Team) с
  суммой + промокодом если был, отмена подписки.
- ✅ **PostHog error tracking** — `capture_exceptions:true` ловит
  uncaught JS errors. `autocapture:true` — все клики автоматом.
  + новые ивенты: `settings_tab_viewed`, `plan_card_clicked`,
  `content_tab_clicked`, `privacy_mode_toggled`, `team_upgrade_started`,
  `lab_compare_ran`.
- ✅ **Shortcuts robustness** — keyboard handler использует `e.key` +
  `e.code` fallback (исправляет non-Latin раскладку на Mac). Cmd+K
  переключён с поиска на открытие Settings (поиск только на `/`).
- ✅ **Privacy Policy rewrite** — точно описывает что хранится, кто
  обрабатывает, Privacy Mode опция, GDPR права.

### Analytics + UX polish (2026-05)
- ✅ PostHog Session Replay включён + privacy masking (`maskAllInputs`, `blockSelector` на `.transcript` и `.ai-result-content`) — тексты созвонов не пишутся в replay
- ✅ PostHog dashboards настроены: Activation funnel, Retention (weekly), Free→Paid conversion funnel, Skriptly Operations dashboard
- ✅ Upgrade prompt надёжность: 402 проверяется до `safeJson` — prompt гарантированно показывается даже при нестандартном теле ответа
- ✅ Проверка лимита до записи: кнопка Start сразу блокируется если лимит исчерпан; предупреждение если осталось ≤30 мин
- ✅ Delete с undo toast: двойное подтверждение (first click → "Delete?" на 3с), затем 7-секундный undo toast — реальный DELETE в Supabase идёт только после таймера
- ✅ Publish OAuth consent screen + Privacy Policy / Terms of Service страницы на лендинге — Google login открыт для всех
- ✅ Cache headers на Modal HTML (`Cache-Control: no-cache`) — Vercel не кеширует старый `/app`

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
