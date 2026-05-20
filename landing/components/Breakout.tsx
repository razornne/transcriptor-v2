import { Fragment } from "react";
import type { Copy } from "@/lib/content";

export function Breakout({ t }: { t: Copy }) {
  return (
    <section className="breakout">
      <div className="wrap">
        <div className="s-head reveal" style={{ marginBottom: 28 }}>
          <span className="eyebrow">{t.breakout.eyebrow}</span>
          <h2 className="display xl">{t.breakout.title}</h2>
          <p className="lede">{t.breakout.sub}</p>
        </div>
        <div className="breakout-frame reveal">
          <div className="breakout-mock">
            <aside className="side">
              {t.breakout.history.map((sec) => (
                <Fragment key={sec.label}>
                  <div className="lab">{sec.label}</div>
                  {sec.rows.map((r, i) => (
                    <div key={i} className={"side-item" + (r.on ? " on" : "")}>
                      <span
                        className="dot"
                        style={{ background: r.on ? "var(--rec)" : "var(--ground-3)" }}
                      />
                      <span className="name">{r.name}</span>
                      <span className="when">{r.when}</span>
                    </div>
                  ))}
                </Fragment>
              ))}
            </aside>
            <div className="main">
              <div className="mock-head">
                <span className="eyebrow">{t.mock.eyebrow}</span>
                <div className="right">
                  <span className="pill"><span className="dot live" />REC · {t.mock.rec}</span>
                  <span className="pill" style={{ background: "rgba(63,101,221,0.10)", color: "var(--cta)" }}>{t.mock.langPill}</span>
                </div>
              </div>
              <div className="tx" style={{ gap: 18 }}>
                {t.mock.lines.map((l, i) => (
                  <div className="tx-line" key={i}>
                    <span className={"spk-dot spk-" + l.spk}>S{l.spk}</span>
                    <div>
                      <div className="tx-meta"><b>{l.name}</b>{l.time}</div>
                      <div className={"tx-text" + (l.live ? " tx-cursor" : "")}>{l.text}</div>
                    </div>
                  </div>
                ))}
              </div>
              <div className="mock-summary">
                <span className="eyebrow">{t.mock.summaryLabel}</span>
                <ul>
                  {t.mock.summary.map((s, i) => <li key={i}>{s}</li>)}
                </ul>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
