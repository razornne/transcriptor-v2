"use client";
import type { Copy, Lang } from "@/lib/content";
import { Logo } from "./Logo";
import { SegToggle } from "./SegToggle";

export function Footer({ t, lang, setLang }: { t: Copy; lang: Lang; setLang: (l: Lang) => void }) {
  return (
    <footer className="foot">
      <div className="wrap foot-inner">
        <div style={{ display: "flex", gap: 18, alignItems: "center", flexWrap: "wrap" }}>
          <Logo />
          <span style={{ color: "var(--faint)" }}>{t.foot.copy}</span>
        </div>
        <div className="foot-links">
          {t.foot.links.map((l, i) => {
            // foot.links order: [Features, Pricing, App, Privacy, Terms] (en/ua)
            const hrefs = ["#features", "#pricing", "/app", "/privacy", "/terms"];
            const isLegal = i >= 3;
            return (
              <a
                key={i}
                href={hrefs[i] || "#"}
                style={isLegal ? { color: "var(--faint)", fontSize: 13 } : undefined}
              >
                {l}
              </a>
            );
          })}
        </div>
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
