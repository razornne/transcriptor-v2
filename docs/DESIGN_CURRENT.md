# Skriptly — Current Design (v1 `/app`)

> Полное описание текущего production-интерфейса Skriptly: дизайн, все функции,
> UI/UX. Источник правды — `templates/index.html` (single-file, ~5400 строк,
> CSS+JS inline). Этот документ — спутник к `docs/DESIGN_V2.md` (целевой
> редизайн). Дата: 2026-05-30.

---

## 1. Что это

Skriptly — облачный сервис транскрипции созвонов со спикер-разделением и
LLM-обработкой. Текущий интерфейс (`skriptly.io/app`) — **single-page web app**:
один длинный экран со стеком секций (hero → controls → processing/transcript →
tabs → notes), плюс модалки (Settings, Dashboard, Shortcuts, Welcome, Lab).

- **Платформа:** браузер (desktop-first, мобайл частично).
- **Бэкенд:** Modal GPU (whisper large-v3 + pyannote + Gemini/Qwen). Ничего не
  считается на устройстве — всё в облаке.
- **Аутентификация:** Supabase (Google OAuth + magic link).
- **Хранилище:** Supabase Postgres (история транскриптов).

---

## 2. Визуальный язык

### Темы
Две темы, переключатель в UI, сохраняется в `localStorage.theme`, атрибут
`data-theme` на `<html>`.

**Dark — «warm graphite»** (дефолт):
| Токен | Hex | Назначение |
|---|---|---|
| `--bg` | `#131110` | фон страницы |
| `--surface` | `#1e1b18` | карточки, поверхности |
| `--surface-2` | `#262220` | вложенные поверхности |
| `--border` | `#302b27` | рамки, разделители |
| `--text` | `#ede8e1` | основной текст |
| `--muted` | `#857e78` | вторичный текст |
| `--dim` | `#574f4a` | третичный |
| `--accent` | `#a8c5ff` | акцент (лавандово-голубой) |
| `--accent-h` | `#c6daff` | акцент hover |
| `--danger` | `#ff8a8a` | ошибки, Stop |

**Light — «warm pastel»**: `--bg #f5f1ea`, `--surface #fdfaf3`,
`--accent #4a6cf7` (насыщенный синий), `--text #1f1c18`.

**Грейн-оверлей** на фоне (`--grain-opacity .03`, blend overlay) — лёгкая текстура.

### Палитра спикеров
6 цветов чередуются по спикерам: `--sp-1..6` = голубой / розовый / фиолетовый /
зелёный / янтарный / циан. Используются для аватаров и имён спикеров.

### Типографика
- **Display (заголовки):** `Bricolage Grotesque` (variable, opsz 12–96, wdth
  75–100, wght 400–800) — только латиница; для кириллицы фоллбэк на Onest.
- **UI / body:** `Onest` (400–700) — хорошо рендерит кириллицу (UA/RU).
- **Mono:** `JetBrains Mono` (400/500) — таймстемпы, тех-лейблы, цифры.

### Компоненты-примитивы
- **Кнопки:** `.btn-primary` (accent fill), `.btn-danger` (outline → fill на
  hover), `.btn-ghost` (subtle, серый). Радиус ~10px, padding 11×22.
- **Модалки:** `.modal-backdrop` (blur 4px + затемнение) + `.modal-card`
  (surface, border, shadow, max-width 480px по умолчанию; Settings и Dashboard
  переопределяют ширину).
- **Карточки:** surface + border + радиус 12px.
- **Чипы / пиллы:** скруглённые (radius 999px) для тегов, спикеров, статусов.

---

## 3. Макет и навигация

Главный контейнер — `.app-layout` с **левым сайдбаром** (история) и **основной
областью** (контент).

### Сайдбар (`#sidebar`)
- Сворачивается (`sidebarCollapsed` в localStorage), кнопки collapse/open.
- **Поиск** по истории (`#historySearch`) — фильтрует по title/text/speaker/
  date/lang, подсветка `<mark>`, scroll-to-first.
- **Список истории** — записи юзера из Supabase (`_historyCache`, до 200).
  Каждая: title, дата, превью. Группировки нет (плоский список по дате desc).
- **Tag-фильтр** (за фичефлагом `FEATURE_TAGS=false`).
- **Sidebar-user (низ):** аватар, email, plan-бейдж, usage-текст (X/Y min) +
  прогресс-бар использования, кнопка **Insights** (📊) и кнопка **Settings** (⚙).

### Основная область (сверху вниз)
1. **Hero** — email-pill, sign-out, заголовок, тема-тоггл, UI-язык-тоггл (EN/UA).
2. **Controls** — Language picker, Speakers, Context (опц.), Best Quality toggle
   (Max), кнопки **Start recording / Stop / Upload file**.
3. **Processing screen** ИЛИ **Transcript** (взаимоисключающие).
4. **Content tabs** — Transcript / Summary / Actions (появляются при наличии
   сегментов).
5. **Notes** — отдельная секция под табами.

---

## 4. Экраны и состояния (по секциям)

### 4.1 Login overlay
Fullscreen-карточка пока нет сессии. Continue with Google + Email magic link.
Реагирует на `onAuthStateChange` (INITIAL_SESSION / SIGNED_IN / SIGNED_OUT).

### 4.2 Controls (панель управления)
- **Language** `<select>`: Auto-detect / English / Russian / Ukrainian / Polish.
- **Speakers** `<input number>`: точное число (улучшает диаризацию) или auto.
- **Context** (опц.): тема/имена/термины → идёт в Whisper `initial_prompt`.
- **Best Quality toggle** (`#qualityBestToggle`): виден только Max-плану,
  включает large-v3.
- **Start recording**: запрашивает mic + getDisplayMedia, начинает запись.
- **Stop**: останавливает, шлёт blob на транскрипцию.
- **Upload file**: file picker (audio/video) → та же транскрипция (см. §5.2).

### 4.3 Processing screen (`#processingState`)
Показывается во время обработки. Анимированное **кольцо прогресса** (SVG ring,
RING_CIRCUMFERENCE) + **пайплайн-стадии** (`PIPELINE_DEF`: upload → warmup →
transcribe → diarize → correct → assemble) с оценочным таймингом. Реальные
сигналы стадий из бэкенда (`modal.Dict` progress) двигают кольцо к
подтверждённой позиции (`_applyRealStage`). Для длинных записей — «Processing
chunk k/N» (`_showChunkProgress`). Кнопка **Cancel** (отменяет Modal job).

### 4.4 Transcript (`#transcript`)
Рендер сегментов: **строки спикеров** (имя в цвете спикера + таймстемп +
текст). Имена кликабельны (rename inline). Текст редактируется (double-click /
✎ → textarea, Enter save, Esc cancel, помечает `seg.edited`). Copy + Download
.md кнопки в footer транскрипта.

### 4.5 Content tabs (`switchTab`)
- **Transcript** — сам транскрипт.
- **Summary** — generate → Gemini 2.5 Pro отчёт. **Настройка детальности**:
  сегмент-контрол Short / Medium / Detailed (`aiDetailPref`, в localStorage) +
  поле **Focus** (свободный текст). Regenerate перечитывает значения.
- **Actions** — то же, шаблон «actions» (action items + recommendations).
- Дот-индикатор `.tab-has-content` на табе если результат уже есть.
- Free-план получает upgrade-prompt вместо AI.

### 4.6 Notes (`#notesSection`)
Простая textarea под табами. Debounce 600ms на сохранение. Входит в .md экспорт.

### 4.7 Insights dashboard (`#dashboardModal`)
Оверлей (ширина ~1140px). Открывается кнопкой 📊 в сайдбаре. Метрики считаются
**клиентски** из `_historyCache` + профиля:
- Карточки: записей всего, всего часов, за месяц, использование лимита (бар).
- **Активность 14 дней** — вертикальные CSS-бары с базовой линией + числами.
- **Языки** — горизонтальные CSS-бары.
- **Топ-термины** — **редактируемые** чипы из персонального словаря: hover →
  ✎ rename / × delete; "+ Add a term"; collapse до 18 ("Show all N"). Персист
  через `POST /api/vocabulary`.

### 4.8 Settings (`#settingsModal`)
Модалка с левым меню табов: **Account** (email, plan, usage), **Subscription**
(планы, Stripe checkout/portal, Privacy Mode toggle для Max/Team), **Workspace**
(команда, инвайты, per-seat биллинг), **Integrations** (Notion connect),
**Invite friends** (реф-ссылка, бонусные минуты), **Preferences** (язык, число
спикеров, тема), **Danger zone** (удаление данных).

### 4.9 Прочие модалки
- **Shortcuts** — клавиатурные сокращения.
- **Welcome modal** — онбординг нового юзера.
- **Demo transcript** — после welcome новый юзер видит готовый mock-транскрипт
  (Eli/Sasha/Niko) чтобы потыкать табы/rename без записи.
- **Lab** (admin-only) — side-by-side сравнение LLM-моделей.
- **Upgrade prompt** — при достижении лимита / AI-гейте.
- **Recovery box** — если транскрипция упала, blob в памяти → Retry / Download /
  Discard.
- **Undo toast** — при удалении записи (7с окно отмены).

---

## 5. Каталог функций (что умеет)

### 5.1 Запись
- Один `MediaRecorder` (`fullRecorder`) на mix микрофона + `getDisplayMedia`
  через AudioContext, `timeslice=5s` → каждый chunk в IndexedDB (autosave).
- **Tab keep-alive** для долгих созвонов: silent audio (OscillatorNode),
  Wake Lock API, OS Notifications, battery warning, pre-recording limit check.
- **Audio safety net (3 уровня):** `lastRecordingBlob` в памяти + beforeunload
  warning + IndexedDB autosave с recovery незавершённых сессий на load.

### 5.2 Загрузка файла (Upload file)
Кнопка рядом со Start. Принимает audio/video (mp3/m4a/wav/ogg/opus/aac/flac/
mp4/mov). `getMediaDuration` достаёт длительность из media-элемента, далее тот же
путь что у записи (`transcribeBlob`). Длинные файлы → chunked long-pipeline.

### 5.3 Транскрипция + поллинг
`submitJob` POST на `/api/transcribe` → `job_id`. `pollJob` каждые 2с GET
`/api/jobs/<id>`. Длинные записи — таймаут поллинга 60 мин, прогресс по чанкам.

### 5.4 LLM-инструменты
- **Summary / Actions** через Gemini 2.5 Pro (детальность + focus, см. §4.5).
- **Auto-title** — placeholder из первых слов + LLM-заголовок в фоне (`✨`).
- **Auto-tags** (за фичефлагом).
- **Chat with transcript** (за фичефлагом).

### 5.5 Персональный словарь (auto-learned)
Gemini correction чинит STT-ошибки → пары `wrong→right` сохраняются в
`user_profiles.vocabulary`. Правые формы → в Whisper `initial_prompt`; пары → в
Gemini как «known corrections». Прозрачно для юзера, улучшает качество со временем.

### 5.6 История
Supabase Postgres через raw REST (`_sbFetch`, т.к. Supabase JS PostgrestClient
зависает в нашей среде). `_historyCache` в памяти. CRUD: save/update/delete/clear.
Удаление — двойное подтверждение + undo toast + отложенный реальный DELETE (7с).

### 5.7 Экспорт
Copy в буфер + Download .md (Markdown с заголовком, метаданными, спикерами).

### 5.8 Коллаборация
Workspaces, инвайты, visibility (private/workspace), per-seat Team-биллинг.

### 5.9 Интеграции
Notion («Send to Notion» — страница с Summary + Actions + транскриптом).

---

## 6. UX-потоки

**Первый вход:** login → welcome modal → demo transcript → юзер тыкает табы →
закрывает demo → controls.

**Запись:** Start → разрешения (mic + share tab audio) → live (timer + статус) →
Stop → processing screen (кольцо + стадии) → transcript + tabs → auto-title →
save в историю.

**Загрузка:** Upload file → выбор файла → processing → transcript.

**AI:** таб Summary → выбрать детальность/focus → Generate → Gemini → результат →
Regenerate при изменении настроек.

**История:** клик по записи в сайдбаре → загрузка в основную область (segments,
speakerNames, notes, aiResults восстанавливаются).

---

## 7. Клавиатурные сокращения
⌘R start/stop, ⌘/ toggle history, ⌘L toggle UI-язык, ⌘K open Settings, `/` focus
search, `?` shortcuts, Esc закрыть оверлеи. (Глобальный keydown с `e.key` +
`e.code` fallback для non-Latin раскладок.)

---

## 8. i18n и доступность
- **Двуязычный UI** EN + UA (`applyI18n` патчит `[data-i18n]`, `[data-i18n-ph]`,
  `[data-i18n-html]`). Переключатель в hero, сохраняется.
- Кириллица → автосвап шрифта на Onest.
- Тема light/dark с persistence.

---

## 9. Известные ограничения текущего дизайна (мотивация v2)
- **Вертикальный стек** — длинная страница, нет чёткой «студийной» рабочей зоны.
- Нет живой waveform во время записи (статуса записи мало).
- Processing — кольцо есть, но без granular стадий с реальными таймингами.
- Нет command palette, нет полноценного экрана прошлой записи с плеером/маркерами.
- Экспорт — только .md (нет txt/srt/json, нет опций форматирования).
- История плоская (нет группировки Today/Yesterday/This week).
- Транскрипт — строки, не chat-bubbles; визуально менее «премиум».
- Settings — функционально полный, но не такой структурный как в мокапах v2.

→ Всё это адресуется в `docs/DESIGN_V2.md`.
