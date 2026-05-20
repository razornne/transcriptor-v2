import type { Copy } from "@/lib/content";

// 4 плана (Free / Pro / Max / Team). Annual toggle убран — все цены
// сейчас monthly. Когда добавим годовые — вернём SegToggle + TweenedPrice.

export function Pricing({ t }: { t: Copy }) {
  return (
    <section className="s" id="pricing">
      <div className="wrap">
        <div className="s-head reveal">
          <span className="eyebrow">{t.pricing.eyebrow}</span>
          <h2 className="display xxl">{t.pricing.title}</h2>
          <p className="lede">{t.pricing.sub}</p>
        </div>

        <div className="pricing-grid">
          {t.pricing.plans.map((p, i) => (
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
                <span className="amt">${p.price}</span>
                <span className="per">{p.per}</span>
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
          ))}
        </div>
      </div>
    </section>
  );
}
