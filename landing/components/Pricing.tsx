"use client";
import { useState } from "react";
import type { Copy } from "@/lib/content";
import { useTween } from "@/lib/hooks";
import { SegToggle } from "./SegToggle";

// 4 плана + sliding-pill переключатель Monthly/Annual.
// Цена плавно интерполируется через useTween.

function TweenedPrice({ target }: { target: number }) {
  const v = useTween(target, 280);
  return <>{Math.round(v)}</>;
}

type Billing = "monthly" | "annual";

export function Pricing({ t }: { t: Copy }) {
  const [billing, setBilling] = useState<Billing>("monthly");
  const annual = billing === "annual";

  return (
    <section className="s" id="pricing">
      <div className="wrap">
        <div className="s-head reveal">
          <span className="eyebrow">{t.pricing.eyebrow}</span>
          <h2 className="display xxl">{t.pricing.title}</h2>
          <p className="lede">{t.pricing.sub}</p>
        </div>

        <div className="reveal pricing-billing">
          <SegToggle<Billing>
            ariaLabel="Billing period"
            size="md"
            value={billing}
            onChange={setBilling}
            options={[
              { value: "monthly", label: t.pricing.monthly },
              { value: "annual",  label: t.pricing.annual },
            ]}
          />
          <span className={"save-badge" + (annual ? " on" : "")}>{t.pricing.save}</span>
        </div>

        <div className="pricing-grid">
          {t.pricing.plans.map((p, i) => {
            const price = annual ? p.annual : p.monthly;
            const showStrike = annual && p.monthly > p.annual;
            return (
              <article
                key={p.name}
                className={"pricing-card reveal" + (p.featured ? " featured" : "")}
                style={{ transitionDelay: `${i * 70}ms` }}
              >
                {p.badge && <span className="badge">{p.badge}</span>}
                <div>
                  <h3 className="plan-name">{p.name}</h3>
                  <div className="tagline">{p.tagline}</div>
                </div>
                <div className="price">
                  <span className="amt">$<TweenedPrice target={price} /></span>
                  <span className="per">{p.per}</span>
                  {showStrike && <span className="strike">${p.monthly}</span>}
                </div>
                <ul>
                  {p.features.map((f, j) => (
                    <li key={j}><span className="check">✓</span><span>{f}</span></li>
                  ))}
                </ul>
                <div>
                  <a
                    className={"btn " + (p.ctaKind === "primary" ? "btn-primary" : "btn-ghost")}
                    href="/app"
                    style={{ width: "100%", justifyContent: "center" }}
                  >
                    {p.cta}
                  </a>
                  {p.fine && <div className="fine" style={{ marginTop: 10 }}>{p.fine}</div>}
                </div>
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}
