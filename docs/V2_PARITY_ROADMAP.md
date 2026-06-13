# /v2 Parity Roadmap — Ink & Halftone до 100% паритета с /app

> Автор: архитектурная сессия 2026-06-12 (оркестратор). Исполнитель: Sonnet,
> по одному спринту за сессию. Канонический бэклог редизайна. Связан с MYK-14.
> Перед стартом спринта: прочитать CLAUDE.md (секции «Studio v2 → Ink»,
> Workflow, gotchas) + этот файл. НЕ трогать templates/index.html и modal_app.py
> без явного указания.

---

## 0. Диагноз текущего состояния (скриншоты 2026-06-12)

1. **Пилюли Transcript/Summary/Action items в ПУСТОЙ инпут-карточке — ошибка
   продуктовой логики.** В Skriptly транскрипт делается всегда и первым;
   Summary/Actions — производные от готового результата. Выбор «что
   приготовить» до обработки не существует. Пилюли из Input-состояния
   удаляются полностью; segmented control живёт только в Output.
2. **Точки «стеной».** Ореол начинается вплотную к бордеру карточки, кольцо
   слишком плотное и равномерное → читается как жёсткая рамка, а не дымка.
   Нужен внутренний зазор (растворение в ноль за ~44px до бордера),
   smoothstep-профиль по SDF и стохастический край.
3. **Артефакт-полоса внизу экрана** — следствие п.4: canvas-битмап создан под
   одну высоту, CSS растянул под другую.
4. **КРИТИЧЕСКИЙ ПЕРФ-БАГ — корень найден.** Canvas сейчас `absolute inset:0`
   внутри `.i-hero`, а hero растёт вместе с контентом. Длинный транскрипт →
   hero высотой 8–15 тыс. px → битмап ~80+ МБ и **15–20 тыс. точек в каждом
   кадре rAF** (сетка строится по всей высоте, периметр stage-блока огромен).
   FPS падает пропорционально длине текста — ровно наблюдаемый симптом.
   React-ре-рендеры тут вторичны; главное — канвас обязан быть размером с
   вьюпорт, а не с документ.

---

## 1. Целевая стейт-машина воркфлоу («сначала транскрипт»)

```
view = activeEntry ? OUTPUT : INPUT          (derived, page.tsx)

INPUT  ──┬─ phase: idle       карточка ввода. БЕЗ табов/пилюль. Footer:
         │                    [📎][● rec][Lang ▾][Spk ▾][+ Context] … [⏎][Cook]
         ├─ phase: recording  textarea заблокирована, rec-таймер (киноварь),
         │                    стоп = сразу cook (zero-friction)
         └─ phase: cooking    статус-строка (Mono) + волны по реальному
                              прогрессу; кнопка Cancel; ввод заблокирован
                              └─ done → insert в историю → view=OUTPUT

OUTPUT ── tab: transcript | summary | actions   (+ notes в Спринте 4)
          Segmented control (Manrope 500, 13px) появляется ТОЛЬКО здесь.
          Transcript — всегда дефолтная вкладка. Summary/Actions имеют
          внутри свой Generate (detail/focus) — генерация из результата,
          не из ввода. «← New recording» → view=INPUT (activeId=null).
```

Инварианты: никаких AI-выборов до существования транскрипта; cooking не
переживает смену view (Cancel обязателен); auto-run пресетов удалён.

## 2. Миграция UX-элементов оригинала в инпут-карточку

- **Footer-строка карточки (слева→направо):** скрепка · rec · `Lang ▾`
  (Auto/EN/RU/UK/PL, уже есть) · `Spk ▾` (auto/1..6, уже есть) ·
  **`+ Context`** — новая ghost-кнопка: раскрывает вторую строку футера с
  одним инпутом (placeholder «Тема, имена, термины — помогает распознать
  правильно»), значение уходит как поле `prompt` в FormData /api/transcribe
  (бэк принимает давно). Заполнено → кнопка показывает точку-индикатор
  `Context ·`. Esc/blur сворачивает, значение хранится в state до Cook.
- **Best Quality (large-v3, Max-only)** — из карточки УБРАТЬ. Дом: Settings →
  Recording defaults (Спринт 3), чекбокс с бейджем MAX, persist в
  localStorage `ink_settings.quality`, применяется в `transcribe()` как
  `quality: 'best'`. До Спринта 3 тумблер в UI отсутствует (бэк-дефолт fast).
- Подсказки записи 1-2-3 («дозволь микрофон / Share audio / стоп») — тонкая
  mono-строка под карточкой только в phase=idle при hover на rec ИЛИ
  однострочный hint в статусе при старте записи (уже частично есть).

## 3. Математика точек (SDF + smoothstep + мышь)

- **SDF до скруглённого прямоугольника stage** (radius 18):
  `q = abs(p−center) − half + r; d = len(max(q,0)) + min(max(q.x,q.y),0) − r`.
- **Кольцевой профиль яркости:**
  `base(d) = smoothstep(GAP, GAP+RAMP, d) × (1 − smoothstep(PEAK_END, R_OUT, d))`
  с `GAP=44` (растворение в ноль за ~44px до бордера — карточка «дышит»),
  `RAMP=36`, `PEAK_END≈110`, `R_OUT≈230`.
- **Стохастика края (убирает любые линии):** value-noise по координатам
  смещает оба порога на ±10–14px per-dot; яркость ×(0.6..1.4); радиус ±25%;
  позиция ±3px от сетки. Noise детерминированный (hash от x,y), не
  Math.random на кадр.
- **Мышь:** курсор сглаживается пружиной (lerp 0.15–0.2 на кадр).
  `env = (1 − d_m/150)²` при `d_m<150`;
  подсветка `lift = env × (0.55 + 0.45·sin(d_m·0.09 − t·0.0065))`
  (радиальная синус-волна от курсора); смещение `dir_radial × 12px × env`.
  Аддитивно складывается с системными волнами Cook (гауссов гребень по d,
  как сейчас). prefers-reduced-motion → вся динамика off.

## 4. Перф-изоляция Canvas (архитектурный паттерн)

- **Canvas = вьюпорт, не документ.** Sticky/fixed обёртка `height:100dvh`
  внутри hero; битмап ≤ viewport×dpr; rect stage клампится к видимой зоне.
  Это одновременно чинит артефакт-полосу (п.0.3).
- **Хард-кап точек ~2800**: SPACING адаптивно увеличивается, если расчётная
  сетка больше капа.
- **`React.memo(DotField)` + нулевые изменяемые пропсы**: anchor — стабильный
  ref-объект, волны — через imperative handle. Инвариант задокументировать
  в шапке файла: «компонент не должен получать ре-рендер от текстового
  стейта; никаких setState внутри rAF; вся горячая память — в useRef».
- **Reading mode в OUTPUT:** pointermove-листенер отключён, canvas
  opacity→0.35 (CSS transition), rAF не крутится (волн нет). Скролл длинного
  текста никогда не конкурирует с анимацией.
- **Длинные транскрипты:** `content-visibility:auto` +
  `contain-intrinsic-size` на сегмент-строке (.i-seg) — нативная
  виртуализация без библиотек; строка сегмента — `React.memo`.
- Цель: стабильные 60 FPS на транскрипте любой длины (проверка: 3-часовая
  запись из истории + активное движение мыши + переключение темы).

---

# СПРИНТЫ (по одному на сессию исполнителя)

> Глобальные правила для каждого спринта:
> • Шрифты: Manrope 400/500/600 — весь UI; JetBrains Mono — только
>   таймкоды/`chunk k/N`/kbd; Bricolage — display-заголовки; киноварь
>   `#D9482B`/`#F0593A` — только rec/live; Klein `#2740E6`/`#5B6CFF` — акцент.
> • Точки никогда не лежат под текстом; mono и Manrope не смешивать в строке.
> • Файлы: landing/app/v2/*, landing/components/ink/*, landing/lib/ink/*.
> • Definition of Done: `npm run build` зелёный → commit на ветку → merge в
>   main (workflow из CLAUDE.md) → push → preview-верификация (скриншот/eval)
>   → короткий комментарий в MYK-14. Ошибка пуша «Failed to write item to
>   store [0x8]» — НЕ фатальна (credential helper), сверять `git fetch`+SHA.
> • Старый /app и modal_app.py не трогать.

## Спринт 1 — Стейт-машина + Canvas SDF + перф-декаплинг
**Цель:** input-карточка без табов; segmented только в OUTPUT; дымчатый ореол
по SDF с зазором 44px и мышиной волной; 60 FPS на любом транскрипте; артефакт
внизу исчез; Context/Lang/Spk в футере карточки.
**Паттерн/стейт:** derived `view` из `activeId`; DotField: React.memo +
imperative handle + viewport-canvas (секции 1, 3, 4 выше — дословно);
Context → локальный state карточки → FormData `prompt`.
**Чек-лист:**
1. InputCard.tsx: удалить PRESETS-пилюли и prop preset; добавить `+ Context`
   (вторая строка футера); rec-таймер уже Manrope tabular-nums — сверить.
2. page.tsx: убрать preset/autoRunPreset; cook → OUTPUT с tab=transcript;
   прокинуть prompt в transcribe(); InputCard и ResultView не должны
   передавать в DotField ничего, кроме stable ref.
3. lib/ink/api.ts: `transcribe(..., prompt)` → FormData append `prompt`.
4. DotField.tsx: переписать по секциям 3–4 (SDF, smoothstep, noise-края,
   мышь, sticky-вьюпорт, кап 2800, reading mode API: prop-режим через
   imperative `setMode('live'|'reading')` либо data-атрибут на root).
5. ResultView.tsx: segmented control остаётся; убрать всё, что предполагало
   «预-выбор» пресета; `content-visibility:auto` на .i-seg (ink.css).
6. Верификация: FPS-замер eval'ом (performance.now по 60 кадрам) на длинной
   записи; скриншоты light/dark; синтетический pointermove-тест яркости.

## Спринт 2 — Монетизация и контроль обработки
**Цель:** Free/лимиты ведут себя как в /app: запись блокируется на исчерпании,
гейты AI ясные, обработку можно отменить.
**Паттерн/стейт:** profile уже в page-стейте; `UpgradeRequiredError` уже
кидается из api.ts; activeJobId — ref.
**Чек-лист:**
1. Pre-recording limit check (первым делом в onRecToggle/onFile/cookText):
   `minutes_used >= minutes_limit` → не запрашивать разрешения, статус-ошибка
   + upgrade-карточка (.i-recover-стиль, текст «лимит исчерпан», CTA «Open
   billing» → пока ссылка на /app настройки); остаток ≤30 мин → confirm.
2. AI-гейт для free: в вкладках Summary/Actions вместо Generate —
   upgrade-карточка (бек всё равно вернёт 402; UI-гейт до запроса).
   402 из generate → та же карточка (обработка UpgradeRequiredError есть).
3. Cancel при cooking: кнопка в статус-строке; клиентски — прервать
   pollJob (флаг-ref) и вернуть INPUT.idle; исполнителю проверить
   `grep -n "cancel" app.py` — если есть endpoint отмены job, дернуть
   best-effort; если нет — пометить TODO-комментом (job доработает в фоне).
4. Upgrade-карточка — единый компонент (используется в 1, 2 и далее в S3).

## Спринт 3 — Settings-центр + Best Quality + Privacy + Custom Presets
**Цель:** полноценные настройки в Ink-стиле; Max-фичи доступны; командные
кастомные промпты работают (бэк-дельта одобрена ранее).
**Паттерн/стейт:** Settings как overlay-роут (modal поверх stage, ⌘, /
шестерёнка в сайдбаре); localStorage `ink_settings`
{quality, language, speakers, aiDetail, uiLang}; profile-поля plan/privacy.
**Чек-лист:**
1. Settings modal, секции: Account (email, plan, usage), Recording defaults
   (lang, speakers, **Best Quality чекбокс — виден только plan==max, бейдж
   MAX**, применяется в transcribe quality:'best'), Privacy Mode (toggle,
   POST /api/profile/privacy-mode, виден plan∈{max,team}, optimistic +
   rollback), Appearance (theme), Sign out.
2. Custom Presets (бэк): миграция `009_custom_presets.sql`
   (user_profiles.presets + workspaces.presets JSONB, cap 20×2000 chars,
   «Run in Supabase SQL Editor» в шапке); app.py: GET в /api/profile,
   POST /api/presets (паттерн /api/vocabulary), /api/generate
   template="custom"+preset_id → обёртка HARD RULES + сентинел
   `<<TRANSCRIPT_TEXT>>` (механика privacy map-reduce, литерал общий).
   Это ЕДИНСТВЕННОЕ санкционированное касание app.py; modal deploy по
   завершении (PYTHONUTF8=1) + health-check.
3. UI пресетов: в OUTPUT рядом с Summary/Actions — «✦ Custom ▾» вкладка-меню
   (список пресетов + New preset modal: name, prompt, scope Personal/Team).
4. Linear: закрыть «кастомные пресеты» комментом в MYK-14.

## Спринт 4 — Паритет результата
**Цель:** работа с готовым транскриптом не уступает /app.
**Паттерн/стейт:** patchLocal уже есть (optimistic + PATCH); сегмент получает
флаг edited.
**Чек-лист:**
1. Inline-edit текста сегмента: двойной клик/✎ → textarea, Enter=save,
   Esc=cancel, Shift+Enter=newline; seg.edited=true; PATCH segments.
2. Notes: четвёртая вкладка (textarea, debounce 600ms → PATCH notes).
3. Удаление с undo: первый клик ✕ → «Delete?» (danger, 3с), второй —
   мгновенно из UI + toast Undo 7с; реальный DELETE по таймеру
   (паттерн старого /app, описан в CLAUDE.md).
4. Pin/Закріпити: исполнителю сперва `grep -n -i "закріп\|pinned"
   templates/index.html` — повторить механизм хранения оригинала
   (не выдумывать свой).
5. Send to Notion: `grep -n "/api/notion" app.py` → кнопка в экспорт-ряду,
   видимость по подключённости из /api/profile; статусы sent/error.
6. Экспорт: .txt и копирование с именами спикеров (md уже есть).

## Спринт 5 — Команда и онбординг
**Цель:** Team-воркспейс управляем из /v2; новый юзер не видит пустоту.
**Чек-лист:**
1. Workspace UI в сайдбаре (Team-режим): создание, Invite по email,
   список участников, Leave/Remove. Контракты из CLAUDE.md:
   GET/POST/DELETE /api/workspace, POST /api/workspace/invite,
   DELETE /api/workspace/members/<id>, /leave, /accept.
2. Видимость записи: переключатель private/workspace на entry (PATCH
   visibility) — появляется только при наличии воркспейса.
3. Demo transcript + welcome для нового юзера: `grep -n -i "demo"
   templates/index.html` — переиспользовать данные/логику показа.
4. Shortcuts overlay по `?`: ⌘\ sidebar, R rec, Esc, табы 1/2/3 —
   карточка в Ink-стиле (kbd-чипы mono).

## Спринт 6 — Insights + PostHog + i18n + mobile
**Чек-лист:**
1. PostHog: init с ключом из index.html, api_host = origin+'/ingest' на
   проде (rewrites уже в next.config), фоллбэк eu.i.posthog.com на
   localhost; identify/reset в onAuthStateChange; событийная таблица — из
   CLAUDE.md (PostHog Analytics); **обязательно** session_recording
   maskAllInputs + blockSelector '.i-seglist, .i-md' (тексты созвонов не
   должны попадать в replay).
2. Insights: модал из сайдбара; метрики клиентски из entries+profile+
   vocabulary (та же математика, что в /app, описана в CLAUDE.md);
   графики CSS-only; usage-метр точками (halftone = данные).
3. i18n EN/UA: t()-словарь (портировать ключи из index.html), переключатель
   в Settings, persist в ink_settings.uiLang.
4. Mobile: ≤640px — сайдбар-drawer (уже overlay), карточка full-width,
   segmented скроллится, тач-таргеты ≥44px; протестировать запись на
   мобильном Chrome (getDisplayMedia недоступен — graceful mic-only).
**Definition of Done спринта:** PostHog-ивенты видны в debug-режиме;
скриншоты mobile/desktop обеих тем.

## Спринт 7 — Cutover
**Чек-лист:** sanity-чеклист паритета по этому файлу → `next.config.mjs`:
`/app` rewrite → /v2 (или redirect), `templates/index.html` → `legacy/`;
обновить CLAUDE.md (архитектура, секция Studio→Ink), README, ISSUES;
объявить в MYK-14 Done; PostHog-аннотация релиза. Только после явного
«релиз» от владельца.

---

## Статус-борд (на 2026-06-12)

| Блок | Статус |
|---|---|
| Auth, запись (mic+tab), upload, транскрипция+волны, история CRUD, AI-табы, rename, title, экспорт md, профиль | ✅ shipped |
| Safety net: IDB autosave, recovery, retry, wake lock/silent audio/notify/battery | ✅ shipped |
| Сегментед-контрол, типографика, физика мыши v1 | ✅ shipped |
| **Спринт 1** | ✅ 100% Shipped (SDF-Canvas, Viewport-clamp, Performance decoupling, Cloud-noise hotfix) |
| **Спринт 2** | ✅ Shipped (Limit gates, 402 handlers, Cooking cancel) |
| Спринты 3–7 | ⬜ очередь |

### Что в коде сейчас (для следующей сессии)
- **DotField v4** (`components/ink/DotField.tsx`): амбиентное **облако** точек —
  интерференция синусоид (`cloud(x,y,t)`, 2 октавы) дрейфует во времени; точки
  на идеальной сетке, меняются только радиус/opacity; **safety-маска** =
  `min(эллипс вокруг anchor, rounded-rect очистка по anchor)` гасит точки в 0
  под заголовком и карточкой; курсор-рябь + волны Cook аддитивно. live=rAF
  крутится (дрейф), reading=паркуется+0.35, reduced=статика. Декаплинг:
  React.memo + useRef + 0 setState в rAF, шаг сетки адаптивен (≤2800 точек).
- **Спринт 2** (`page.tsx` + `api.ts` + `UpgradeCard.tsx`):
  `passLimitGate()` блокирует запись/аплоад при `minutes_used>=limit`
  (UpgradeCard `limitHit`), confirm при ≤30 мин; `cancelText` — текст не
  гейтится (без транскрипции). `CancelToken`/`CancelledError` в api.ts:
  `pollJob` прерывается мгновенно (флаг-ref, 100мс-тики) + дёргает серверный
  `POST /api/jobs/<id>/cancel` (FunctionCall.cancel, освобождает GPU).
  ResultView гейтит Summary/Actions по `plan==='free'` → UpgradeCard; 402 в
  рантайме → `gated`. CTA UpgradeCard → `BILLING_URL` (боевой /app, до Спринта 3).
- **Парность с /app остаётся (Спринты 3-7):** Settings (Best Quality/Privacy/
  Stripe/Notion/referrals), Custom Presets (миграция 009 + /api/presets),
  inline-edit сегментов, Notes, undo-удаление, pin, Send to Notion, .txt,
  workspace UI, demo/welcome, shortcuts overlay, Insights, PostHog, i18n, mobile.

### Заметка для исполнителя по верификации в preview
`mcp__Claude_Preview` рендерит страницу в **hidden**-состоянии (`document.hidden=true`)
→ `requestAnimationFrame` на паузе, скриншотер часто виснет. Анимацию точек
(мышь/волны) пиксельно в preview НЕ проверить — она оживает только в видимой
вкладке. Проверяй: (1) `npm run build` зелёный; (2) eval-замером canvas
`getImageData` — статический base-профиль (SDF-кольцо); (3) `getComputedStyle`
для раскладки/цветов; (4) реальная анимация — глазами в обычном браузере.
