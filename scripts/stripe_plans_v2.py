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

Flask находит новые цены по lookup_key (app.py → _stripe_price_id), секрет
stripe-secrets менять не нужно.

Запуск в Modal с ключом из секрета stripe-secrets (локально ключ не нужен):
  modal run scripts/stripe_plans_v2.py            # сухой прогон
  modal run scripts/stripe_plans_v2.py --apply    # создать
Повторный запуск безопасен: цена с тем же lookup_key не создаётся второй раз.
"""
import os

TAX_CODE = "txcd_10103001"  # Software as a service (SaaS) - business use

PRICES = [
    # lookup_key,        product, interval, USD cents, UAH kopecks
    ("pro_monthly_v2",  "pro",  "month", 1200,  24900),
    ("pro_annual_v2",   "pro",  "year",  10800, 239000),
    ("team_monthly_v2", "team", "month", 1400,  22900),
    ("team_annual_v2",  "team", "year",  13200, 219000),
]


def run(apply: bool) -> list[str]:
    import stripe

    stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
    out: list[str] = []
    acct = stripe.Account.retrieve()
    out.append(f"account {acct.id}: country={acct.country} default_currency={acct.default_currency} "
               f"livemode_key={stripe.api_key.startswith('sk_live')}")
    try:
        banks = stripe.Account.list_external_accounts(acct.id, limit=10).data
        out.append("payout accounts: " + ", ".join(f"{b.object}:{b.currency}" for b in banks))
    except Exception as e:
        out.append(f"payout accounts: n/a ({e})")

    products = {
        "pro": stripe.Price.retrieve(os.environ["STRIPE_PRO_MONTHLY_PRICE"]).product,
        "team": stripe.Price.retrieve(os.environ["STRIPE_TEAM_MONTHLY_PRICE"]).product,
    }
    for name, pid in products.items():
        prod = stripe.Product.retrieve(pid)
        out.append(f"{name}: product {pid} «{prod.name}» tax_code={getattr(prod, 'tax_code', None)}")
        if getattr(prod, "tax_code", None) != TAX_CODE:
            out.append(f"  -> tax_code {TAX_CODE}")
            if apply:
                stripe.Product.modify(pid, tax_code=TAX_CODE)

    existing = {p.lookup_key: p for p in
                stripe.Price.list(lookup_keys=[k for k, *_ in PRICES], limit=10).auto_paging_iter()}
    for key, product, interval, usd, uah in PRICES:
        if key in existing:
            out.append(f"{key}: already exists ({existing[key].id})")
            continue
        out.append(f"{key}: create ${usd / 100:g} / {interval} + {uah / 100:g} UAH")
        if apply:
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
            out.append(f"  -> {price.id}")
    if not apply:
        out.append("Dry run. Add --apply to create.")
    return out


try:
    import modal

    app = modal.App("skriptly-stripe-plans-v2")

    @app.function(image=modal.Image.debian_slim(python_version="3.11").pip_install("stripe>=12"),
                  secrets=[modal.Secret.from_name("stripe-secrets")])
    def remote(apply: bool = False) -> list[str]:
        return run(apply)

    @app.local_entrypoint()
    def main(apply: bool = False):
        print("\n".join(remote.remote(apply)))
except ImportError:
    pass
