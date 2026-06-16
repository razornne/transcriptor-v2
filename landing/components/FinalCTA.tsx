import type { Copy } from "@/lib/content";

export function FinalCTA({ t }: { t: Copy }) {
  return (
    <section className="final" id="start">
      <div className="wrap reveal">
        <h2 className="final-headline">
          {t.final.title.map((ln, i) => (
            <span
              key={i}
              style={{ display: "block" }}
              className={
                i === t.final.title.length - 1
                  ? "display xxxl editorial"
                  : "display xxxl"
              }
            >
              {ln}
            </span>
          ))}
        </h2>
        <div className="ctas">
          <a className="btn btn-primary btn-lg" href="/app">{t.final.ctaPrimary}</a>
          <a className="btn btn-ghost btn-lg" href="/app">{t.final.ctaSecondary}</a>
        </div>
        <div className="fine">{t.final.fine}</div>
      </div>
    </section>
  );
}
