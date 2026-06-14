# Skriptly — Issues & Backlog

> Живой список открытых проблем и нужных фиксов. Приоритет: P0 (срочно/
> блокирует клиента) → P3 (nice-to-have). Status: 🔴 open · 🟡 in progress ·
> 🟢 done · 🔵 needs-verify. Структура задумана Linear-friendly (потом
> подцепим Linear, можно копировать тикеты отсюда).
> Обновлено: 2026-06-10. Бэкенд-сессия: ISS-1/2/3/4/8/9/13 реализованы и
> **задеплоены на прод Modal** (health/auth проверены). Плюс: overlap-пады на
> швах чанков (CHUNK_PAD_S=3с + дедуп по midpoint), scaledown Transcriptor
> 300→150с (минус ~50% idle-хвоста GPU), LabMamayLM9B удалён из деплоя,
> JWT hard-fail при пропавшем SUPABASE_URL (раньше auth молча отключался).
> Остаётся верификация качества на реальных записях (спикеры 1-на-1, 4ч джоба).

---

## 🔴 P0 — срочно (блокирует клиента / функционально ломается)

### ISS-1 · Privacy-mode локальный саммари (gpt-oss-20b) падает с CUDA OOM на длинных записях
**Status:** 🔵 needs-verify — map-reduce реализован 2026-06-10 (вариант 1):
`LabGPTOSS20B.generate_mapreduce` режет транскрипт на окна ~12k символов,
map-заметки → reduce исходным шаблоном. Короткие — одним вызовом как раньше.
Смена модели (вариант 2, качество) — отдельно через Lab harness.
**Где:** `modal_app.py` → `LabGPTOSS20B.generate` / `_llm_chat_generate`
**Симптом:** при генерации summary/actions в Privacy Mode на длинном транскрипте:
```
torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 125.45 GiB
  ... gpt_oss/modeling_gpt_oss.py:263 eager_attention_forward
  attn_weights = torch.matmul(query, key_states.transpose(2, 3)) * scaling
```
**Корень:** gpt-oss-20b в transformers поддерживает только **eager attention**
(SDPA/flash не реализованы для `GptOssForCausalLM`). Eager материализует матрицу
внимания `[heads × seq × seq]` → O(n²) память → на длинном транскрипте (часы)
раздувается до сотен ГБ → OOM даже на L40S (48GB).
**Почему важно:** Privacy Mode = условие для приватных клиентов (NDA, как у
Anna Tomala с её key client). Обычный Gemini-саммари 4ч тянет (2M контекст), но
он НЕ приватный. То есть приватный путь сейчас нерабочий на её главном сценарии
(3-4ч воркшопы).
**Варианты фикса:**
1. **Map-reduce саммари** (рекомендуется, модель-агностично): резать транскрипт
   на куски ~8-12k токенов, саммаризовать каждый, потом саммари-над-саммари.
   Каждый контекст мал → нет OOM. Масштабируется на любую длину.
2. **Сменить локальную модель** на длинно-контекстную с эффективным attention
   (напр. Qwen2.5-14B/32B-Instruct с flash-attention, int4) — поддерживает
   длинный контекст без O(n²) взрыва. Проверить качество саммари vs gpt-oss.
3. Кап входа + warning (плохо для 4ч — теряем половину).
**Решение по обсуждению с юзером:** «возможно поменяем модель под такие кейсы».

### ISS-2 · Падение одного чанка убивает всю длинную запись (нет per-chunk resilience)
**Status:** 🔵 needs-verify — реализовано 2026-06-10: try/except вокруг каждого
`call.get()`, упавший чанк → лог + локализованный gap-маркер в транскрипте
(`SPEAKER_UNKNOWN`), прогресс отдаёт `chunks_failed`. Все чанки упали → error.
**Где:** `modal_app.py` → `transcribe_long` (сбор результатов, `call.get()`)
**Симптом:** 4ч запись «сломалась через 15-20 мин, вылезла ошибка». Аплоад был
ок (130 МБ). Скорее всего один из ~12 чанков упал (OOM/исключение), а оркестратор
делает `call.get()` без обработки — исключение всплывает и **валит всю джобу**.
**Фикс:** обернуть каждый `call.get()` в try/except — если чанк упал (после
Modal-retry), залогировать и **пропустить** (отдать транскрипт с одним пропуском
~20 мин), а не терять всю 4ч запись. Лучше частичный результат, чем ничего.

---

## 🟡 P1 — важно (скорость / надёжность длинных записей)

### ISS-3 · 4ч запись обрабатывается ~30 мин (медленно)
**Status:** 🔵 needs-verify — фикс 1 реализован 2026-06-10: планировщик целится
в ≤`MAX_PARALLEL_CHUNKS` (10) чанков, кап `MAX_CHUNK_LEN_S` (1800с) → 4ч = одна
волна 10×24-мин (~2x wall-clock). Фикс 2 (облегчить Whisper) намеренно НЕ
сделан — юзер придержал. Фикс 3 (лимит GPU) — ждёт запроса в Modal.
**Корень:** (а) лимит 10 GPU → 12 чанков идут 2 волнами; (б) тяжёлые настройки
Whisper (beam=3, best_of=3, 6-step temperature).
**Фиксы (по убыванию эффекта):**
1. **Чанки в 1 волну** — динамически резать на ≤`MAX_PARALLEL` (10) кусков (для
   4ч ~24-мин чанки) → одна волна → ~2x. Без потери качества. Кап длины чанка
   под Transcriptor timeout (1200с). `modal_app.py` `_plan_chunk_boundaries`.
2. **Облегчить Whisper для long-пайплайна** (`transcribe_chunk`): beam=2/best_of=1/
   3-step temperature → ещё ~2x. Юзер пока придержал (trade-off качество).
3. Запросить у Modal **лимит >10 GPU** (бесплатно).

### ISS-4 · Таймауты под очень длинные записи
**Status:** 🟢 done (in code, 2026-06-10) — фронт 60→120 мин, оркестратор
2ч→4ч, Transcriptor 20→40 мин (запас под длинные чанки + best-quality).
**Где:** фронт `pollJob` long-таймаут **60 мин** (`templates/index.html`);
оркестратор `transcribe_long` timeout **7200с (2ч)** (`modal_app.py`).
**Риск:** при сериализации чанков (лимит GPU) 4ч+ может упереться. Поднять:
фронт 60→120 мин, оркестратор 2ч→4ч. Безопасно.

### ISS-5 · Фронтовая оценка времени обработки врёт для длинных записей
**Status:** 🔴 open
**Где:** `templates/index.html` `PIPELINE_DEF` (est `d/15`, `d/10`).
**Симптом:** показывает «15.5 мин на транскрипцию» по старой монолитной формуле,
не учитывает параллельный chunked-пайплайн → пугает завышенными числами.
**Фикс:** для long-режима считать оценку иначе (по числу чанков/волн) или убрать
конкретные минуты, показывать «chunk k/N» (уже есть).

---

## 🟢 P1 — done (этой сессией, для контекста)

### ISS-6 · Саммари с украинскими заголовками на не-укр записи — 🟢 FIXED (deployed)
Шаблоны `GENERATE_TEMPLATES` хардкодили двуязычные UA/EN заголовки секций
(«Контекст / Context») → текли в любое саммари. Теперь заголовки на языке
транскрипта (англ. лейблы в спеке + инструкция локализовать). `app.py`.

### ISS-7 · Лендинг вводил в заблуждение «только UA/EN» — 🟢 FIXED (deployed)
Было «Ukrainian + English / UA · EN» (запутало польскую клиентку). Стало
«Polish · EN · UA · RU», убрана выдуманная «Ukrainian-tuned acoustic model».
`landing/lib/content.ts` (EN + UA).

### ISS-8 · Speaker clustering склеивал похожие голоса — 🔵 needs-verify
2026-06-10 переработано структурно: собственная агломеративка с **cannot-link**
(спикеры одного чанка не сливаются — блокирует склейку похожих голосов), порог
поднят 0.55→0.68 (лечит **дубли на швах**), до 6 эмбеддингов на спикера вместо
одного центроида, форс-merge фантомов при явном num_speakers. sklearn выкинут
из orchestrator image. Тесты tests/test_speaker_clustering.py. Проверить на
реальном звонке 1-на-1 по логам `[long] centroid_cos_dist min=…`.

---

## 🔵 P2 — качество / полировка

### ISS-9 · Whisper галлюцинирует на повторяющемся контенте
**Status:** 🔵 needs-verify — `hallucination_silence_threshold=2.0`
(`HALLUCINATION_SILENCE_S` env) добавлен в оба transcribe-вызова 2026-06-10.
Gemini-чистку полностью мусорных сегментов пока не трогали.
**Симптом:** на уроке польского (дикие повторы фраз) 2 сегмента — мультиязычная
каша (китайские иероглифы, испанский/итальянский). На обычных созвонах редко.
**Фикс:** добавить `hallucination_silence_threshold` в whisper.transcribe + тюнинг.
Опционально: Gemini-correction должен чистить полностью-мусорные сегменты (сейчас
консервативен).

### ISS-10 · Redesign лендинга
**Status:** 🔴 open (нет конкретного направления)
Юзеру не нравится текущий стиль лендоса. Идей пока нет. Возможные направления:
выровнять под Studio v2 (mint/Bricolage/Manrope, см. `docs/DESIGN_V2.md`) или
свежее. Возможно через Google Stitch. Обсудить когда появятся идеи.

---

## 🔵 P3 — условные / на будущее

### ISS-11 · Resumable upload (>250МБ файлы)
**Status:** 🔴 conditional. 130МБ грузится ок. Если большие файлы упрутся в лимит
тела Modal — Supabase Storage + tus. Phase 4 long-recording (ROADMAP).

### ISS-12 · Подключить Linear для трекинга задач
**Status:** 🔴 planned. Юзер хочет подцепить Linear, чтобы загружать туда таски
и Claude их видел. Пока — этот файл.

---

## 🟢 Sprint 8 — done (2026-06-14)

### ISS-13 · Downgrade кнопки ничего не делали
**Status:** 🟢 done — `openPortal()` (Stripe Customer Portal) отделена от `startCheckout()` (Checkout). Downgrade/manage → Portal. `loadingPortal` state предотвращает двойной клик. `SettingsModal.tsx`.

### ISS-14 · Workspace Create постоянно disabled без Team-плана
**Status:** 🟢 done — кнопка `disabled` только при пустом имени или в процессе создания. Без Team-плана: клик → upsell-баннер (`.i-team-upsell-banner`) + glow на Team-карточке (`.team-upsell-glow`), навигация в Subscription таб. `SettingsModal.tsx`.

### ISS-15 · Settings модалка слишком маленькая на десктопе
**Status:** 🟢 done — `.i-modal.i-modal-wide` теперь `880×580px` (было ~480px). Нав `180px`, контент `padding: 32px`. `ink.css`.

### ISS-16 · Нет самостоятельного удаления аккаунта (GDPR)
**Status:** 🟢 done — Danger Zone → «Видалити акаунт»: двойное подтверждение (3с auto-cancel), `deleteAccount()` в `api.ts` (DELETE /api/profile), потом `sb.auth.signOut()` + redirect `/`. `SettingsModal.tsx`, `api.ts`.

### ISS-17 · DotField — статичный фон, слабая реакция на курсор
**Status:** 🟢 done — Spring/velocity физика для курсора (MOUSE_SPRING=0.12, MOUSE_DAMP=0.78), MOUSE_R 150→185 (+23%), MOUSE_DISP 4→6. Cloud sinusoid t-multipliers +35% — дыхание заметно без движения. `DotField.tsx`.
