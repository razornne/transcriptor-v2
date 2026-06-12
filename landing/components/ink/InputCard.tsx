"use client";
import { forwardRef, useEffect, useRef, useState } from "react";
import { SUPPORTED_LANGUAGES } from "@/lib/ink/config";

// InputCard — герой-объект состояния INPUT. Принимает: текст, drag-and-drop /
// attach файла, запись (mic + tab-audio mix). Стоп записи = сразу Cook
// (zero-friction).
//
// Спринт 1: НИКАКИХ пилюль Transcript/Summary/Action items здесь — в Skriptly
// транскрипт делается всегда и первым, выбор «что приготовить» до обработки
// не существует. Segmented control живёт только в ResultView (OUTPUT).
//
// Футер (слева→направо): 📎 attach · ● rec · Lang ▾ · Spk ▾ · + Context.
// + Context раскрывает вторую строку с одним инпутом (тема/имена/термины),
// значение контролируется из page и уходит полем prompt в FormData.

export const InputCard = forwardRef<HTMLDivElement, {
  cooking: boolean;
  recording: boolean;
  recSeconds: number;
  language: string;
  onLanguage: (v: string) => void;
  speakers: string;
  onSpeakers: (v: string) => void;
  context: string;
  onContext: (v: string) => void;
  onCookText: (text: string) => void;
  onFile: (f: File) => void;
  onRecToggle: () => void;
}>(function InputCard(p, ref) {
  const [text, setText] = useState("");
  const [drag, setDrag] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const ctxRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (p.cooking) setText(""); }, [p.cooking]);
  useEffect(() => { if (contextOpen) ctxRef.current?.focus(); }, [contextOpen]);

  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  const hasContext = p.context.trim().length > 0;

  return (
    <div
      ref={ref}
      className={`i-card${drag ? " drag" : ""}`}
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault(); setDrag(false);
        const f = e.dataTransfer.files?.[0];
        if (f && !p.cooking && !p.recording) p.onFile(f);
      }}
    >
      <textarea
        className="i-input"
        rows={3}
        placeholder={p.recording
          ? "Recording… stop to cook it into shape."
          : "Drop audio or video, paste text, or just start typing…"}
        value={text}
        disabled={p.recording}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            if (!p.cooking && text.trim()) p.onCookText(text.trim());
          }
        }}
      />

      <div className="i-cardfoot">
        <input ref={fileRef} type="file" accept="audio/*,video/*" hidden
          onChange={(e) => { const f = e.target.files?.[0]; if (f) p.onFile(f); e.target.value = ""; }} />
        <button type="button" className="i-iconbtn i-foot-btn" aria-label="Attach audio or video"
          disabled={p.cooking || p.recording}
          onClick={() => fileRef.current?.click()}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
            <path d="M21.4 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.2-9.19a4 4 0 0 1 5.65 5.66l-9.2 9.19a2 2 0 0 1-2.82-2.83l8.49-8.48" />
          </svg>
        </button>

        <button type="button" className={`i-rec${p.recording ? " live" : ""}`}
          onClick={() => { if (!p.cooking) p.onRecToggle(); }}>
          <span className="i-rec-dot" />
          {p.recording ? <>stop · <span className="i-rec-timer">{fmt(p.recSeconds)}</span></> : "rec"}
        </button>

        <select className="i-mini" aria-label="Language" value={p.language}
          onChange={(e) => p.onLanguage(e.target.value)} disabled={p.recording}>
          {SUPPORTED_LANGUAGES.map((l) => (
            <option key={l.value} value={l.value}>{l.label}</option>
          ))}
        </select>
        <select className="i-mini" aria-label="Speakers" value={p.speakers}
          onChange={(e) => p.onSpeakers(e.target.value)} disabled={p.recording}>
          <option value="">Spk: auto</option>
          {[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>Spk: {n}</option>)}
        </select>

        <button type="button"
          className={`i-ctx-btn${contextOpen || hasContext ? " on" : ""}`}
          aria-expanded={contextOpen} disabled={p.recording}
          onClick={() => setContextOpen((v) => !v)}>
          {hasContext ? "Context ·" : "+ Context"}
        </button>

        <span className="i-spacer" />
        <span className="i-kbd">⏎ cook</span>
        <button type="button" className="i-cook"
          disabled={p.cooking || p.recording || !text.trim()}
          onClick={() => p.onCookText(text.trim())}>
          {p.cooking ? "Cooking…" : "Cook"}
        </button>
      </div>

      {contextOpen && (
        <div className="i-ctx-row">
          <input
            ref={ctxRef}
            className="i-field"
            value={p.context}
            placeholder="Тема, імена, терміни — допомагає Whisper"
            disabled={p.recording}
            onChange={(e) => p.onContext(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setContextOpen(false);
              if (e.key === "Enter") { e.preventDefault(); setContextOpen(false); }
            }}
            onBlur={() => { if (!p.context.trim()) setContextOpen(false); }}
          />
        </div>
      )}
    </div>
  );
});
