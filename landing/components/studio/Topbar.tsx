"use client";
import { useEffect, useState } from "react";

// Topbar: eyebrow + title слева, History/Theme toggles справа

export function Topbar({
  eyebrow,
  title,
  meta,
  onToggleHistory,
}: {
  eyebrow: string;
  title: string;
  meta?: string;
  onToggleHistory?: () => void;
}) {
  return (
    <div className="s-topbar">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>
          {title}
          {meta && <span className="meta"> — {meta}</span>}
        </h1>
      </div>
      <div className="s-topbar-actions">
        <button type="button" className="s-btn" onClick={onToggleHistory}>
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="6.5" cy="6.5" r="5.5" />
            <path d="M6.5 3.5v3l2 1.5" />
          </svg>
          History
        </button>
        <StudioThemeToggle />
      </div>
    </div>
  );
}

// Local theme toggle для Studio (отличается визуально от Landing toggle).
// Использует ту же data-theme систему — переключение глобальное.
function StudioThemeToggle() {
  const [theme, setTheme] = useState<"light" | "dark">("light");

  useEffect(() => {
    const current = (document.documentElement.getAttribute("data-theme") || "light") as "light" | "dark";
    setTheme(current);
  }, []);

  const toggle = () => {
    const next = theme === "light" ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("skriptly-theme", next); } catch {}
    setTheme(next);
  };

  return (
    <button type="button" className="s-btn" onClick={toggle} aria-label="Toggle theme">
      {theme === "light" ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
        </svg>
      )}
      {theme === "light" ? "Dark" : "Light"}
    </button>
  );
}
