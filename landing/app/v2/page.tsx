"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { sb } from "@/lib/ink/supabase";
import { DotField, type DotFieldHandle } from "@/components/ink/DotField";
import { InputCard, type PresetKey } from "@/components/ink/InputCard";
import { InkSidebar } from "@/components/ink/InkSidebar";
import { LoginScreen } from "@/components/ink/LoginScreen";
import { ResultView, transcriptText } from "@/components/ink/ResultView";
import { startRecording, probeDuration, type Recorder } from "@/lib/ink/audio";
import { idbDeleteSession, idbGetOrphans } from "@/lib/ink/idb";
import { startKeepAlive, ensureNotifyPermission, notify, batteryWarning } from "@/lib/ink/keepalive";
import { transcribe, generate, generateTitle, fetchProfile, type Profile, type JobProgress } from "@/lib/ink/api";
import {
  fetchHistory, insertEntry, patchEntry, deleteEntry,
  type HistoryEntry, type Segment,
} from "@/lib/ink/db";

// /v2 — Ink & Halftone, ФУНКЦИОНАЛЬНАЯ аппка (Phase 2-3):
// auth (Supabase) → запись/аплоад/текст → /api/transcribe + polling
// (прогресс гонит волны по точкам) → история в Postgres → AI-табы → экспорт.

const STAGE_LABELS: Record<string, string> = {
  convert: "decoding audio…",
  split: "splitting audio…",
  processing: "transcribing…",
  transcribe: "transcribing…",
  diarize: "separating speakers…",
  merge: "merging…",
  correct: "correcting terms…",
};

function autoTitle(segments: Segment[]): string {
  const words = (segments[0]?.text || "").split(/\s+/).slice(0, 6).join(" ");
  return words.length > 2 ? words : "Untitled recording";
}

// Safety net: незавершённая запись (crash) или упавший аплоад (failed) —
// blob держим до успеха, юзеру даём Cook / Download / Discard
type RecoverState = {
  blob: Blob;
  durationSec: number;
  sizeMb: number;
  sessionId: string | null;
  source: "crash" | "failed";
};

function downloadBlob(blob: Blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `recording-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.webm`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export default function InkApp() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [sbOpen, setSbOpen] = useState(false);
  const [team, setTeam] = useState(false);

  const [cooking, setCooking] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recSeconds, setRecSeconds] = useState(0);
  const [status, setStatus] = useState("");
  const [statusKind, setStatusKind] = useState<"info" | "error">("info");
  const [preset, setPreset] = useState<PresetKey>("summary");
  const [language, setLanguage] = useState("");
  const [speakers, setSpeakers] = useState("");

  const [recover, setRecover] = useState<RecoverState | null>(null);
  const dotsRef = useRef<DotFieldHandle>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const recorderRef = useRef<Recorder | null>(null);
  const recTimerRef = useRef<number>(0);
  const keepAliveStopRef = useRef<(() => void) | null>(null);

  // ── auth ────────────────────────────────────────────────────
  useEffect(() => {
    void sb.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = sb.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) { setEntries([]); setProfile(null); return; }
    void fetchHistory().then(setEntries).catch(() => setEntries([]));
    void fetchProfile().then(setProfile);
    // Orphan-сессии из IndexedDB: вкладка/браузер умерли посреди записи
    void idbGetOrphans().then((orphans) => {
      if (!orphans.length) return;
      const o = orphans[0];
      setRecover({
        blob: o.blob,
        durationSec: o.approxMinutes * 60,
        sizeMb: o.sizeMb,
        sessionId: o.id,
        source: "crash",
      });
    });
  }, [session]);

  // Предупреждение при закрытии вкладки во время записи/обработки
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => {
      if (recording || cooking) e.preventDefault();
    };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [recording, cooking]);

  const activeEntry = entries.find((e) => e.id === activeId) || null;

  const patchLocal = useCallback((id: string, fields: Partial<HistoryEntry>, db: Record<string, unknown>) => {
    setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, ...fields } : e)));
    void patchEntry(id, db).catch((err) => console.error("[history] patch failed:", err));
  }, []);

  // ── AI auto-run после транскрипции (пресет из карточки) ─────
  const autoRunPreset = useCallback(async (entry: HistoryEntry, p: PresetKey) => {
    if (p !== "summary" && p !== "actions") return;
    setStatus(`cooking ${p}…`);
    try {
      const text = await generate(entry.segments, entry.speakerNames, p, entry.lang === "auto" ? "" : entry.lang);
      const ai = { ...entry.aiResults, [p]: text };
      patchLocal(entry.id, { aiResults: ai }, { ai_results: ai });
      setStatus("");
    } catch {
      setStatus(""); // ResultView покажет свою ошибку при ручном Generate
    }
  }, [patchLocal]);

  // ── основной Cook-поток ─────────────────────────────────────
  const finishWithSegments = useCallback(async (segments: Segment[], lang: string) => {
    if (!session?.user) return;
    dotsRef.current?.wave(1.8);
    const title = autoTitle(segments);
    const entry = await insertEntry({
      user_id: session.user.id,
      title,
      title_is_auto: true,
      language: lang || null,
      segments,
      speaker_names: {},
      notes: "",
      ai_results: {},
    });
    if (!entry) { setStatusKind("error"); setStatus("saved locally only — history insert failed"); return; }
    setEntries((prev) => [entry, ...prev]);
    setActiveId(entry.id);
    setStatus("");

    // Фоновый LLM-заголовок (перетирает только авто-тайтл)
    void generateTitle(transcriptText(segments, {}), lang).then((t) => {
      if (!t) return;
      setEntries((prev) => prev.map((e) =>
        e.id === entry.id && e.titleIsAuto ? { ...e, title: t } : e));
      void patchEntry(entry.id, { title: t }).catch(() => {});
    });

    void autoRunPreset({ ...entry, title }, preset);
  }, [session, preset, autoRunPreset]);

  const cookBlob = useCallback(async (blob: Blob, durationSec: number, sessionId: string | null = null) => {
    if (cooking) return;
    setCooking(true);
    setSbOpen(false);
    setStatusKind("info");
    setStatus("uploading…");
    dotsRef.current?.wave(0.8);

    let lastStage = "";
    let lastChunks = 0;
    const onProgress = (p: JobProgress) => {
      if (p.chunks_total) {
        if ((p.chunks_done || 0) > lastChunks) {
          lastChunks = p.chunks_done || 0;
          dotsRef.current?.wave(1);
        }
        setStatus(`chunk ${p.chunks_done || 0}/${p.chunks_total} · transcribing…`);
      } else if (p.stage && p.stage !== lastStage) {
        lastStage = p.stage;
        dotsRef.current?.wave(1);
        setStatus(STAGE_LABELS[p.stage] || `${p.stage}…`);
      }
    };

    try {
      const segments = await transcribe(blob, { language, numSpeakers: speakers, durationSec }, onProgress);
      if (!segments.length) {
        setStatusKind("error");
        setStatus("no speech detected in the recording");
        if (sessionId) void idbDeleteSession(sessionId);
        setRecover(null);
      } else {
        await finishWithSegments(segments, language);
        if (sessionId) void idbDeleteSession(sessionId);
        setRecover(null);
        notify("Skriptly — transcript ready", "Your recording is processed and saved.");
      }
    } catch (e) {
      setStatusKind("error");
      setStatus(`failed: ${e instanceof Error ? e.message : e}`);
      // Blob не теряем: retry / download / discard
      setRecover({ blob, durationSec, sizeMb: blob.size / 1048576, sessionId, source: "failed" });
      notify("Skriptly — transcription failed", "The recording is kept — you can retry.");
    } finally {
      setCooking(false);
    }
  }, [cooking, language, speakers, finishWithSegments]);

  const cookText = useCallback(async (text: string) => {
    if (cooking || !text) return;
    setCooking(true);
    setStatusKind("info");
    setStatus("saving…");
    dotsRef.current?.wave(1);
    try {
      const segments: Segment[] = [{ speaker: "SPEAKER_00", start: 0, end: 0, text }];
      await finishWithSegments(segments, language);
    } catch (e) {
      setStatusKind("error");
      setStatus(`failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setCooking(false);
    }
  }, [cooking, language, finishWithSegments]);

  const onFile = useCallback(async (f: File) => {
    setStatus("reading file…");
    const dur = await probeDuration(f);
    void cookBlob(f, dur);
  }, [cookBlob]);

  // ── запись ──────────────────────────────────────────────────
  const onRecToggle = useCallback(async () => {
    if (recording) {
      const rec = recorderRef.current;
      recorderRef.current = null;
      window.clearInterval(recTimerRef.current);
      setRecording(false);
      keepAliveStopRef.current?.();
      keepAliveStopRef.current = null;
      if (rec) {
        const { blob, durationSec } = await rec.stop();
        void cookBlob(blob, durationSec, rec.sessionId);
      }
      return;
    }
    try {
      const warn = await batteryWarning();
      if (warn && !window.confirm(warn)) return;
      ensureNotifyPermission();
      setStatusKind("info");
      setStatus("requesting microphone…");
      recorderRef.current = await startRecording();
      keepAliveStopRef.current = await startKeepAlive();
      setRecSeconds(0);
      setRecording(true);
      setActiveId(null);
      setStatus("recording — share a tab to capture call audio too");
      recTimerRef.current = window.setInterval(() => setRecSeconds((s) => s + 1), 1000);
    } catch (e) {
      setStatusKind("error");
      setStatus(`microphone access failed: ${e instanceof Error ? e.message : e}`);
    }
  }, [recording, cookBlob]);

  useEffect(() => () => {
    window.clearInterval(recTimerRef.current);
    keepAliveStopRef.current?.();
  }, []);

  // ── шорткаты ────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "\\") { e.preventDefault(); setSbOpen((v) => !v); return; }
      if (e.key === "Escape") setSbOpen(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  // ── рендер ──────────────────────────────────────────────────
  if (session === undefined) return <div className="ink-root" />;
  if (!session) return <LoginScreen />;

  const initials = (session.user.email || "?").slice(0, 2).toUpperCase();

  return (
    <div className={`ink-root${sbOpen ? " sb-open" : ""}${team ? " team" : ""}`}>
      <InkSidebar
        open={sbOpen} team={team} entries={entries} activeId={activeId} profile={profile}
        onClose={() => setSbOpen(false)} onTeamChange={setTeam}
        onSelect={(id) => setActiveId(id)}
        onDelete={(id) => {
          setEntries((prev) => prev.filter((e) => e.id !== id));
          if (activeId === id) setActiveId(null);
          void deleteEntry(id).catch((err) => console.error("[history] delete failed:", err));
        }}
        onSignOut={() => { void sb.auth.signOut(); }}
      />

      <header className="i-topbar">
        <button type="button" className="i-iconbtn" aria-label="Open sidebar (⌘\)" onClick={() => setSbOpen((v) => !v)}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <path d="M4 6h16M4 12h16M4 18h10" />
          </svg>
        </button>
        <div className="i-topbar-side">
          <InkThemeToggle />
          <div className="i-avatar" title={session.user.email || ""}>{initials}</div>
        </div>
      </header>

      <main className="i-hero">
        <DotField ref={dotsRef} anchorRef={stageRef} />
        <div className="i-center">
          <div ref={stageRef}>
            {activeEntry ? (
              <>
                <button type="button" className="i-pill i-back" onClick={() => setActiveId(null)}>
                  ← New recording
                </button>
                <ResultView
                  key={activeEntry.id}
                  entry={activeEntry}
                  initialTab={preset === "actions" ? "actions" : preset === "summary" ? "summary" : "transcript"}
                  onPatch={(fields, db) => patchLocal(activeEntry.id, fields, db)}
                />
                {status && <p className={`i-status${statusKind === "error" ? " err" : ""}`} aria-live="polite">{status}</p>}
              </>
            ) : (
              <>
                <h1 className="i-title">Say it <em>messy</em>.</h1>
                <p className="i-sub">Talk it into shape — come back to clean, structured text.</p>
                <InputCard
                  cooking={cooking} recording={recording} recSeconds={recSeconds}
                  preset={preset} onPreset={setPreset}
                  language={language} onLanguage={setLanguage}
                  speakers={speakers} onSpeakers={setSpeakers}
                  onCookText={(t) => void cookText(t)}
                  onFile={(f) => void onFile(f)}
                  onRecToggle={() => void onRecToggle()}
                />
                <p className={`i-status${statusKind === "error" ? " err" : ""}`} aria-live="polite">{status}</p>
                {recover && !cooking && (
                  <div className="i-recover">
                    <span className="i-recover-text">
                      {recover.source === "crash" ? "Unfinished recording found" : "Upload failed — recording kept"}
                      <span className="sub">
                        ≈{Math.max(1, Math.round(recover.durationSec / 60))} min · {recover.sizeMb.toFixed(1)} MB
                      </span>
                    </span>
                    <button type="button" className="i-pill on"
                      onClick={() => void cookBlob(recover.blob, recover.durationSec, recover.sessionId)}>
                      Cook it
                    </button>
                    <button type="button" className="i-pill" onClick={() => downloadBlob(recover.blob)}>
                      Download
                    </button>
                    <button type="button" className="i-pill"
                      onClick={() => {
                        if (recover.sessionId) void idbDeleteSession(recover.sessionId);
                        setRecover(null);
                      }}>
                      Discard
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

function InkThemeToggle() {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  useEffect(() => {
    setTheme((document.documentElement.getAttribute("data-theme") || "light") as "light" | "dark");
  }, []);
  const toggle = () => {
    const next = theme === "light" ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("skriptly-theme", next); } catch {}
    setTheme(next);
  };
  return (
    <button type="button" className="i-iconbtn" onClick={toggle} aria-label="Toggle theme">
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
    </button>
  );
}
