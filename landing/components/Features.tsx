import type { Copy } from "@/lib/content";

export function Features({ t }: { t: Copy }) {
  return (
    <section className="s" id="features">
      <div className="wrap">
        <div className="s-head reveal">
          <span className="eyebrow">{t.features.eyebrow}</span>
          <h2 className="display xxl">{t.features.title}</h2>
          <p className="lede">{t.features.sub}</p>
        </div>
        <div className="features">
          {t.features.items.map((f, i) => (
            <article
              key={i}
              className={"feature-card reveal" + (f.accent ? " accent" : "")}
              style={{ transitionDelay: `${(i % 3) * 60}ms` }}
            >
              <span className="ico">{f.tag}</span>
              <h3>{f.h}</h3>
              <p>{f.p}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
