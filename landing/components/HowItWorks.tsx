import type { Copy } from "@/lib/content";

function StepArt({ idx }: { idx: number }) {
  if (idx === 0) {
    return (
      <div className="step-art" style={{ padding: 20, display: "grid", alignContent: "center", justifyItems: "center", gap: 10 }}>
        <div style={{
          fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--graphite)",
          background: "var(--paper)", padding: "6px 12px",
          borderRadius: 8, border: "1px solid var(--hairline)",
          letterSpacing: "0.02em",
        }}>
          skriptly.io/app
        </div>
        <div style={{
          width: "80%", height: 6, borderRadius: 3,
          background: `linear-gradient(to right, var(--accent) 60%, var(--hairline) 60%)`,
        }} />
        <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--graphite)", letterSpacing: ".1em", textTransform: "uppercase" }}>
          Loading · 0.4s
        </div>
      </div>
    );
  }
  if (idx === 1) {
    const bars = [10, 18, 24, 14, 28, 20, 12, 24, 16, 28, 18, 10];
    return (
      <div className="step-art" style={{ padding: 20, display: "grid", alignContent: "center", justifyItems: "center", gap: 14 }}>
        <div style={{
          width: 52, height: 52, borderRadius: "50%",
          background: "var(--accent)", color: "white",
          display: "grid", placeItems: "center",
          boxShadow: "0 0 0 8px var(--ring)",
          fontFamily: "var(--mono)", fontWeight: 600, fontSize: 20,
        }}>●</div>
        <div style={{ display: "flex", gap: 3, alignItems: "flex-end", height: 28 }}>
          {bars.map((h, i) => (
            <span key={i} style={{ width: 4, height: h, borderRadius: 2, background: "var(--hairline)" }} />
          ))}
        </div>
        <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--graphite)", letterSpacing: ".1em", textTransform: "uppercase" }}>
          Mic · Tab audio
        </div>
      </div>
    );
  }
  return (
    <div className="step-art" style={{ padding: 20, display: "grid", alignContent: "center", gap: 10 }}>
      {[
        { color: "var(--spk-1)", widths: ["82%"] },
        { color: "var(--spk-2)", widths: ["92%", "70%"] },
      ].map((spk, si) => (
        <div key={si} style={{ display: "grid", gridTemplateColumns: "18px 1fr", gap: 8, alignItems: "start" }}>
          <span style={{ width: 14, height: 14, borderRadius: "50%", background: spk.color, display: "inline-block", marginTop: 3 }} />
          <div style={{ display: "grid", gap: 5 }}>
            {spk.widths.map((w, wi) => (
              <div key={wi} style={{ height: 6, borderRadius: 3, background: "var(--hairline)", width: w }} />
            ))}
          </div>
        </div>
      ))}
      <div style={{ marginTop: 6, fontFamily: "var(--mono)", fontSize: 10, color: "var(--accent)", letterSpacing: ".08em", textTransform: "uppercase" }}>
        ✓ Summary ready · Markdown ↓
      </div>
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
