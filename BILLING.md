# Billing & Plans

Документация по планам, лимитам, Stripe интеграции и отслеживанию usage.

---

## Планы и лимиты

Определены в `PLAN_LIMITS` в `app.py`:

| План | Цена | Минуты/мес | Диаризация | AI tools | История |
|------|------|-----------|-----------|---------|---------|
| **Free** | $0 | 60 мин | ❌ (1 спикер) | ❌ | 5 записей |
| **Pro** | $15/мес или $12/мес annual | 600 мин | ✅ | ✅ | Безлимит |
| **Max** | $29/мес или $23/мес annual | 2000 мин | ✅ | ✅ + Best Quality | Безлимит |

> **Best Quality** (Max only) — Whisper large-v3 вместо large-v3-turbo. Включается чекбоксом в UI, отправляет `quality=best` в форме.

Лимиты **сбрасываются 1-го числа каждого месяца** автоматически при первом запросе (см. `_get_user_profile`).

---

## Хранение usage в Supabase

Таблица `public.user_profiles`:

| Поле | Тип | Описание |
|------|-----|---------|
| `id` | uuid | = `auth.users.id` |
| `plan` | text | `free` / `pro` / `max` |
| `minutes_used` | float | Использовано минут в текущем месяце |
| `minutes_reset_at` | timestamptz | Дата последнего сброса счётчика |
| `stripe_customer_id` | text | Stripe Customer ID (заполняется вебхуком) |
| `stripe_subscription_id` | text | Stripe Subscription ID |
| `vocabulary` | jsonb | Авто-словарь терминов (`[{term, freq, lang, last_seen}]`) |

---

## Как считаются минуты

1. Юзер загружает аудио → Flask спавнит `Transcriptor.transcribe_full.spawn()`
2. Фронт поллит `/api/jobs/<job_id>` каждые 2 секунды
3. Когда job возвращает `status: done` **первый раз** — Flask считает длительность:
   ```python
   duration_mins = max(s["end"] for s in segments) / 60
   _add_minutes(user_id, duration_mins)
   _tracked_jobs.add(job_id)  # in-memory set, не считаем дважды
   ```
4. `_add_minutes` делает `PATCH user_profiles` через Supabase service role key (обходит RLS)

**Важно:** `_tracked_jobs` — in-memory set на Flask контейнере. При рестарте контейнера теряется. В теории можно посчитать дважды при рестарте прямо во время polling. На MVP приемлемо, на scale — нужен Redis или флаг в DB.

---

## Проверка лимита

В двух местах:

### 1. До начала записи (фронтенд)
`startBtn` handler в `templates/index.html`:
- `currentMinutesUsed >= currentMinutesLimit` → блокируем, показываем upgrade prompt
- Осталось ≤ 30 мин → `confirm()` с предупреждением

`currentMinutesUsed` / `currentMinutesLimit` загружаются из `/api/profile` при логине.

### 2. При сабмите транскрипции (бэкенд)
`/api/transcribe` в `app.py`:
```python
if profile.get("minutes_used", 0) >= limits["minutes"]:
    return jsonify({"error": "...", "upgrade_required": True}), 402
```
Фронт ловит 402 в `submitJob` → показывает upgrade prompt.

---

## Stripe Flow

### Оформление подписки
```
Фронт: POST /api/stripe/checkout {plan: "pro", billing: "monthly"}
  → Flask создаёт Stripe Checkout Session
  → возвращает {url: "https://checkout.stripe.com/..."}
  → фронт редиректит на Stripe

Юзер оплачивает на Stripe

Stripe: POST /api/stripe/webhook (event: checkout.session.completed)
  → Flask проверяет подпись (STRIPE_WEBHOOK_SECRET)
  → PATCH user_profiles: plan=pro, minutes_used=0, stripe_customer_id=..., stripe_subscription_id=...
```

### Отмена / изменение подписки
```
Stripe: POST /api/stripe/webhook (event: customer.subscription.deleted)
  → Flask ищет профиль по stripe_customer_id
  → PATCH user_profiles: plan=free

Stripe: POST /api/stripe/webhook (event: customer.subscription.updated)
  → если status != active → plan=free
  → если status == active → plan=pro (TODO: различать pro и max)
```

### Управление подпиской (портал)
```
Фронт: POST /api/stripe/portal
  → Flask создаёт Stripe Billing Portal Session
  → возвращает {url: "https://billing.stripe.com/..."}
  → фронт редиректит — юзер меняет/отменяет подписку сам
```

---

## Настройка Stripe

### Один раз (создание продуктов)
1. Stripe Dashboard → Products → Add product
2. Создать два продукта: **Skriptly Pro** и **Skriptly Max**
3. Для каждого — два pricing: Monthly и Annual
4. Скопировать Price IDs → в Modal Secret и Vercel env

### Modal Secret (бэкенд)
```powershell
modal secret create transcriptor-secrets `
  HF_TOKEN=hf_... `
  SUPABASE_URL=https://... `
  SUPABASE_SERVICE_ROLE_KEY=eyJ... `
  GEMINI_API_KEY=AIza... `
  STRIPE_SECRET_KEY=sk_live_... `
  STRIPE_WEBHOOK_SECRET=whsec_... `
  STRIPE_PRO_MONTHLY_PRICE=price_... `
  STRIPE_PRO_ANNUAL_PRICE=price_... `
  STRIPE_MAX_MONTHLY_PRICE=price_... `
  STRIPE_MAX_ANNUAL_PRICE=price_... `
  --force
```
> **`--force` заменяет весь секрет целиком** — всегда указывай все переменные.

### Vercel Environment Variables (нужны для landing)
Не нужны — лендинг не работает с Stripe напрямую. Все запросы к Stripe идут через Modal Flask.

### Webhook endpoint
В Stripe Dashboard → Developers → Webhooks → Add endpoint:
- URL: `https://razornne--transcriptor-v2-flask-app.modal.run/api/stripe/webhook`
- Events: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`

---

## Известные ограничения (MVP)

- `_tracked_jobs` in-memory — при рестарте Flask контейнера минуты могут посчитаться дважды
- `customer.subscription.updated` не различает pro/max (всегда ставит pro при активной подписке). Нужно читать `metadata` или price_id из объекта подписки
- Нет email уведомления при приближении к лимиту (только UI предупреждение ≤30 мин)
- Нет server-side PostHog событий из webhook (`subscription_activated`, `subscription_cancelled`)
