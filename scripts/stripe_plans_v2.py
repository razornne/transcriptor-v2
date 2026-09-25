"""Цены Stripe для тарифов v2 (2026-09-25) + подготовка к Managed Payments.

Создаёт 4 новые цены на существующих продуктах Pro и Team (цены в Stripe
неизменяемы — старые $15/$14 остаются для истории, новые покупки идут по новым):

  pro_monthly_v2   $12 / мес      ·  249 ₴
  pro_annual_v2    $108 / год     ·  2 390 ₴   (= $9 и ≈ 199 ₴ в месяц)
  team_monthly_v2  $14 / место    ·  229 ₴
  team_annual_v2   $132 / место   ·  2 190 ₴   (= $11 и ≈ 183 ₴ в месяц)

Гривны — currency_options той же цены: Checkout сам показывает ₴ покупателям
из Украины, остальным Adaptive Pricing конвертирует доллары. Цены включают
налог (tax_behavior=inclusive) — покупатель платит ровно показанную сумму,
VAT Stripe вычитает из неё. Продуктам ставится налоговый код SaaS
(txcd_10103001) — без него Managed Payments не примет Checkout.

Запуск (ключ — live secret key из Stripe Dashboard → Developers → API keys):
  $env:STRIPE_SECRET_KEY = "sk_live_..."
  $env:STRIPE_PRO_MONTHLY_PRICE = "price_..."    # текущие, из секрета stripe-secrets:
  $env:STRIPE_TEAM_MONTHLY_PRICE = "price_..."   # по ним находим продукты Pro и Team
  python scripts/stripe_plans_v2.py            # сухой прогон: что будет создано
  python scripts/stripe_plans_v2.py --apply    # создать

Повторный запуск безопасен: цена с тем же lookup_key не создаётся второй раз.
"""
import os
import sys

import stripe

TAX_CODE = "txcd_10103001"  # Software as a service (SaaS) - business use

PRICES = [
    # lookup_key,        product, interval, USD cents, UAH kopecks
    ("pro_monthly_v2",  "pro",  "month", 1200,  24900),
    ("pro_annual_v2",   "pro",  "year",  10800, 239000),
    ("team_monthly_v2", "team", "month", 1400,  22900),
    ("team_annual_v2",  "team", "year",  13200, 219000),
]

ENV_NAMES = {
    "pro_monthly_v2": "STRIPE_PRO_MONTHLY_PRICE",
    "pro_annual_v2": "STRIPE_PRO_ANNUAL_PRICE",
    "team_monthly_v2": "STRIPE_TEAM_MONTHLY_PRICE",
    "team_annual_v2": "STRIPE_TEAM_ANNUAL_PRICE",
}


def main() -> None:
    apply = "--apply" in sys.argv
    stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
    products = {
        "pro": stripe.Price.retrieve(os.environ["STRIPE_PRO_MONTHLY_PRICE"]).product,
        "team": stripe.Price.retrieve(os.environ["STRIPE_TEAM_MONTHLY_PRICE"]).product,
    }
    for name, pid in products.items():
        prod = stripe.Product.retrieve(pid)
        print(f"{name}: product {pid} «{prod.name}» tax_code={prod.get('tax_code')}")
        if prod.get("tax_code") != TAX_CODE:
            print(f"  → tax_code {TAX_CODE}")
            if apply:
                stripe.Product.modify(pid, tax_code=TAX_CODE)

    existing = {p.lookup_key: p for p in
                stripe.Price.list(lookup_keys=[k for k, *_ in PRICES], limit=10).auto_paging_iter()}
    ids = {}
    for key, product, interval, usd, uah in PRICES:
        if key in existing:
            ids[key] = existing[key].id
            print(f"{key}: already exists ({ids[key]})")
            continue
        print(f"{key}: create ${usd / 100:g} / {interval} + {uah / 100:g} UAH")
        if not apply:
            continue
        price = stripe.Price.create(
            product=products[product],
            currency="usd",
            unit_amount=usd,
            recurring={"interval": interval},
            tax_behavior="inclusive",
            currency_options={"uah": {"unit_amount": uah, "tax_behavior": "inclusive"}},
            lookup_key=key,
            nickname=key,
        )
        ids[key] = price.id

    if not apply:
        print("\nDry run. Add --apply to create.")
        return
    print("\nNew price IDs for the stripe-secrets Modal secret:")
    for key, env in ENV_NAMES.items():
        print(f"  {env}={ids[key]}")


if __name__ == "__main__":
    main()
