import type { Copy } from "@/lib/content";

// Каждая иллюстрация — кусочек реального UI продукта, не иконка.
function StepArt({ idx }: { idx: number }) {
  if (idx === 0) {
    return (
      <div className="step-art" style={{ padding: 18, display: "grid", alignContent: "center", justifyItems: "center", gap: 10 }}>
        <div
          style={{
            fontFamily: "var(--mono)", fontSize: 12, color: "var(--muted)",
            background: "var(--card-bg)", padding: "6px 10px",
            borderRadius: 8, border: "1px solid var(--hairline)",
          }}
        >https://skriptly.io/app</div>
        <div
          style={{
            width: "82%", height: 8, borderRadius: 4,
            background: "linear-gradient(to right, var(--cta) 60%, var(--hairline) 60%)",
          }}
        />
        <div style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--faint)", letterSpacing: ".08em" }}>
          LOADING APP · 0.4S
        </div>
      </div>
    );
  }
  if (idx === 1) {
    return (
      <div className="step-art" style={{ padding: 18, display: "grid", alignContent: "center", justifyItems: "center", gap: 12 }}>
        <div
          style={{
            width: 56, height: 56, borderRadius: "50%",
            background: "var(--cta)", color: "white",
            display: "grid", placeItems: "center",
            boxShadow: "0 0 0 8px rgba(63,101,221,0.18), 0 0 0 18px rgba(63,101,221,0.08)",
            fontFamily: "var(--mono)", fontWeight: 600, fontSize: 22,
          }}
        >●</div>
        <div style={{ display: "flex", gap: 3, alignItems: "end", height: 28 }}>
          {[10, 18, 24, 14, 26, 20, 12, 22, 16, 28, 18, 10].map((h, i) => (
            <span key={i} style={{ width: 4, height: h, borderRadius: 2, background: "var(--ink-2)" }} />
          ))}
        </div>
        <div style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--faint)", letterSpacing: ".08em" }}>
          MIC · TAB AUDIO
        </div>
      </div>
    );
  }
  return (
    <div className="step-art" style={{ padding: 18, display: "grid", alignContent: "center", gap: 10 }}>
      <div style={{ display: "grid", gridTemplateColumns: "20px 1fr", gap: 8, alignItems: "start" }}>
        <span style={{ width: 16, height: 16, borderRadius: "50%", background: "var(--speaker-1)", display: "inline-block", marginTop: 2 }} />
        <div style={{ height: 6, borderRadius: 3, background: "var(--ink-2)", width: "85%" }} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "20px 1fr", gap: 8, alignItems: "start" }}>
        <span style={{ width: 16, height: 16, borderRadius: "50%", background: "var(--speaker-2)", display: "inline-block", marginTop: 2 }} />
        <div style={{ display: "grid", gap: 4 }}>
          <div style={{ height: 6, borderRadius: 3, background: "var(--ink-2)", width: "92%" }} />
          <div style={{ height: 6, borderRadius: 3, background: "var(--ink-2)", width: "70%" }} />
        </div>
      </div>
      <div
        style={{
          marginTop: 4, fontFamily: "var(--mono)", fontSize: 10.5,
          color: "var(--cta)", letterSpacing: ".08em",
        }}
      >✓ SUMMARY READY · MARKDOWN ↓</div>
    </div>
  );
}

export function HowItWorks({ t }: { t: Copy }) {
  return (
    <section className="s" id="how">
      <div className="wrap">
        <div className="s-head reveal">
          <span className="eyebrow">{t.how.eyebrow}</span>
          <h2 className="display xxl">{t.how.title}</h2>
          <p className="lede">{t.how.sub}</p>
        </div>
        <div className="steps">
          {t.how.steps.map((s, i) => (
            <div className="step reveal" key={i} style={{ transitionDelay: `${i * 80}ms` }}>
              <StepArt idx={i} />
              <div className="num">{s.n}</div>
              <h3>{s.h}</h3>
              <p>{s.p}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
