"use client";
import type { Copy, Lang } from "@/lib/content";
import { Logo } from "./Logo";
import { SegToggle } from "./SegToggle";
import { ThemeToggle } from "./ThemeToggle";

export function Nav({ t, lang, setLang }: { t: Copy; lang: Lang; setLang: (l: Lang) => void }) {
  return (
    <div className="nav-wrap">
      <nav className="nav glass strong">
        <Logo />
        <div className="nav-links" aria-label="Primary">
          <a href="#features">{t.nav.features}</a>
          <a href="#pricing">{t.nav.pricing}</a>
        </div>
        <div className="nav-right">
          <SegToggle<Lang>
            ariaLabel="Language"
            value={lang}
            onChange={setLang}
            options={[
              { value: "en", label: "EN" },
              { value: "ua", label: "UA" },
            ]}
          />
          <ThemeToggle />
          <a className="btn btn-primary" href="/app">
            {t.nav.openApp}
          </a>
        </div>
      </nav>
    </div>
  );
}
