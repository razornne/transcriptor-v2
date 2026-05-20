"use client";
import { useState } from "react";
import { SUPPORTED_LANGUAGES } from "@/lib/studio/mock-data";

// Phase 1 — простой custom dropdown. Phase 4: подцепим к state записи.

export function LanguagePicker({
  value,
  onChange,
}: {
  value: string;
  onChange?: (code: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = SUPPORTED_LANGUAGES.find((l) => l.code === value) ?? SUPPORTED_LANGUAGES[0];

  return (
    <div style={{ position: "relative" }}>
      <button
        type="button"
        className="s-pill"
        onClick={() => setOpen((v) => !v)}
        style={{ paddingRight: 10 }}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="6" cy="6" r="5" />
          <path d="M1 6h10M6 1c1.5 1.5 2.3 3.2 2.3 5s-.8 3.5-2.3 5C4.5 9.5 3.7 7.8 3.7 6S4.5 2.5 6 1z" />
        </svg>
        <span>{selected.label}</span>
        <span style={{ fontFamily: "var(--s-mono)", fontSize: 10, color: "var(--s-mute)" }}>
          {selected.short}
        </span>
      </button>

      {open && (
        <>
          {/* Backdrop — клик закрывает */}
          <div
            style={{ position: "fixed", inset: 0, zIndex: 10 }}
            onClick={() => setOpen(false)}
          />
          <div
            style={{
              position: "absolute",
              top: "calc(100% + 6px)",
              left: 0,
              minWidth: 200,
              padding: 4,
              background: "var(--s-bg)",
              border: "1px solid var(--s-border-hi)",
              borderRadius: "var(--s-r-md)",
              boxShadow: "0 12px 32px -8px rgba(0,0,0,0.18)",
              zIndex: 11,
            }}
          >
            {SUPPORTED_LANGUAGES.map((lang) => (
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
  );
}
