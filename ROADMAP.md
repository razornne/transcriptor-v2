# Roadmap

Что планируется делать дальше. Порядок примерный — приоритеты пересматриваются по фидбеку.

---

## 🎯 Next up

Прямо следующие задачи, активно обсуждаемые.

### Context prompt для Whisper
**Зачем:** на жаргоне / именах / спецтерминах Whisper угадывает по фонетике и часто промахивается («Шепченка» вместо «Шевченка», «Заспірі на Чугліни Герпін» вместо чего-то осмысленного).

**Как:** добавить поле «Тема/контекст» в UI до записи. Текст уходит в Whisper как `initial_prompt` — модель ориентируется на эти термины и в 2-3 раза точнее распознаёт их. Базовая версия glossary без БД.

**Сложность:** ~1-2 часа.

### LLM correction pass
**Зачем:** даже с context prompt остаются явные galлюцинации и code-switching ошибки. LLM может их вычистить пост-фактум по контексту.

**Как:** новая кнопка `Clean up transcript` в AI tools. qwen2.5:3b читает транскрипт и предлагает исправления для очевидно битых сегментов. Можно показать diff или просто заменить.

**Сложность:** ~3-4 часа.

### Modal-миграция (ML на cloud GPU)
**Зачем:** ноут больше не нужно держать включённым. Pay-per-use ~$0.05-0.10 за созвон, idle = $0.

**Как:**
- Упаковать `transcriber.py + diarizer.py + merger.py + LLM` в Modal app
- Endpoints: `transcribe_full(audio_blob, language, num_speakers)`, `generate(template, segments, ...)`, `chat(question, ...)`, `title(text)`
- Flask становится тонким прокси: получает запрос → шлёт в Modal → отдаёт ответ. Или прямой вызов Modal с фронта через JS SDK.

**Сложность:** ~2-3 дня. Зависимости (cuDNN, Ollama, ffmpeg) упаковываются в один контейнер.

**После Modal:** ноут можно выключать. Брат и подруга получают стабильный URL.

---

## 🚀 Medium term

Структурные изменения после Modal.

### Supabase Auth + Postgres
- Регистрация и логин через Supabase Auth (Email / Google)
- Таблицы: `users`, `workspaces`, `transcripts`, `workspace_members`
- Row-Level Security: пользователь видит только свои / расшаренные транскрипты
- Миграция с localStorage на Supabase (с экспортом старой истории)

### Vercel frontend
- Выносим `index.html` на Vercel (или переписываем на Next.js если нужны проверенные React-паттерны)
- Static + serverless routes для проксирования к Modal / Supabase
- Custom domain (например `transcriptor.app`)
- Login flow через Supabase Auth UI

### Workspace + sharing
- Юзер создаёт workspace («Marketing agency»), приглашает по email
- Транскрипты можно шарить внутри workspace или конкретным людям
- В UI переключатель «My transcripts / Workspace»

### Pre-recording template mode
- До записи можно выбрать «Sales call mode» / «1-on-1» / «Stand-up»
- После Stop **автоматически** запускается генерация Summary с правильным шаблоном
- Сохраняется в настройках, можно сделать дефолтным

### Pricing model
Когда будет понятен реальный паттерн использования. Варианты:
- Per-seat subscription (B2B): $X / user / month
- Per-minute pay-as-you-go (B2C)
- Freemium: N часов в месяц бесплатно, дальше платно
- Workspace plans: free / pro / business

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

- ✅ Local pipeline: faster-whisper + pyannote + merge
- ✅ Browser-side audio capture (mic + getDisplayMedia)
- ✅ Live-text via chunking, diarization после Stop
- ✅ Ollama LLM integration: title, summary, action items, templates, chat
- ✅ Async job queue (обход 100s Cloudflare timeout)
- ✅ Audio safety net: lastRecordingBlob + IndexedDB autosave + recovery
- ✅ Tab keep-alive: silent audio, wake lock, OS notifications, battery warning
- ✅ Inline edit транскрипта, переименование спикеров и заголовка
- ✅ Auto-title с progressive UI («✨ thinking…»)
- ✅ History с поиском, подсветкой и jump-to
- ✅ Markdown renderer + export
- ✅ Keyboard shortcuts + cheatsheet
- ✅ Light/dark theme с persistence
- ✅ Cloudflare Tunnel для шеринга
- ✅ Whisper параметры под качество UA/RU + переход на large-v3
- ✅ LLM language passthrough (ответы на UA/RU, не на английском)
- ✅ Feature flags для отложенных фич

См. git history для детальной картины.
