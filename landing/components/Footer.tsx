"use client";
import type { Copy, Lang } from "@/lib/content";
import { Logo } from "./Logo";
import { SegToggle } from "./SegToggle";

export function Footer({ t, lang, setLang }: { t: Copy; lang: Lang; setLang: (l: Lang) => void }) {
  const hrefs = ["#features", "#pricing", "/app", "/privacy", "/terms"];
  return (
    <footer className="foot">
      <div className="wrap foot-inner">
        <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
          <Logo />
          <span style={{ color: "var(--graphite)", fontSize: 13 }}>{t.foot.copy}</span>
        </div>
        <nav className="foot-links" aria-label="Footer">
          {t.foot.links.map((l, i) => (
            <a
              key={i}
              href={hrefs[i] ?? "#"}
              style={i >= 3 ? { color: "var(--graphite)", fontSize: 13, opacity: 0.7 } : undefined}
            >
              {l}
            </a>
          ))}
        </nav>
        <SegToggle<Lang>
          ariaLabel="Language"
          value={lang}
          onChange={setLang}
          options={[
            { value: "en", label: "EN" },
            { value: "ua", label: "UA" },
          ]}
        />
      </div>
    </footer>
  );
}
