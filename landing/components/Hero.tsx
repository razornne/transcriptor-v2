"use client";
import type { Copy } from "@/lib/content";
import { useParallax } from "@/lib/hooks";
import { AppMock } from "./AppMock";

export function Hero({ t, headlineLines }: { t: Copy; headlineLines: string[] }) {
  // Параллакс light-blobs за курсором (направления + амплитуды).
  useParallax(".hero-light .lite", [22, -26, 34]);

  return (
    <section className="hero" id="top">
      <div className="hero-light" aria-hidden="true">
        <span className="lite lite-1" />
        <span className="lite lite-2" />
        <span className="lite lite-3" />
      </div>
      <div className="wrap">
        <div className="hero-shell">
          <div className="hero-inner">
            <div className="hero-copy">
              <span className="eyebrow hero-entrance">{t.hero.eyebrow}</span>
              <h1 className="display xxxl hero-headline hero-entrance">
                {headlineLines.map((ln, i) => (
                  <span key={i} style={{ display: "block" }}>{ln}</span>
                ))}
              </h1>
              <p className="lede hero-sub hero-entrance">{t.hero.sub}</p>
              <div className="hero-ctas hero-entrance">
                <a className="btn btn-primary btn-lg" href="/app">{t.hero.ctaPrimary}</a>
                <a className="btn btn-ghost btn-lg" href="#how">{t.hero.ctaSecondary}</a>
              </div>
              <div className="hero-meta hero-entrance">
                {t.hero.meta.map(([k, v], i) => (
                  <span key={i}>{k} <b>{v}</b></span>
                ))}
              </div>
            </div>

            <div className="hero-visual hero-entrance" style={{ position: "relative" }}>
              <div className="mock-frame glass">
                <AppMock mock={t.mock} animate />
              </div>
              <div className="mock-chip">
                <span className="ico">∑</span>
                <span>{t.mock.chip}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
