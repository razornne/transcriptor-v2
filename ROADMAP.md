# Roadmap

Что планируется делать дальше. Порядок примерный — приоритеты пересматриваются по фидбеку.

---

## 🎯 Next up (актуально на 2026-09-25)

Порядок согласован с владельцем. Фазовый план целиком — в сессии «Skriptly проект: состояние и план».

### 1. Фаза 3 — тарифы и оплата
- **Себестоимость посчитана** (калькулятор: https://claude.ai/artifact/7MdjcE6qfMZ7pVed1wV5TF). После отключения заголовков на GPU и живого транскрипта: час звонка в вебе ≈ $0.30 (стерео: 2 дорожки Soniox × $0.10 + Gemini-коррекция $0.05 + Modal $0.05), в приложении ≈ $0.30, загруженный файл ≈ $0.20, 1 000 слов диктовки ≈ $0.03, саммари+actions ≈ $0.01/запись.
- **Тарифы:** Max убрать (после Soniox «Best Quality» ни на что не влияет; Privacy Mode — отдать в Pro/Team или отдельной опцией). **Team доработать.** UA-цена Pro обсуждалась 199–249 ₴ — владелец ещё не решил, ждёт метрик; лимит минут тоже открыт.
- **Диктовка отдельной квотой** (не из общих минут): идея — минуты речи в месяц или месячный запас слов с частичным переносом; «2 000 слов в неделю» как у Wispr Flow владелец копировать не хочет. Возможно сброс раз в месяц/неделю.
- **Оплата — только Merchant of Record** (Lemon Squeezy или Paddle; Stripe не MoR): владелец регистрируется физлицом, налоги считает и платит провайдер. Первым делом проверить, принимают ли физлицо из Украины и как выводят деньги. Stripe-интеграция (`/api/stripe/*`) заменяется `/api/billing/*`.
- Баг до миграции: webhook `customer.subscription.updated` ставит `plan=pro` любой активной подписке — Max-покупатель получает Pro.

### 2. Диктовка: словарь на правках юзера
Сейчас словарь (общий с вебом `user_profiles.vocabulary`) правится вручную в приложении. Дальше — как у Wispr Flow: через несколько секунд после вставки перечитать поле ввода (Windows UI Automation), сравнить с вставленным текстом и добавить пары `wrong → right` сами.

### 3. Себестоимость — оставшиеся рычаги
- **Тишина канала микрофона:** Soniox берёт за длину каждой дорожки; на звонке 24.09 владелец говорил 8 из 68 мин. Вырезать паузы из канала микрофона до отправки (с пересчётом таймстемпов) — до −$0.08/ч.
- Метрики в `/app/review`: себестоимость по записям/юзерам (Soniox по `client_reference_id`, Modal billing, Luna/Gemini токены).

### 4. Качество транскриптов
- **Число спикеров без поля Speakers:** переразметка по голосу (`speakers.relabel`) работает только при заданном числе; нужен авто-выбор k.
- **Коррекция Gemini на длинных звонках** правит не всё: ответ ограничен 16 000 токенов, а час звонка ≈ 21 000 — хвост остаётся неисправленным. Резать на части или поднять лимит.
- Реплики из одних поддакиваний («Mm-hm», «Yep») — опция скрывать.

### 5. Приложение
- **macOS-версия** — веб остаётся временной мерой до неё (на Windows всё уже можно делать через приложение).
- Функции веба в приложении + редизайн («новенькое и лёгкое») — позже. Предложение: главное окно = веб `skriptly.io/app`, нативное — диктовка, запись, капсула.
- Раздача: автообновления, подпись кода, страница скачивания на skriptly.io.

### 6. До публичного запуска
Раскрыть в Privacy Policy архив записей в R2 и PostHog-реплеи без маскировки (или вернуть маскировку — спросить владельца).

---

## 📌 Сделано 2026-09-24 / 25
- **Soniox — основной STT** (batch `stt-async-v5`), GPU-пайплайн — для Privacy Mode и > 295 мин.
- **Переразметка спикеров по голосу** (`speakers.py`, `SpeakerEmbedder`) при заданном Speakers.
- **Живой транскрипт в вебе** — сделан и **выключен** (удваивал стоимость часа). Флаг `FEATURE_LIVE_TRANSCRIPT`, env `LIVE_TRANSCRIPT=on`.
- **Заголовки LLM выключены** (`TITLE_GENERATION=off`): GPU ради заголовка стоил ~$0.06/запись.
- **Приложение для Windows** (`desktop/`, 0.4.0): диктовка (удерживать / закрепить), запись созвонов, капсула на экране, пауза медиа, словарь, чистка текста LLM.
- Миграции 014 (email рядом с user_id) и 015 (учёт секунд диктовки) — применены.

---

### Long recordings (3-4ч) — chunked pipeline ✅ ЗАДЕПЛОЕНО (Phase 4 upload — условно)
**Зачем:** платящий клиент — 3-4ч воркшоп на польском. Монолит `transcribe_full`
умирал на 20-мин таймауте; час аудио считался ~20 мин (медленно).

**Что сделано (на ветке `claude/festive-keller-...`, Phase 0-3):**
- `transcribe_long` оркестратор (CPU): ffmpeg split на ~20-мин чанки →
  параллельный fan-out в `transcribe_chunk` на нескольких A10G → глобальное
  сшивание спикеров через embedding-кластеризацию (sklearn agglomerative) → стич.
- Роутинг по `duration_sec > LONG_AUDIO_THRESHOLD_S` (default 1800с).
- Польский язык (дропдаун + детектор + correction/title hints).
- Per-chunk Gemini correction (один вызов на ~20 мин вместо всего транскрипта).
- Фронт: `duration_sec` в FormData, poll-таймаут 60 мин для длинных, "chunk k/N".

**Осталось:** деплой + тест на реальном файле. Риски: загрузка embedding-модели
(`wespeaker`, HF-гейтинг), Modal cross-call, лимит тела запроса ~250МБ (gating
для resumable upload), подгонка `GLOBAL_SPK_THRESHOLD`. Рычаги скорости:
`CHUNK_LEN_S` ниже = больше параллелизма, урезать `best_of`/temperature fallback.

### ✅ DONE — Upload audio file
Реализовано и задеплоено. Кнопка **Upload file** (`.btn-ghost`) в `.controls` +
скрытый file input (`accept="audio/*,video/*,..."`). `uploadAndTranscribe(file)`:
достаёт длительность через media-элемент (`getMediaDuration`), выставляет
`recordingDurationSec` (для роутинга в long-pipeline + лимитов) и переиспользует
`transcribeBlob`. Guard на `isRecording`/`waitingForFull`. Длинные файлы автоматом
идут в chunked-пайплайн. PostHog `file_uploaded`.

<details><summary>исходный план</summary>

**Зачем:** запрос брата — записать звонок на iPhone Voice Memos / Android call recorder → загрузить .mp3/.m4a в Skriptly. Решает все сценарии где `getDisplayMedia` недоступен (cellular calls, WhatsApp, Signal).

**Как:** кнопка "Upload audio" рядом со Start. Принимает .mp3/.m4a/.wav/.opus/видео (ffmpeg извлечёт аудио). Отправляет в существующий `/api/transcribe` (бэкенд уже умеет работать с аудио-файлом). Длительность вытащить через ffprobe/HTMLMediaElement → передать `duration_sec` для роутинга и лимитов.

**Синергия с long-recording:** загрузка 3-4ч файла автоматом уходит в chunked `transcribe_long`. Аплоад снимает зависимость от стабильности вкладки на долгих записях — главный безопасный путь для длинных созвонов.

**Сложность:** ~1-2 часа. Если большие файлы (>250МБ) рвутся — подключить resumable upload (Phase 4 long-recording: Supabase Storage + Modal тянет по URL).
</details>

### ✅ DONE — Configurable summary detail (объём + фокус саммари)
Реализовано и задеплоено. 3 пресета **Short/Medium/Detailed** (сегмент-контрол на
Summary/Actions табах, запоминается в localStorage) + поле **Focus** (свободный
текст). Backend: `_build_generate_extras` подставляет `{detail_hint}`/`{focus_hint}`
в `GENERATE_TEMPLATES`. `/api/generate` читает `detail`+`focus`.

<details><summary>исходный план</summary>

**Зачем:** разным юзерам нужен разный объём — кому-то TL;DR, кому-то детальный отчёт. Сейчас промпт фиксированный.

**Как (всё сразу, по решению юзера):**
- 3 пресета детальности **Short / Medium / Detailed** — переключатель рядом с кнопкой Summary (и Actions). Каждый = модификатор длины/глубины поверх существующих `GENERATE_TEMPLATES`.
- **Запоминать выбор** юзера как дефолт (localStorage + опц. `user_profiles.preferences`).
- Поле **Focus** (опционально, свободный текст) — "на чём сфокусироваться" (напр. "только решения и цифры", "риски"). Подмешивается в промпт.

**Бэк:** `/api/generate` принимает `detail` (short/medium/detailed) + `focus` (text). `GENERATE_TEMPLATES` → функция-билдер промпта вместо статичных строк. Промпты НЕ сокращать (см. CLAUDE.md) — пресеты добавляют инструкцию, не урезают базу.

**Сложность:** ~2-3 часа.
</details>

### ✅ DONE — Self-learning correction dictionary (wrong→right память)
Реализовано и задеплоено. `_extract_vocab_pairs` (difflib) сохраняет пары
`wrong→right` из Gemini-правок в `user_profiles.vocabulary` `{term,wrong?,...}`;
`_build_correction_hints` (топ-20) подаёт их Gemini как "known corrections" на
будущих транскрипциях, правые формы — в Whisper prompt. Migration 008.

<details><summary>исходный план</summary>

**Зачем:** на реальном транскрипте видно — доменные термины ломаются СТАБИЛЬНО:
"по ЖК"→"пожика", "дебіторська"→"депутатська", "алерти"→"аверти", "формули"→"форуми",
"SQL-запит"→"ескірвізапит". Текущий Personal Vocabulary берёт только новые "интересные"
слова из правок Gemini и кладёт в Whisper `initial_prompt`, но **НЕ запоминает пару**
(что было → что стало) и не переиспользует это как correction-хинт.

**Как (то что юзер хочет):**
- При Gemini correction для каждого изменённого слова сохранять **пару (original → corrected)**, не только новый термин. `_extract_vocab_terms` → `_extract_vocab_pairs` в `modal_app.py`.
- Хранить в Supabase: расширить `user_profiles.vocabulary` JSONB до `{wrong, right, freq, lang, last_seen}` (можно без схемной миграции — это JSONB) или новая колонка `corrections`.
- Переиспользовать на будущих транскрипциях:
  1. Корректные формы (`right`) → в Whisper `initial_prompt` (как сейчас) → распознаёт термин верно с первого раза.
  2. Известные пары → в Gemini correction блоком "user's known corrections: X→Y" → Gemini увереннее чинит.
  3. (опц. позже) детерминированная замена для частых однозначных пар.
- **Бонус-подфича:** ручное поле "мои термины" в настройках (всегда в Whisper prompt) — для терминов которые Gemini ещё не встречал ("ЖК", "ТОВ", "BigQuery").

**Сложность:** ~3-4 часа. Замещает размытый "Glossary с UI" из Long term.
</details>

### ✅ DONE (v1) — User-facing analytics dashboard
Реализовано в текущем `/app` как оверлей "Insights" (кнопка-график в sidebar
рядом с шестерёнкой). Метрики считаются клиентски из `_historyCache` + профиля
(миграция не понадобилась): записей всего, всего часов (sum max(segment.end)),
за месяц, использование лимита, активность за 14 дней (CSS-бары), языки,
топ-термины (из `vocabulary`, добавлен в `/api/profile`). Графики на чистом CSS.
**Дальше:** перенести в v2 Studio (`/v2/insights`) и сделать красивее (Phase 5).

<details><summary>исходный план</summary>

**Зачем:** юзер видит свой прогресс/пользу → retention + естественный повод апгрейдиться ("использовано 85% лимита"). Юзер очень хочет.

**Что показывать (почти всё из Supabase, миграция НЕ нужна):**
- Часы транскрибировано (всего / за месяц) — `minutes_used` + max(segment.end) из `transcripts.segments` JSONB
- Число транскриптов (всего / за период) — count `transcripts`
- График активности по дням/неделям — `created_at`
- Языки записей — `transcripts.language`
- Топ доменных терминов — `user_profiles.vocabulary`
- Использование лимита (X из Y минут, прогресс-бар)
- (когда будет speaker enrollment) топ-собеседники

**Где:** отдельная страница в **v2 Studio** (`/v2/insights`, ссылка в sidebar). На текущем `/app` — отдельный таб/модал. Логично делать в рамках Studio v2 Phase 5.

**Данные:** длительность одного транскрипта = `max(segment.end)` из уже хранимого `segments` JSONB → **без миграции**. Всё остальное (created_at, language, vocabulary) тоже уже есть.

**Сложность:** ~1-2 дня (страница + графики). Старт с агрегатов-цифр, графики вторым шагом.
</details>

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

### RAG — семантический поиск по архиву транскриптов
**Зачем:** "найди все встречи где говорили о найме" — трансформирует продукт из
транскрибатора в "поисковик по твоей памяти". Также даёт контекст для Chat with transcript.

**Что делать:**
1. `pgvector` в Supabase — одна строка в SQL Editor: `CREATE EXTENSION IF NOT EXISTS vector;`
2. Таблица `transcript_embeddings (id, transcript_id, chunk_index, content, embedding vector(768))`
3. После каждой транскрипции → Gemini `text-embedding-004` API → разбить transcript на чанки ~500 токенов с 50-токенным overlap → embeddings → upsert в Supabase
4. Поле поиска в sidebar: semantic search через `<=>` cosine distance + Supabase `pg_trgm` keyword fallback (hybrid)
5. Результаты: список записей с релевантными отрывками → клик → открывает транскрипт

**AI Engineer скиллы:** embeddings, chunking strategies (overlap, sentence-aware split), pgvector, hybrid semantic+keyword search, cosine similarity.

**Синергия с Chat:** когда включаем `FEATURE_CHAT` — RAG даёт LLM релевантный контекст из архива.

**Синергия с Recurring meetings:** серия встреч как RAG-источник для next meeting summary.

**Сложность:** ~1 неделя (embedding pipeline + UI search).

### Structured output через Pydantic (Gemini → JSON)
**Зачем:** сейчас `/api/generate` возвращает raw markdown текст. Structured output даёт:
- Отдельные поля `{summary, action_items[], key_quotes[], recommendations[]}` — не нужно парсить
- `key_quotes` → новая вкладка "Highlights" в ResultView (цитаты, которые стоит запомнить)
- Валидация через Pydantic: если Gemini вернул мусор — caught до сохранения

**Как:** Gemini API поддерживает `response_mime_type: "application/json"` + `response_schema`. В `modal_app.py` `gemini_generate` → возвращает `dict` вместо `str`. Flask сохраняет в `ai_results` как раньше, но с nested структурой. Frontend парсит по ключам.

**AI Engineer скиллы:** Gemini structured output, Pydantic validation, schema design.

**Сложность:** ~1.5 дня (бэк + фронт изменения).

### Eval harness — трекинг стоимости и качества
**Зачем:** понимать сколько реально стоит каждый вызов и видеть деградации.

**Что делать:**
- Migration `011_llm_evals.sql` — таблица `llm_evals (id, user_id, transcript_id, template, latency_ms, input_tokens, output_tokens, cost_usd, model, created_at)`
- В `flask_app`: после каждого `gemini_generate` poll → вытащить usage из Gemini response metadata → insert в `llm_evals`
- Hallucination heuristic (lab tool): проверять имена/числа из summary против оригинального транскрипта через regex — не идеально но ловит грубые случаи
- Internal `/app/evals` страница (admin only) с графиками cost/day, latency p50/p95, model breakdown

**AI Engineer скиллы:** observability, cost modeling, LLM eval patterns.

**Сложность:** ~2 дня (migration + logging + dashboard).

### Recurring meetings — серии созвонов
**Зачем:** weekly standup, 1-on-1 с одним человеком, recurring client call — это серия.
Связывать транскрипты в серию → AI видит контекст предыдущих встреч.

**Как:**
- Поле "Series" при сохранении (или автодетект по участникам + времени)
- `transcripts.series_id UUID` → группировать в sidebar
- При генерации Summary для записи в серии → в промпт подмешивается summary предыдущей встречи как "Previous meeting context"
- UI: sidebar → раскрывается серия с хронологией

**Зависит от:** RAG (предыдущие встречи как контекст).

**Сложность:** ~2-3 дня.

### Google Docs export
**Зачем:** у Notion 10-15% рынка, Google Docs есть у всех. B2B-аудитория живёт в Google Workspace.

**Как:** Google Docs API (OAuth 2.0, аналогично Notion) → создать документ с форматированием. `google-api-python-client` в `web_image`.

**Сложность:** ~1 день.

---

> **Почему нет LangChain:** прямые Gemini REST-вызовы проще, быстрее дебажятся и дешевле
> в Modal image (~50МБ зависимостей). Streaming → `Gemini stream=True` нативно.
> Memory для чата → Gemini `messages` API без абстракций. Когда стоит брать LangChain:
> мультимодельный оркестратор с условной логикой между моделями — у нас такого нет.

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
→ Проработано и поднято в **Next up: User-facing analytics dashboard**.

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

## 🖥 Desktop app (Electron) — ⚠ устарело: сделано на Tauri 2 в `desktop/` (см. CLAUDE.md и desktop/README.md)

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

### Glossary с UI (workspace-уровень)
Базовый персональный вариант ("мои термины" + wrong→right память) поднят в
**Next up: Self-learning correction dictionary**. Здесь остаётся командный
расширенный вариант: workspace ведёт общий список терминов / имён / клиентов,
автоподставляется в каждый transcript всех участников.

### Custom AI templates
Юзеры могут писать свои промпт-шаблоны: «Investor pitch», «Therapy session», whatever. Сохраняются в workspace.

### RAG over прошлые транскрипты
→ **Поднято в Medium term** с полной детализацией (pgvector + Gemini Embeddings + hybrid search + Chat синергия).

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

### Long recordings + UX wave (2026-06) — production
- ✅ **Long recordings (chunked pipeline)** — записи >30 мин режутся на ~20-мин
  чанки, обрабатываются параллельно на нескольких A10G, спикеры сшиваются
  глобально через wespeaker embedding-кластеризацию (`transcribe_long`
  оркестратор + `transcribe_chunk`). Порог сшивания 0.55, L2-norm, диагностика.
- ✅ **Польский язык** (pl) — дропдаун + детектор + correction/title hints.
- ✅ **Загрузка файлов** — кнопка Upload (audio/video), переиспользует transcribeBlob.
- ✅ **Self-learning correction dictionary (wrong→right)** — пары из Gemini-правок
  → Whisper prompt + Gemini known-corrections. Migration 008. + **ручное
  управление** в дашборде (rename/delete/add, `POST /api/vocabulary`).
- ✅ **Configurable summary detail** — пресеты Short/Medium/Detailed + Focus.
- ✅ **User-facing Insights dashboard** — часы/записи/активность/языки/топ-термины,
  клиентский расчёт. Редизайн + collapse терминов.
- ✅ **Controls + hint redesign** — Best Quality карточка, step-pill хинт.
- ✅ **Theme toggle perf** — View Transitions API (убрал per-element transition,
  лагало на больших транскриптах).
- ✅ **Дизайн-доки** — `docs/DESIGN_CURRENT.md` + `docs/DESIGN_V2.md` (бриф для Stitch).

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
