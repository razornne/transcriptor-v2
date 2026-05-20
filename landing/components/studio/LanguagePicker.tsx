"use client";
import { useState } from "react";

// Inline segmented language picker — "Lang | EN | RU | UK | Auto ▾"
// Primary languages — pills. "Auto" с dropdown для остальных (de/fr/es/...).

const PRIMARY = [
  { code: "en", label: "EN" },
  { code: "ru", label: "RU" },
  { code: "uk", label: "UK" },
];

const EXTRA = [
  { code: "",   label: "Auto-detect", short: "AUTO" },
  { code: "de", label: "Deutsch",     short: "DE" },
  { code: "fr", label: "Français",    short: "FR" },
  { code: "es", label: "Español",     short: "ES" },
];

export function LanguagePicker({
  value,
  onChange,
}: {
  value: string;
  onChange?: (code: string) => void;
}) {
  const [open, setOpen] = useState(false);
  // Если value не из primary — показываем его как "Auto" с подписью
  const isPrimary = PRIMARY.some((l) => l.code === value);
  const extraActive = !isPrimary;
  const extraSelected = EXTRA.find((l) => l.code === value) ?? EXTRA[0];

  return (
    <div className="s-langpick" role="group" aria-label="Language">
      <span className="s-langpick-label">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="6" cy="6" r="5" />
          <path d="M1 6h10M6 1c1.5 1.5 2.3 3.2 2.3 5s-.8 3.5-2.3 5C4.5 9.5 3.7 7.8 3.7 6S4.5 2.5 6 1z" />
        </svg>
        Lang
      </span>

      {PRIMARY.map((lang) => (
        <button
          key={lang.code}
          type="button"
          className={"s-langpick-btn" + (value === lang.code ? " on" : "")}
          onClick={() => onChange?.(lang.code)}
        >
          {lang.label}
        </button>
      ))}

      {/* Auto + extras → dropdown */}
      <div style={{ position: "relative" }}>
        <button
          type="button"
          className={"s-langpick-more" + (extraActive ? " on" : "")}
          onClick={() => setOpen((v) => !v)}
          style={extraActive ? { color: "var(--s-accent)", fontWeight: 600 } : undefined}
        >
          {extraSelected.short}
          <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M1.5 3l2.5 2.5L6.5 3" />
          </svg>
        </button>

        {open && (
          <>
            <div
              style={{ position: "fixed", inset: 0, zIndex: 20 }}
              onClick={() => setOpen(false)}
            />
            <div
              style={{
                position: "absolute",
                top: "calc(100% + 6px)",
                right: 0,
                minWidth: 200,
                padding: 4,
                background: "var(--s-bg)",
                border: "1px solid var(--s-border-hi)",
                borderRadius: "var(--s-r-md)",
                boxShadow: "0 12px 32px -8px rgba(0,0,0,0.18)",
                zIndex: 21,
              }}
            >
              {EXTRA.map((lang) => (
                <button
                  key={lang.code || "auto"}
                  type="button"
                  onClick={() => {
                    onChange?.(lang.code);
                    setOpen(false);
                  }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    width: "100%",
                    padding: "8px 10px",
                    border: "none",
                    borderRadius: "var(--s-r-sm)",
                    background: lang.code === value ? "var(--s-accent-soft)" : "transparent",
                    color: lang.code === value ? "var(--s-accent)" : "var(--s-ink)",
                    fontSize: 13,
                    fontWeight: lang.code === value ? 600 : 400,
                  }}
                >
                  <span>{lang.label}</span>
                  <span style={{ fontFamily: "var(--s-mono)", fontSize: 10, color: "var(--s-mute)" }}>
                    {lang.short}
                  </span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
