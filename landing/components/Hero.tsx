"use client";
import type { Copy } from "@/lib/content";
import { AppMock } from "./AppMock";

export function Hero({ t, headlineLines }: { t: Copy; headlineLines: string[] }) {
  return (
    <section className="hero" id="top">
      <div className="wrap">
        <div className="hero-shell">
          <div className="hero-inner">
            <div className="hero-copy">
              <span className="eyebrow hero-entrance">
                <span className="rec-dot live" aria-hidden="true" />
                {t.hero.eyebrow}
              </span>
              <h1 className="hero-headline hero-entrance">
                {headlineLines.map((ln, i) => (
                  <span
                    key={i}
                    style={{ display: "block" }}
                    className={
                      i === headlineLines.length - 1
                        ? "display xxxl editorial"
                        : "display xxxl"
                    }
                  >
                    {ln}
                  </span>
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
              <AppMock mock={t.mock} animate />
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
