# Skriptly — V2 «Studio» Design

> Целевой редизайн `/app`. Структура зеркалит `docs/DESIGN_CURRENT.md`, но
> описывает **будущее** состояние на основе мокапов в `redesign v2/` (9 PNG).
> Документ задуман как **бриф для дизайн-инструмента** (Google Stitch / Figma):
> содержит конкретные токены, по-экранные спеки и список новых функций.
> Дата: 2026-05-30.

> ⚠️ **Важная адаптация:** мокапы нарисованы в «local-first desktop» рамке
> («no audio leaves your device», «GPU·Metal / M2 Pro», on-device модели). 
> **Skriptly — облачный сервис** (Modal GPU). Везде, где мокап говорит про
> локальность/железо/выбор модели, это переосмысляется (см. §6 «Cloud
> adaptation»). Визуальный язык берём целиком, framing — меняем.

---

## 1. Что это / направление

**Studio — audio-first, cinematic.** Та же функциональность что и сейчас
(запись/загрузка → транскрипция со спикерами → AI), но в виде «студийной»
рабочей среды: тёмный кинематографичный фон с мятным свечением, крупный
display-заголовок, центральная glass-панель записи с живой waveform, транскрипт
в виде chat-bubbles, command palette, полноценный экран прошлой записи с
плеером.

Уже есть частичный каркас на Next.js (`landing/app/v2`, Phase 1.5). Сейчас
исследуем **Google Stitch** как путь генерации дизайна — этот документ его бриф.

---

## 2. Визуальный язык (токены для Stitch)

### Accent — Phosphor Mint (НЕ синий лендинга)
| Токен | Hex | Назначение |
|---|---|---|
| `--accent` | `#3FBFA3` | основной мятный акцент |
| `--accent-hi` | `#5EEAD4` | яркий хайлайт / hover |
| `--accent-dim` | `#2A8576` | приглушённый |
| `--accent-soft` | `rgba(63,191,163,.12)` | подложки, glow |
| `--on-accent` | `#0A1612` | текст на акценте |

### Dark theme — тёплый графит (дефолт)
| Токен | Hex |
|---|---|
| `--bg` / `--bg-deep` | `#1A1613` → `#0F0C0A` (радиальный градиент + accent glow) |
| `--surface` / `--surface-2` | слои поверхностей графита |
| `--border` / `--hairline` | тёмные рамки/разделители |
| `--ink` / `--ink-soft` / `--mute` / `--faint` | текст по убыванию контраста |

### Light theme — parchment cream
Тёплый кремовый (`#EDE8E0`) + мягкое мятное свечение в фоне. Те же переменные,
другие значения. Управляется `data-theme` (общий механизм с лендингом).

### Палитра спикеров
4 цвета чередуются: **mint / amber / lavender / clay** (`--s-spk-1..4`).
Аватары-кружки + цвет имени.

### Типографика
- **Display:** `Bricolage Grotesque` — wide (wdth 100), opsz 96, wght 700.
  Крупные заголовки экранов («Standup — May 20», «Hi. Let's catch every word.»).
- **UI:** `Manrope` 400–700.
- **Mono:** `JetBrains Mono` — таймстемпы, ярлыки (⌘K), цифры, eyebrow-лейблы
  (`RECORDING · LIVE`, `PIPELINE · 6 STAGES`).

### Радиусы / эффекты
- Радиусы: `sm/md/lg/xl` = 8/12/20/28.
- **Glass-карточки:** полупрозрачный surface + тонкая рамка + мягкая тень +
  фоновое accent-свечение (radial glow).
- Eyebrow-лейблы: uppercase, mono, letter-spacing, мятная точка-индикатор.

---

## 3. Макет и навигация

Три зоны: **левый сайдбар** + **топбар** + **рабочая область** (скролл) + футер.

### Сайдбар
- **Хедер:** mic-иконка + «Studio», под ним eyebrow `EARLY · LOCAL` (→ адаптировать,
  см. §6).
- **Поиск** транскриптов (`⌘K` подсказка справа).
- **История с группировкой:** `TODAY` / `YESTERDAY` / `THIS WEEK` / `EARLIER`.
  Каждая запись: **mini-waveform thumbnail** + title + длительность + время.
  Активная запись подсвечена мятным.
- **User-pill (низ):** аватар-инициалы, email, plan (`FREE · 3 · 1:24h`).

### Топбар
- Eyebrow слева (`RECORDING · LIVE` / `PROCESSING` / `Library · Design crit`).
- Крупный **display-заголовок** (Bricolage) + подзаголовок-дата курсивом.
- Справа: **History**, **Theme toggle** (Light/Dark); на прошлой записи —
  **Export**, **Share**, **…**.

---

## 4. Экраны (по мокапам)

### 4.1 Main / recording — `Main _ recording (2).png`
Центральная **glass studio-панель**:
- Eyebrow `LIVE` + крупный **таймер** `00:04:21` (mono). Справа тех-мета
  (`16 kHz · stereo · whisper-large-v3`) — *в текущем v2 убрана, см. CLAUDE.md*.
- **Живая waveform** — двойной ряд баров, мятные «активные» + серые «будущие».
- **Stop recording** (мятная pill), **Language picker** (inline pills:
  `Lang | EN | RU | UK | AUTO ▾`), **Speakers: N detected** чип, `Press ?` хинт.
- Под панелью — **Speaker chips** (крупные `01/02/03` + имена + Rename).
- **Transcript** — chat-bubbles: аватар 40px + имя (в цвете спикера) + время +
  карточка текста (surface bg, border). Последняя реплика приглушена (live).
- **Футер:** `Auto-saving` индикатор + **Copy** + **Download .md**.

### 4.2 Empty / first run — `Empty _ first run.png`
- Пустой сайдбар: «No recordings yet. Press [N] to start your first session.»
- Центр: **mic-иконка с концентрическими кольцами** (accent glow), крупный
  display: «**Hi. Let's catch every word.**» (слова курсивом мятным).
- Подзаголовок-инструкция.
- Кнопки: **Start recording** (mint pill) + **Upload audio** (outline).
- 3 **feature-карточки:** Local-only / Diarized / Open format (→ адаптировать
  «Local-only», см. §6).

### 4.3 Processing — `Processing.png`
- Eyebrow `PROCESSING`, display «**Reading the audio…**».
- Подзаголовок: длительность аудио · модель · число спикеров.
- Слева — **большое кольцо прогресса** с % и `mm:ss / mm:ss`.
- Справа — **пайплайн-стадии** (`PIPELINE · 6 STAGES`): Decode audio /
  Voice activity scan / Speaker diarization / Transcription / Punctuation+align /
  Assemble session. У завершённых — мятная галочка + тайминг; у текущей — прогресс
  (`02/13 · 04:23`); будущие — приглушены.
- Футер: `ETA · 32 sec · safe to leave this tab` + **Cancel**.

### 4.4 Past recording — `Past recording.png`
- Breadcrumb `← Library / Design crit`, справа **Export / Share / …**.
- Display-заголовок + дата + длительность.
- **Полная waveform с playhead** (плеер) + маркеры (`N markers · click to jump`).
- **Поиск в транскрипте** + «jump to a timestamp» (`N matches`).
- Speaker chips с **collapse-стрелками** (свернуть реплики спикера).
- Chat-bubbles транскрипт.
- Футер: `Saved locally · edited X min ago` + **Edit transcript** + **Download .md**.

### 4.5 Command palette — `Command palette (1).png`
⌘K-оверлей (blur backdrop, glass-карточка):
- Поле ввода (`> record`), справа `⌘K`.
- `ACTIONS`: Start recording `⌘N`, Open last session `⌘L`, Upload audio file
  `⌘U`, New blank session `⌘N`.
- `RECENT`: последние сессии (название + длительность + день).
- `SETTINGS`.
- Футер: `↑↓ navigate · ↵ open · esc close`.

### 4.6 Export modal — `Export modal.png`
- Display «**Export transcript.**», крестик.
- **4 формат-карточки** (выбор): **Markdown** `.md` (выбран, мятная галка) /
  **Plain text** `.txt` / **Subtitles** `.srt` / **JSON** `.json`. Каждая с
  описанием.
- `FORMAT OPTIONS` (тоглы): **Include timestamps** (ON) / **Use speaker names**
  (ON) / **Merge consecutive lines** (OFF) / **Strip filler words** (OFF).
- Футер: `Preview: design-crit.md · ~26 KB` + **Cancel** + **Download .md**.

### 4.7 Settings — `Settings _ Models.png` (визуал) + наши реальные табы
Визуал: левое меню + крупный display-заголовок секции + карточки/тоглы +
`Saved automatically` + `Restore defaults`.
**Мокап-меню** (General/Audio/Language/Models/Hardware/Export/Shortcuts/Account/
Privacy) — берём **стиль**, но содержание под облако (см. §6).

### 4.8 Permissions / setup — `Permissions _ setup.png`
Glass-модалка онбординга: mic-иконка, eyebrow `SETUP · STEP 1 OF 2`, display
«**Allow your microphone.**», 3-шаговая инструкция (Allow → Pick tab → Enable
Share audio), кнопки **Maybe later** + **Allow microphone & continue**. Низ:
`Local-only · whisper · pyannote · no audio leaves your device` (→ адаптировать).

### 4.9 Shortcuts overlay — `Shortcuts overlay.png`
Glass-модалка `REFERENCE`, display «**Keyboard shortcuts**», две колонки:
Start/stop `⌘R`, Copy `⌘C`, Toggle history `⌘/`, Add timestamp marker `⌘.`,
Show list `?` | Command palette `⌘K`, Download .md `⌘S`, Switch language `⌘L`,
Pause/resume `Space`, Close overlays `Esc`. Низ: `Skriptly Transcriptor · v2.0.4`.

---

## 5. Новые функции и дельта vs current

| Фича | Сейчас (v1) | V2 (мокапы) |
|---|---|---|
| Рабочая зона | вертикальный стек | sidebar + topbar + glass studio panel |
| Live waveform | нет | да (AnalyserNode) |
| Транскрипт | строки спикеров | chat-bubbles с аватарами |
| История | плоский список | группировка + mini-waveform thumbnails |
| Processing | кольцо + оценка | кольцо + реальные стадии с таймингами + ETA |
| Прошлая запись | загрузка в основной экран | отдельный экран + **плеер с waveform + маркеры + jump-to-timestamp** |
| Command palette | нет | ⌘K (actions / recent / settings) |
| Экспорт | только .md | **md / txt / srt / json** + опции форматирования |
| Permissions | inline-хинт | пошаговый онбординг-экран |
| Shortcuts | модалка (есть) | редизайн в Studio-стиле |
| Маркеры таймстемпов | нет | `⌘.` add marker → jump в плеере |
| Темы | warm graphite/pastel, синий | warm graphite/cream, **mint** |

**Сохраняем из v1 (не в мокапах, но обязательно перенести):**
- Summary/Actions табы + **детальность (Short/Med/Detailed) + Focus**.
- **Insights dashboard** (перенести и сделать красивее — Phase 5).
- **Notes**.
- Персональный словарь wrong→right (прозрачно, без UI).
- Auth (Google + magic link), история в Supabase, Settings (account/plan/usage/
  workspace/integrations/privacy mode/danger), Stripe-биллинг, Notion.
- Audio safety net (IndexedDB autosave + recovery), tab keep-alive.
- i18n EN/UA.

---

## 6. Cloud adaptation (критично — мокапы рисовались как local desktop)

| Мокап говорит | Реальность Skriptly | Что делать в дизайне |
|---|---|---|
| «no audio leaves your device», «Local-only» | аудио идёт на наш Modal GPU | Заменить на честный privacy-месседж; «Local-only» карточку → «Private by design» / упомянуть **Privacy Mode** (Max/Team, self-hosted модели без Gemini) |
| Eyebrow `EARLY · LOCAL` | облако | `EARLY · CLOUD` или убрать |
| Settings → Models (Tiny…Large v3, размеры на устройстве) | модель выбирает бэкенд; юзер видит только **Best Quality** (Max) | Убрать выбор модели/железа. Вместо «Models & accuracy» — секция качества: тумблер **Best Quality (large-v3)** для Max |
| Settings → Hardware (GPU·Metal / CPU) | нет (всё в облаке) | Убрать секцию целиком |
| Permissions «model runs on this device» | модель в облаке | Переформулировать: «обрабатывается в облаке, шифрованно; Privacy Mode для on-our-infra» |
| Settings меню (General/Audio/Language/Models/Hardware/Export/Shortcuts/Account/Privacy) | наши: Account/Subscription/Workspace/Integrations/Friends/Preferences/Privacy/Danger | Сохранить **стиль** меню, заменить пункты на реальные |
| `v2.0.4` версия | наша версия | подставить реальную |

Прочее: планы/лимиты/usage (Free/Pro/Max/Team) и upgrade-промпты — добавить в
Settings → Subscription (в мокапах нет, но обязательно). Free-гейт на AI и
лимит минут перенести.

---

## 7. UX-потоки (целевые)

**Первый вход:** login (Studio-стиль карточка) → Permissions/setup онбординг →
Empty/first-run → Start или Upload.

**Запись:** Start → live glass-панель (timer + waveform + speakers detected) →
Stop → Processing (стадии + ETA) → Main с транскриптом (bubbles) → auto-save →
запись появляется в сайдбаре.

**Прошлая запись:** клик в сайдбаре → Past recording экран с плеером →
play/seek/jump по маркерам → Edit transcript / Export (модалка форматов) / Share.

**AI:** в рабочей области табы Transcript/Summary/Actions/Notes (как сейчас) +
детальность/focus.

**Везде:** ⌘K command palette как основной навигатор.

---

## 8. Что должен выдать дизайн-инструмент (Stitch) — чеклист экранов
1. Main / recording (live)
2. Empty / first run
3. Processing
4. Past recording (плеер + маркеры)
5. Command palette (⌘K)
6. Export modal (4 формата + опции)
7. Settings (наши табы, Studio-стиль) — **без Models/Hardware**
8. Permissions / setup (онбординг)
9. Shortcuts overlay
10. **Login** (Studio-карточка — нет в мокапах, дизайнить)
11. **Insights dashboard** (перенос v1, сделать красивее — нет в мокапах)
12. **Subscription / plans** в Settings (нет в мокапах)
13. Mobile-адаптив (hamburger drawer для сайдбара)

Для каждого — light + dark тема.

---

## 9. Open questions (решить до/во время Stitch)
- **Privacy framing:** как честно подать «private» для облака (Privacy Mode как
  главный аргумент?).
- **Маркеры таймстемпов** (`⌘.`): новая фича записи — нужен ли backend (хранить
  маркеры) или чисто клиентские в плеере.
- **Плеер прошлой записи:** нужно хранить/отдавать аудио (сейчас аудио НЕ
  хранится после транскрипции — только текст). Либо плеер только для свежей
  записи (blob в памяти), либо добавить хранение аудио (Storage + стоимость).
- **Filler-words strip / merge lines** в экспорте — клиентская пост-обработка.
- **Совмещение со Stitch-выводом:** Stitch даёт HTML/CSS или Figma — как
  переносить в наш Next.js `/v2` (уже есть каркас на чистом CSS под `.studio-root`).
