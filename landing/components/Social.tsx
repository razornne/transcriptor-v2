import type { Copy } from "@/lib/content";

export function Social({ t }: { t: Copy }) {
  const dots = ["#C8513B", "#4F7A4A", "#3F65DD", "#B89357", "#7C5BAF"];
  return (
    <section className="social">
      <div className="wrap social-inner reveal">
        <blockquote>
          <span className="q">{t.social.quote}</span>
          <cite>{t.social.cite}</cite>
        </blockquote>
        <div style={{ display: "flex", gap: 18, alignItems: "center", color: "var(--muted)", fontSize: 13 }}>
          <span className="eyebrow">{t.social.firstUsers}</span>
          <span style={{ display: "inline-flex" }}>
            {dots.map((c, i) => (
              <span
                key={i}
                style={{
                  width: 32, height: 32, borderRadius: "50%",
                  background: c, border: "2px solid var(--ground)",
                  marginLeft: i === 0 ? 0 : -10,
                }}
              />
            ))}
          </span>
        </div>
      </div>
    </section>
  );
}
