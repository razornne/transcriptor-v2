"use client";
import { useEffect, useRef, useState } from "react";
import { SUPPORTED_LANGUAGES } from "@/lib/ink/config";

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

export function InputCard({
  cooking, recording, recSeconds,
  language, onLanguage,
  speakers, onSpeakers,
  context, onContext,
  onFile, onRecToggle,
  inWorkspace, visibility, onVisibility,
}: {
  cooking: boolean;
  recording: boolean;
  recSeconds: number;
  language: string;
  onLanguage: (v: string) => void;
  speakers: string;
  onSpeakers: (v: string) => void;
  context: string;
  onContext: (v: string) => void;
  onFile: (f: File) => void;
  onRecToggle: () => void;
  inWorkspace?: boolean;
  visibility?: "private" | "workspace";
  onVisibility?: (v: "private" | "workspace") => void;
}) {
  const [drag, setDrag] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const ctxRef = useRef<HTMLInputElement>(null);
  const hasContext = context.trim().length > 0;

  useEffect(() => { if (contextOpen) ctxRef.current?.focus(); }, [contextOpen]);

  return (
    <div
      className={`i-card${drag ? " drag" : ""}`}
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault(); setDrag(false);
        const f = e.dataTransfer.files?.[0];
        if (f && !cooking && !recording) onFile(f);
      }}
    >
      {/* ── Dropzone body ── */}
      <div className={`i-dropzone${recording ? " live" : ""}${drag ? " dragging" : ""}`}>
        {recording ? (
          <div className="i-dropzone-rec">
            <span className="i-rec-dot-lg" />
            <span className="i-dropzone-timer">{fmt(recSeconds)}</span>
            <span className="i-dropzone-hint-sub">Recording in progress — click Stop when done</span>
          </div>
        ) : cooking ? (
          <div className="i-dropzone-rec">
            <span className="i-dropzone-hint-sub">Processing…</span>
          </div>
        ) : (
          <div className="i-dropzone-idle">
            <svg
              className="i-dropzone-icon"
              width="26" height="26" viewBox="0 0 24 24"
              fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"
            >
              <path d="M9 18V5l12-2v13" />
              <circle cx="6" cy="18" r="3" />
              <circle cx="18" cy="16" r="3" />
            </svg>
            <span className="i-dropzone-hint">{drag ? "Release to upload" : "Drop audio or video here"}</span>
            <span className="i-dropzone-hint-sub">or click Record below</span>
          </div>
        )}
      </div>

      {/* ── Control row ── */}
      <div className="i-ctrl-row">
        <input
          ref={fileRef}
          type="file"
          accept="audio/*,video/*"
          hidden
          onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ""; }}
        />

        {/* Hero Record button */}
        <button
          type="button"
          className={`i-rec-hero${recording ? " live" : ""}`}
          disabled={cooking}
          onClick={() => onRecToggle()}
          aria-label={recording ? "Stop recording" : "Start recording"}
        >
          <span className="i-rec-dot" />
          {recording
            ? <><span>Stop</span> · <span style={{ fontVariantNumeric: "tabular-nums" }}>{fmt(recSeconds)}</span></>
            : "Record"
          }
        </button>

        {!recording && (
          <button
            type="button"
            className="i-upload-btn"
            disabled={cooking}
            onClick={() => fileRef.current?.click()}
            aria-label="Upload audio or video file"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" />
            </svg>
            Upload
          </button>
        )}

        <select
          className="i-mini"
          aria-label="Language"
          value={language}
          onChange={(e) => onLanguage(e.target.value)}
          disabled={recording || cooking}
        >
          {SUPPORTED_LANGUAGES.map((l) => (
            <option key={l.value} value={l.value}>{l.label}</option>
          ))}
        </select>

        <select
          className="i-mini"
          aria-label="Speakers"
          value={speakers}
          onChange={(e) => onSpeakers(e.target.value)}
          disabled={recording || cooking}
        >
          <option value="">Spk: auto</option>
          {[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>Spk: {n}</option>)}
        </select>

        <button
          type="button"
          className={`i-ctx-btn${contextOpen || hasContext ? " on" : ""}`}
          aria-expanded={contextOpen}
          disabled={recording || cooking}
          onClick={() => setContextOpen((v) => !v)}
        >
          {hasContext ? "Context ·" : "+ Context"}
        </button>
      </div>

      {/* ── Context expand row ── */}
      {contextOpen && (
        <div className="i-ctx-row">
          <input
            ref={ctxRef}
            className="i-field"
            value={context}
            placeholder="Topic, names, terms — helps Whisper"
            disabled={recording || cooking}
            onChange={(e) => onContext(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setContextOpen(false);
              if (e.key === "Enter") { e.preventDefault(); setContextOpen(false); }
            }}
            onBlur={() => { if (!context.trim()) setContextOpen(false); }}
          />
        </div>
      )}

      {/* ── Visibility selector — ONLY when user has a real workspace ── */}
      {inWorkspace && onVisibility && visibility && (
        <div className="i-vis-row">
          <span className="i-vis-label">Save as</span>
          <div className="i-vis-seg">
            <button
              type="button"
              className={`i-vis-btn${visibility === "private" ? " on" : ""}`}
              onClick={() => onVisibility("private")}
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                <rect x="3" y="11" width="18" height="11" rx="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
              Private
            </button>
            <button
              type="button"
              className={`i-vis-btn${visibility === "workspace" ? " on" : ""}`}
              onClick={() => onVisibility("workspace")}
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
              </svg>
              Workspace
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
