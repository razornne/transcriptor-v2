"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { sb } from "@/lib/ink/supabase";
import { DotField, type DotFieldHandle } from "@/components/ink/DotField";
import { InputCard } from "@/components/ink/InputCard";
import { InkSidebar } from "@/components/ink/InkSidebar";
import { LoginScreen } from "@/components/ink/LoginScreen";
import { ResultView, transcriptText } from "@/components/ink/ResultView";
import { UpgradeCard } from "@/components/ink/UpgradeCard";
import { SettingsModal } from "@/components/ink/SettingsModal";
import { startRecording, probeDuration, type Recorder } from "@/lib/ink/audio";
import { idbDeleteSession, idbGetOrphans } from "@/lib/ink/idb";
import { startKeepAlive, ensureNotifyPermission, notify, batteryWarning } from "@/lib/ink/keepalive";
import {
  transcribe, generateTitle, fetchProfile, cancelJob, savePresets, saveTeamPresets,
  CancelledError, type CancelToken, type Profile, type JobProgress, type Preset,
} from "@/lib/ink/api";
import {
  fetchHistory, insertEntry, patchEntry, deleteEntry,
  type HistoryEntry, type Segment,
} from "@/lib/ink/db";
import { loadSettings, saveSettings, type InkSettings } from "@/lib/ink/settings";

// /v2 — Ink & Halftone, полностью функциональная аппка.
// Спринт 3: SettingsModal (⌘,), Best Quality из настроек, Privacy Mode, Custom presets.
// Стейт-машина: view = activeId ? OUTPUT : INPUT.

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

function minutesLeft(profile: Profile | null): number {
  if (!profile || profile.minutes_limit <= 0) return Infinity;
  return profile.minutes_limit - profile.minutes_used;
}

type RecoverState = {
  blob: Blob; durationSec: number; sizeMb: number;
  sessionId: string | null; source: "crash" | "failed";
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [team, setTeam] = useState(false);

  // Настройки из localStorage (Спринт 3)
  const [settings, setSettings] = useState<InkSettings>({
    quality: "fast", language: "", speakers: "", aiDetail: "medium",
  });

  // Пресеты (Спринт 3)
  const [presets, setPresets] = useState<Preset[]>([]);
  const [teamPresets, setTeamPresets] = useState<Preset[]>([]);

  const [cooking, setCooking] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recSeconds, setRecSeconds] = useState(0);
  const [status, setStatus] = useState("");
  const [statusKind, setStatusKind] = useState<"info" | "error">("info");
  const [language, setLanguage] = useState("");
  const [speakers, setSpeakers] = useState("");
  const [context, setContext] = useState("");
  const [limitHit, setLimitHit] = useState(false);
  const [recover, setRecover] = useState<RecoverState | null>(null);

  const dotsRef = useRef<DotFieldHandle>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const recorderRef = useRef<Recorder | null>(null);
  const recTimerRef = useRef<number>(0);
  const keepAliveStopRef = useRef<(() => void) | null>(null);
  const cancelRef = useRef<CancelToken | null>(null);

  // ── Инициализация настроек из localStorage ──────────────────────
  useEffect(() => {
    const s = loadSettings();
    setSettings(s);
    setLanguage(s.language);
    setSpeakers(s.speakers);
  }, []);

  // ── auth ─────────────────────────────────────────────────────────
  useEffect(() => {
    void sb.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = sb.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) { setEntries([]); setProfile(null); setPresets([]); setTeamPresets([]); return; }
    void fetchHistory().then(setEntries).catch(() => setEntries([]));
    void fetchProfile().then((p) => {
      setProfile(p);
      if (p?.presets) setPresets(p.presets);
      if (p?.team_presets) setTeamPresets(p.team_presets);
    });
    void idbGetOrphans().then((orphans) => {
      if (!orphans.length) return;
      const o = orphans[0];
      setRecover({
        blob: o.blob, durationSec: o.approxMinutes * 60,
        sizeMb: o.sizeMb, sessionId: o.id, source: "crash",
      });
    });
  }, [session]);

  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => { if (recording || cooking) e.preventDefault(); };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [recording, cooking]);

  const activeEntry = entries.find((e) => e.id === activeId) || null;
  const view: "INPUT" | "OUTPUT" = activeEntry ? "OUTPUT" : "INPUT";

  const patchLocal = useCallback((id: string, fields: Partial<HistoryEntry>, db: Record<string, unknown>) => {
    setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, ...fields } : e)));
    void patchEntry(id, db).catch((err) => console.error("[history] patch failed:", err));
  }, []);

  const passLimitGate = useCallback((): boolean => {
    const left = minutesLeft(profile);
    if (left <= 0) { setLimitHit(true); setStatusKind("error"); setStatus("monthly minutes used up"); setSbOpen(false); return false; }
    if (left <= 30 && !window.confirm(`Only ~${Math.round(left)} min left on your plan. Start anyway?`)) return false;
    return true;
  }, [profile]);

  const finishWithSegments = useCallback(async (segments: Segment[], lang: string) => {
    if (!session?.user) return;
    dotsRef.current?.wave(1.8);
    const title = autoTitle(segments);
    const entry = await insertEntry({
      user_id: session.user.id, title, title_is_auto: true,
      language: lang || null, segments, speaker_names: {}, notes: "", ai_results: {},
    });
    if (!entry) { setStatusKind("error"); setStatus("saved locally only — history insert failed"); return; }
    setEntries((prev) => [entry, ...prev]);
    setActiveId(entry.id);
    setStatus("");
    void generateTitle(transcriptText(segments, {}), lang).then((t) => {
      if (!t) return;
      setEntries((prev) => prev.map((e) => e.id === entry.id && e.titleIsAuto ? { ...e, title: t } : e));
      void patchEntry(entry.id, { title: t }).catch(() => {});
    });
  }, [session]);

  const cookBlob = useCallback(async (blob: Blob, durationSec: number, sessionId: string | null = null) => {
    if (cooking) return;
    setCooking(true); setSbOpen(false); setStatusKind("info"); setStatus("uploading…");
    dotsRef.current?.wave(0.8);

    const token: CancelToken = { cancelled: false, jobId: null };
    cancelRef.current = token;

    let lastStage = "", lastChunks = 0;
    const onProgress = (pr: JobProgress) => {
      if (pr.chunks_total) {
        if ((pr.chunks_done || 0) > lastChunks) { lastChunks = pr.chunks_done || 0; dotsRef.current?.wave(1); }
        setStatus(`chunk ${pr.chunks_done || 0}/${pr.chunks_total} · transcribing…`);
      } else if (pr.stage && pr.stage !== lastStage) {
        lastStage = pr.stage; dotsRef.current?.wave(1);
        setStatus(STAGE_LABELS[pr.stage] || `${pr.stage}…`);
      }
    };

    // Считываем качество из текущих настроек на момент отправки
    const currentQuality = loadSettings().quality;

    try {
      const segments = await transcribe(
        blob,
        {
          language, numSpeakers: speakers, durationSec,
          prompt: context,
          quality: currentQuality === "best" ? "best" : undefined,
        },
        onProgress, token,
      );
      if (!segments.length) {
        setStatusKind("error"); setStatus("no speech detected in the recording");
        if (sessionId) void idbDeleteSession(sessionId);
        setRecover(null);
      } else {
        await finishWithSegments(segments, language);
        if (sessionId) void idbDeleteSession(sessionId);
        setRecover(null);
        notify("Skriptly — transcript ready", "Your recording is processed and saved.");
      }
    } catch (e) {
      if (e instanceof CancelledError) {
        setStatus(""); if (sessionId) void idbDeleteSession(sessionId); setRecover(null);
      } else {
        setStatusKind("error");
        setStatus(`failed: ${e instanceof Error ? e.message : e}`);
        setRecover({ blob, durationSec, sizeMb: blob.size / 1048576, sessionId, source: "failed" });
        notify("Skriptly — transcription failed", "The recording is kept — you can retry.");
      }
    } finally {
      cancelRef.current = null; setCooking(false);
    }
  }, [cooking, language, speakers, context, finishWithSegments]);

  const onCancel = useCallback(() => {
    const tok = cancelRef.current;
    if (!tok) return;
    tok.cancelled = true;
    if (tok.jobId) void cancelJob(tok.jobId);
    setStatus("cancelling…");
  }, []);

  const cookText = useCallback(async (text: string) => {
    if (cooking || !text) return;
    setCooking(true); setStatusKind("info"); setStatus("saving…"); dotsRef.current?.wave(1);
    try {
      const segments: Segment[] = [{ speaker: "SPEAKER_00", start: 0, end: 0, text }];
      await finishWithSegments(segments, language);
    } catch (e) {
      setStatusKind("error"); setStatus(`failed: ${e instanceof Error ? e.message : e}`);
    } finally { setCooking(false); }
  }, [cooking, language, finishWithSegments]);

  const onFile = useCallback(async (f: File) => {
    if (!passLimitGate()) return;
    setStatus("reading file…");
    const dur = await probeDuration(f);
    void cookBlob(f, dur);
  }, [passLimitGate, cookBlob]);

  const onRecToggle = useCallback(async () => {
    if (recording) {
      const rec = recorderRef.current;
      recorderRef.current = null;
      window.clearInterval(recTimerRef.current);
      setRecording(false);
      keepAliveStopRef.current?.(); keepAliveStopRef.current = null;
      if (rec) { const { blob, durationSec } = await rec.stop(); void cookBlob(blob, durationSec, rec.sessionId); }
      return;
    }
    if (!passLimitGate()) return;
    try {
      const warn = await batteryWarning();
      if (warn && !window.confirm(warn)) return;
      ensureNotifyPermission();
      setLimitHit(false); setStatusKind("info"); setStatus("requesting microphone…");
      recorderRef.current = await startRecording();
      keepAliveStopRef.current = await startKeepAlive();
      setRecSeconds(0); setRecording(true); setActiveId(null);
      setStatus("recording — share a tab to capture call audio too");
      recTimerRef.current = window.setInterval(() => setRecSeconds((s) => s + 1), 1000);
    } catch (e) {
      setStatusKind("error"); setStatus(`microphone access failed: ${e instanceof Error ? e.message : e}`);
    }
  }, [recording, passLimitGate, cookBlob]);

  useEffect(() => () => { window.clearInterval(recTimerRef.current); keepAliveStopRef.current?.(); }, []);

  // ── Шорткаты ─────────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "\\") { e.preventDefault(); setSbOpen((v) => !v); return; }
      if ((e.metaKey || e.ctrlKey) && e.key === ",")  { e.preventDefault(); setSettingsOpen((v) => !v); return; }
      if (e.key === "Escape") { setSbOpen(false); setSettingsOpen(false); }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  // ── Пресеты: сохранение на сервер + обновление стейта ────────────
  const handlePresetsChange = useCallback(async (updated: Preset[]) => {
    setPresets(updated); // optimistic
    try { const canonical = await savePresets(updated); setPresets(canonical); }
    catch (e) { console.error("[presets] save failed:", e); }
  }, []);

  const handleTeamPresetsChange = useCallback(async (updated: Preset[]) => {
    setTeamPresets(updated); // optimistic
    try { const canonical = await saveTeamPresets(updated); setTeamPresets(canonical); }
    catch (e) { console.error("[team-presets] save failed:", e); }
  }, []);

  // ── Рендер ───────────────────────────────────────────────────────
  if (session === undefined) return <div className="ink-root" />;
  if (!session) return <LoginScreen />;

  const initials = (session.user.email || "?").slice(0, 2).toUpperCase();
  const plan = profile?.plan || "free";

  // DotField гаснет до 0.35 при открытом Settings или в режиме OUTPUT
  const dotMode = settingsOpen || view === "OUTPUT" ? "reading" : "live";

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
        onSettings={() => setSettingsOpen(true)}
      />

      <header className="i-topbar">
        <button type="button" className="i-iconbtn" aria-label="Open sidebar (⌘\\)" onClick={() => setSbOpen((v) => !v)}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <path d="M4 6h16M4 12h16M4 18h10" />
          </svg>
        </button>
        <div className="i-topbar-side">
          {/* Settings gear */}
          <button type="button" className="i-iconbtn" aria-label="Settings (⌘,)" onClick={() => setSettingsOpen(true)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
            </svg>
          </button>
          <InkThemeToggle />
          <div className="i-avatar" title={session.user.email || ""}>{initials}</div>
        </div>
      </header>

      <main className="i-hero">
        <DotField ref={dotsRef} anchorRef={stageRef} mode={dotMode} />
        <div className="i-center">
          <div ref={stageRef}>
            {view === "OUTPUT" && activeEntry ? (
              <>
                <button type="button" className="i-back" onClick={() => setActiveId(null)}>
                  ← New recording
                </button>
                <ResultView
                  key={activeEntry.id}
                  entry={activeEntry}
                  plan={plan}
                  presets={presets}
                  teamPresets={teamPresets}
                  onPatch={(fields, db) => patchLocal(activeEntry.id, fields, db)}
                  onPresetsChange={handlePresetsChange}
                  onTeamPresetsChange={handleTeamPresetsChange}
                />
                {status && <p className={`i-status${statusKind === "error" ? " err" : ""}`} aria-live="polite">{status}</p>}
              </>
            ) : (
              <>
                <h1 className="i-title">Say it <em>messy</em>.</h1>
                <p className="i-sub">Talk it into shape — come back to clean, structured text.</p>
                <InputCard
                  cooking={cooking} recording={recording} recSeconds={recSeconds}
                  language={language} onLanguage={(v) => { setLanguage(v); saveSettings({ language: v }); }}
                  speakers={speakers} onSpeakers={(v) => { setSpeakers(v); saveSettings({ speakers: v }); }}
                  context={context} onContext={setContext}
                  onCookText={(t) => void cookText(t)}
                  onFile={(f) => void onFile(f)}
                  onRecToggle={() => void onRecToggle()}
                />

                <div className="i-status-row">
                  <p className={`i-status${statusKind === "error" ? " err" : ""}`} aria-live="polite">{status}</p>
                  {cooking && (
                    <button type="button" className="i-cancel" onClick={onCancel}>[Cancel]</button>
                  )}
                </div>

                {limitHit && !cooking && (
                  <UpgradeCard
                    title="You've used all your minutes"
                    body="Upgrade your plan to keep transcribing this month."
                  />
                )}

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
                      onClick={() => { if (recover.sessionId) void idbDeleteSession(recover.sessionId); setRecover(null); }}>
                      Discard
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </main>

      {/* ── Settings Modal (Спринт 3) ── */}
      {settingsOpen && (
        <SettingsModal
          session={session}
          profile={profile}
          settings={settings}
          onSettingsChange={(patch) => setSettings((prev) => ({ ...prev, ...patch }))}
          onClose={() => setSettingsOpen(false)}
          onSignOut={() => { void sb.auth.signOut(); }}
        />
      )}
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
