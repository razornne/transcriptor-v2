"use client";
import { forwardRef, useEffect, useRef, useState } from "react";

// InputCard — герой-объект главного экрана. Одна карточка принимает всё:
// набор текста, вставку, drag-and-drop файла (Phase 2), запись (Phase 2).
// Пресеты вывода универсальны (Summary / Action items / Clean text),
// Custom ▾ — пользовательские/командные промпты (mock в Phase 1).

const BASE_PRESETS = ["Summary", "Action items", "Clean text"] as const;

// Mock командных пресетов — реальные приедут из workspace.presets (Phase 2)
const MOCK_CUSTOM = [
  { name: "PAS ad copy", scope: "team" },
  { name: "Campaign brief", scope: "team" },
  { name: "Lecture notes", scope: "mine" },
];

export const InputCard = forwardRef<
  HTMLDivElement,
  { cooking: boolean; onCook: () => void }
>(function InputCard({ cooking, onCook }, ref) {
  const [preset, setPreset] = useState<string>("Summary");
  const [customOpen, setCustomOpen] = useState(false);
  const [recArmed, setRecArmed] = useState(false);
  const popRef = useRef<HTMLDivElement | null>(null);

  const isCustom = !BASE_PRESETS.includes(preset as (typeof BASE_PRESETS)[number]);

  useEffect(() => {
    if (!customOpen) return;
    const close = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) setCustomOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [customOpen]);

  return (
    <div className="i-card" ref={ref}>
      <textarea
        className="i-input"
        rows={3}
        placeholder="Drop audio or video, paste text, or just start typing…"
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            if (!cooking) onCook();
          }
        }}
      />

      <div className="i-pills">
        {BASE_PRESETS.map((p) => (
          <button
            key={p}
            type="button"
            className={`i-pill${preset === p ? " on" : ""}`}
            onClick={() => setPreset(p)}
          >
            {p}
          </button>
        ))}
        <button
          type="button"
          className={`i-pill${isCustom ? " on" : ""}`}
          onClick={() => setCustomOpen((v) => !v)}
        >
          {isCustom ? preset : "Custom"} <span aria-hidden="true">▾</span>
        </button>

        {customOpen && (
          <div className="i-pop" ref={popRef}>
            {MOCK_CUSTOM.map((c) => (
              <button
                key={c.name}
                type="button"
                className="i-pop-item"
                onClick={() => { setPreset(c.name); setCustomOpen(false); }}
              >
                {c.name}
                <span className="scope">{c.scope}</span>
              </button>
            ))}
            <div className="i-pop-sep" />
            <button type="button" className="i-pop-item" title="Phase 2" onClick={() => setCustomOpen(false)}>
              + New preset…
            </button>
          </div>
        )}
      </div>

      <div className="i-cardfoot">
        <button type="button" className="i-iconbtn" aria-label="Attach file" title="Attach (Phase 2)" style={{ width: 30, height: 30 }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
            <path d="M21.4 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.2-9.19a4 4 0 0 1 5.65 5.66l-9.2 9.19a2 2 0 0 1-2.82-2.83l8.49-8.48" />
          </svg>
        </button>
        <button
          type="button"
          className={`i-rec${recArmed ? " live" : ""}`}
          onClick={() => setRecArmed((v) => !v)}
          title="Record (Phase 2)"
        >
          <span className="i-rec-dot" /> rec
        </button>
        <span className="i-spacer" />
        <span className="i-kbd">⏎ cook</span>
        <button type="button" className="i-cook" onClick={onCook} disabled={cooking}>
          {cooking ? "Cooking…" : "Cook"}
        </button>
      </div>
    </div>
  );
});
