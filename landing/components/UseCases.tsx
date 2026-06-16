"use client";
import { useState } from "react";
import type { Copy } from "@/lib/content";

export function UseCases({ t }: { t: Copy }) {
  const [active, setActive] = useState(0);
  const tab = t.useCases.tabs[active];

  return (
    <section className="usecases" id="use-cases">
      <div className="wrap">
        <div className="s-head reveal">
          <span className="eyebrow">{t.useCases.eyebrow}</span>
          <h2 className="display xxl">{t.useCases.title}</h2>
          <p className="lede">{t.useCases.sub}</p>
        </div>

        <div className="reveal">
          <div className="uc-tabbar" role="tablist" aria-label={t.useCases.eyebrow}>
            {t.useCases.tabs.map((tb, i) => (
              <button
                key={tb.label}
                role="tab"
                aria-selected={i === active}
                className={"uc-tab" + (i === active ? " on" : "")}
                onClick={() => setActive(i)}
              >
                {tb.label}
              </button>
            ))}
          </div>

          <div className="uc-panel" key={active} role="tabpanel">
            <div>
              <h3 className="uc-headline">{tab.headline}</h3>
              <ul className="uc-points">
                {tab.points.map((pt, i) => (
                  <li key={i}>{pt}</li>
                ))}
              </ul>
            </div>
            <div className="uc-quote-card">
              <p className="uc-quote-text">{tab.quote}</p>
              <div className="uc-author">{tab.author}</div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
