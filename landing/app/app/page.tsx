"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { sb } from "@/lib/ink/supabase";
import { DotField, type DotFieldHandle } from "@/components/ink/DotField";
import { InputCard } from "@/components/ink/InputCard";
import { InkSidebar } from "@/components/ink/InkSidebar";
import { LoginScreen } from "@/components/ink/LoginScreen";
import { ResultView, transcriptText, type Tab } from "@/components/ink/ResultView";
import { UpgradeCard } from "@/components/ink/UpgradeCard";
import { SettingsModal } from "@/components/ink/SettingsModal";
import { LivePanel } from "@/components/ink/LivePanel";
import { LiveTranscript, type LiveSegment, type LiveStatus } from "@/lib/ink/live";
import { startRecording, probeDuration, SystemAudioMissingError, type Recorder } from "@/lib/ink/audio";
import { shouldExtractAudio, extractAudioTrack } from "@/lib/ink/audioExtract";
import { idbDeleteSession, idbGetOrphans } from "@/lib/ink/idb";
import { startKeepAlive, ensureNotifyPermission, notify, batteryWarning } from "@/lib/ink/keepalive";
import {
  transcribe, generate, generateTitle, fetchProfile, fetchWorkspace, cancelJob,
  CancelledError, type CancelToken, type Profile, type JobProgress, type WorkspaceInfo,
  type PipelineSteps,
  type Project, loadProjects, saveProjects,
} from "@/lib/ink/api";
import {
  fetchHistory, insertEntry, patchEntry, deleteEntry, insertCaptureStats,
  type HistoryEntry, type Segment,
} from "@/lib/ink/db";
import { loadSettings, saveSettings, type InkSettings } from "@/lib/ink/settings";

// /app — Ink & Halftone, production (cutover 2026-06-14).
// Sprint 5: InputCard MediaHub, two-column SettingsModal, workspace + visibility, onboarding demo.
// Sprint 6: PostHog (privacy-masked), i18n EN/UA, mobile polish.
// Sprint 7: Insights removed, workspace-UI isolation fix, Cmd+D theme hotkey, uniform control row.
// Cutover: /v2 → /app, billing in-app (SettingsModal subscription tab).

// ── PostHog helper (fire-and-forget, never throws) ────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ph = (): any => (typeof window !== "undefined" ? (window as any).posthog : null);
function phCapture(event: string, props?: Record<string, unknown>) {
  try { ph()?.capture?.(event, props); } catch {}
}

// ── Coarse browser/OS sniff for capture_stats — good enough for triage ────
function detectBrowserOS(): { browser: string; os: string } {
  if (typeof navigator === "undefined") return { browser: "unknown", os: "unknown" };
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? "edge" : /OPR\//.test(ua) ? "opera"
    : /Chrome\//.test(ua) ? "chrome" : /Firefox\//.test(ua) ? "firefox"
    : /Safari\//.test(ua) ? "safari" : "unknown";
  const os = /Windows/.test(ua) ? "windows" : /Mac OS X/.test(ua) ? "macos"
    : /Linux/.test(ua) ? "linux" : /Android/.test(ua) ? "android"
    : /iPhone|iPad/.test(ua) ? "ios" : "unknown";
  return { browser, os };
}

// What to tell the user when the shared tab/window came without audio —
// browsers differ a lot in what they can capture.
function systemAudioHelp(): string {
  const { browser, os } = detectBrowserOS();
  if (browser === "firefox" || browser === "safari") {
    return "This browser can't capture call audio, so only your microphone will be recorded. To record both sides of the call, use Chrome or Edge.";
  }
  if (os === "macos") {
    return "No call audio was shared. On a Mac only a Chrome tab can share audio: pick the tab with your call (Google Meet, or Zoom/Teams in the browser) and tick “Share tab audio”. Calls in the Zoom or Teams desktop apps can't be captured from the browser.";
  }
  return "No call audio was shared. Pick the tab with your call and tick “Share tab audio”, or share your entire screen with “Share system audio” turned on.";
}

// ── Smooth theme toggle shared by InkThemeToggle and Cmd+D ───────────────
function applyThemeSmooth(next: "light" | "dark") {
  const doApply = () => {
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("skriptly-theme", next); } catch {}
    document.dispatchEvent(new CustomEvent("ink-theme-toggle"));
  };
  if ("startViewTransition" in document) {
    (document as Document & { startViewTransition(cb: () => void): void }).startViewTransition(doApply);
  } else {
    doApply();
  }
}

const STAGE_LABELS: Record<string, string> = {
  // New honest pipeline step names (modal_app _PipelineProgress)
  container: "spinning up…",
  audio_split: "decoding audio…",
  transcription: "transcribing…",
  diarization: "separating speakers…",
  ai_formatting: "formatting…",
  // Legacy stage names (back-compat for in-flight jobs during deploy)
  convert: "decoding audio…",
  split: "splitting audio…",
  processing: "transcribing…",
  transcribe: "transcribing…",
  diarize: "separating speakers…",
  merge: "merging…",
  correct: "correcting terms…",
};

// Onboarding demo shown when history is empty (sentinel id = "demo")
const DEMO_ENTRY: HistoryEntry = {
  id: "demo",
  userId: "",
  date: new Date(Date.now() - 5 * 60000).toISOString(),
  lang: "en",
  title: "How Skriptly works",
  titleIsAuto: false,
  notes: "",
  aiResults: {},
  workspaceId: null,
  visibility: "private",
  speakerNames: { SPEAKER_00: "Alex", SPEAKER_01: "Morgan" },
  segments: [
    { speaker: "SPEAKER_00", start: 0, end: 9.8, text: "Hey! So I wanted to show you Skriptly. You just record a call or drop an audio file and it handles the rest." },
    { speaker: "SPEAKER_01", start: 10.1, end: 19.5, text: "Does it separate speakers automatically? No training needed?" },
    { speaker: "SPEAKER_00", start: 19.8, end: 31.2, text: "Exactly — Whisper plus pyannote diarization. About a minute for a 30-minute call. Try the tabs above." },
    { speaker: "SPEAKER_01", start: 31.5, end: 42.0, text: "And AI summary and action items just work out of the box?" },
    { speaker: "SPEAKER_00", start: 42.3, end: 55.8, text: "All built in. Gemini processes the full transcript — no cutoffs. Max plan unlocks large-v3 and privacy mode." },
  ],
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

// ── HotkeysOverlay ───────────────────────────────────────────
function HotkeysOverlay({ onClose }: { onClose: () => void }) {
  const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);
  const mod = isMac ? "⌘" : "Ctrl";

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "?") { e.preventDefault(); onClose(); }
    };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [onClose]);

  const rows = [
    { kbd: `${mod}+\\`, desc: "Toggle sidebar" },
    { kbd: `${mod}+,`, desc: "Open settings" },
    { kbd: `${mod}+D`, desc: "Toggle light / dark theme" },
    { kbd: "R", desc: "Start / stop recording" },
    { kbd: "1 / 2 / 3", desc: "Switch tab (Transcript / Summary / Actions)" },
    { kbd: "Esc", desc: "Close panels" },
    { kbd: "?", desc: "This overlay" },
  ];

  return (
    <div className="i-hotkeys-back" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="i-hotkeys" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
        <div className="i-hotkeys-header">
          Keyboard shortcuts
          <button type="button" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="i-hotkeys-list">
          {rows.map((r) => (
            <div key={r.kbd} className="i-hotkeys-row">
              <kbd className="i-kbd">{r.kbd}</kbd>
              <span className="i-hotkeys-desc">{r.desc}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── UndoToast ────────────────────────────────────────────────
function UndoToast({ onUndo, onDismiss }: { onUndo: () => void; onDismiss: () => void }) {
  return (
    <div className="i-toast" role="status" aria-live="polite">
      Recording deleted
      <button type="button" className="i-toast-undo" onClick={onUndo}>Undo</button>
      <button type="button" className="i-toast-close" onClick={onDismiss} aria-label="Dismiss">✕</button>
    </div>
  );
}

// ── InkApp ──────────────────────────────────────────────────
export default function InkApp() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const entriesRef = useRef<HistoryEntry[]>([]);
  useEffect(() => { entriesRef.current = entries; }, [entries]);
  const [autoSummaryIds, setAutoSummaryIds] = useState<Set<string>>(new Set());
  const [activeId, setActiveId] = useState<string | null>(null);
  const [sbOpen, setSbOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<"account" | "subscription">("account");
  const [hotkeysOpen, setHotkeysOpen] = useState(false);
  const [team, setTeam] = useState(false);
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [visibility, setVisibility] = useState<"private" | "workspace">("private");

  // i18n — Sprint 6
  const [uiLang, setUiLang] = useState<"en" | "ua">("en");
  useEffect(() => {
    try {
      const stored = localStorage.getItem("ink_uiLang");
      if (stored === "ua" || stored === "en") setUiLang(stored);
    } catch {}
  }, []);
  const handleUiLangChange = (lang: "en" | "ua") => {
    setUiLang(lang);
    try { localStorage.setItem("ink_uiLang", lang); } catch {}
  };

  // PostHog init
  useEffect(() => {
    if (typeof window === "undefined") return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    if (w.__ink_ph_init) return;
    w.__ink_ph_init = true;

    const isLocal = location.hostname === "localhost";
    const apiHost = isLocal ? "https://eu.i.posthog.com" : `${location.origin}/ingest`;
    const staticHost = isLocal ? "https://eu-assets.i.posthog.com" : `${location.origin}/ingest`;

    const script = document.createElement("script");
    script.src = `${staticHost}/static/array.js`;
    script.defer = true;
    script.onload = () => {
      w.posthog?.init?.("phc_yXYdbAQoySKp6BaHbpkZ3kawiByFRjERMYo5VBNMyvFE", {
        api_host: apiHost,
        ui_host: "https://eu.posthog.com",
        person_profiles: "identified_only",
        capture_exceptions: true,
        autocapture: true,
        // Unmasked on purpose (error analysis). Must be disclosed in the Privacy
        // Policy before public launch. Password fields stay masked by default.
        session_recording: {
          maskAllInputs: false,
          maskTextSelector: null,
        },
      });
    };
    document.head.appendChild(script);
  }, []);

  // Lifted tab state (for 1/2/3/4 hotkeys)
  const [activeTab, setActiveTab] = useState<Tab>("transcript");
  useEffect(() => { setActiveTab("transcript"); }, [activeId]);

  const [settings, setSettings] = useState<InkSettings>({
    quality: "fast", language: "", speakers: "", aiDetail: "medium",
  });

  const [cooking, setCooking] = useState(false);
  const [pipeline, setPipeline] = useState<PipelineSteps | null>(null);
  const [chunkProgress, setChunkProgress] = useState<{ done: number; total: number } | null>(null);
  const [recording, setRecording] = useState(false);
  const [recSeconds, setRecSeconds] = useState(0);
  const [status, setStatus] = useState("");
  const [statusKind, setStatusKind] = useState<"info" | "error">("info");
  const [language, setLanguage] = useState("");
  const [speakers, setSpeakers] = useState("");
  const [context, setContext] = useState("");
  const [limitHit, setLimitHit] = useState(false);
  const [recover, setRecover] = useState<RecoverState | null>(null);
  const [liveSegs, setLiveSegs] = useState<LiveSegment[]>([]);
  const [liveStatus, setLiveStatus] = useState<LiveStatus>("off");
  const [projects, setProjects] = useState<Project[]>([]);

  const [undoEntry, setUndoEntry] = useState<HistoryEntry | null>(null);
  const undoTimerRef = useRef<number>(0);

  const dotsRef = useRef<DotFieldHandle>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const recorderRef = useRef<Recorder | null>(null);
  const liveRef = useRef<LiveTranscript | null>(null);
  const recTimerRef = useRef<number>(0);
  const levelsRef = useRef({ mic: 0, sys: 0 });
  const captureAlertRef = useRef(false); // a capture warning is on screen — don't overwrite it
  const keepAliveStopRef = useRef<(() => void) | null>(null);
  const cancelRef = useRef<CancelToken | null>(null);

  const viewRef = useRef<"INPUT" | "OUTPUT">("INPUT");
  const onRecToggleRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const s = loadSettings();
    setSettings(s);
    setLanguage(s.language);
    setSpeakers(s.speakers);
  }, []);

  useEffect(() => { setProjects(loadProjects()); }, []);

  useEffect(() => {
    void sb.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = sb.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) {
      setEntries([]); setProfile(null);
      setWorkspace(null);
      ph()?.reset?.();
      return;
    }
    void fetchHistory().then(setEntries).catch(() => setEntries([]));
    void fetchProfile().then((p) => {
      setProfile(p);
      // PostHog identify with plan info
      if (session.user) {
        ph()?.identify?.(session.user.id, {
          email: session.user.email,
          plan: p?.plan || "free",
          minutes_used: p?.minutes_used,
          minutes_limit: p?.minutes_limit,
        });
      }
    });
    void fetchWorkspace().then(setWorkspace).catch(() => {});
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

  // Display demo entry when no real entries and not processing
  const displayedEntries = entries.length === 0 && !cooking ? [DEMO_ENTRY] : entries;
  const activeEntry = displayedEntries.find((e) => e.id === activeId) || null;
  const view: "INPUT" | "OUTPUT" = activeEntry ? "OUTPUT" : "INPUT";

  // If real entries arrive while demo is selected, go back to INPUT
  useEffect(() => {
    if (activeId === "demo" && entries.length > 0) setActiveId(null);
  }, [entries.length, activeId]);

  useEffect(() => { viewRef.current = view; }, [view]);

  const patchLocal = useCallback((id: string, fields: Partial<HistoryEntry>, db: Record<string, unknown>) => {
    // AI results come from several async generators (manual, "Both", auto-summary):
    // merge with the latest state so one finishing late doesn't erase another.
    if (fields.aiResults) {
      const ai = { ...(entriesRef.current.find((e) => e.id === id)?.aiResults || {}), ...fields.aiResults };
      fields = { ...fields, aiResults: ai };
      if ("ai_results" in db) db = { ...db, ai_results: ai };
    }
    if (id === "demo") {
      setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, ...fields } : e)));
      return;
    }
    setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, ...fields } : e)));
    void patchEntry(id, db).catch((err) => console.error("[history] patch failed:", err));
  }, []);


  const passLimitGate = useCallback((): boolean => {
    const left = minutesLeft(profile);
    if (left <= 0) {
      setLimitHit(true); setStatusKind("error"); setStatus("monthly minutes used up"); setSbOpen(false);
      return false;
    }
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
      visibility: workspace && visibility === "workspace" ? "workspace" : "private",
      workspace_id: workspace && visibility === "workspace" ? workspace.id : null,
    });
    if (!entry) { setStatusKind("error"); setStatus("saved locally only — history insert failed"); return; }
    setEntries((prev) => [entry, ...prev]);
    setActiveId(entry.id);
    setLiveSegs([]); // финальный транскрипт заменил предпросмотр
    setStatus("");
    phCapture("transcription_completed", { segments: segments.length, language: lang });
    void generateTitle(transcriptText(segments, {}), lang).then((t) => {
      if (!t) return;
      setEntries((prev) => prev.map((e) => e.id === entry.id && e.titleIsAuto ? { ...e, title: t } : e));
      void patchEntry(entry.id, { title: t }).catch(() => {});
    });

    // Auto-summary right after the call (AI is a paid-plan feature)
    if ((profile?.plan || "free") !== "free") {
      setAutoSummaryIds((prev) => new Set(prev).add(entry.id));
      void generate(segments, {}, "summary", lang === "auto" ? "" : lang, loadSettings().aiDetail)
        .then((text) => {
          if (!text || entriesRef.current.find((e) => e.id === entry.id)?.aiResults.summary) return;
          patchLocal(entry.id, { aiResults: { summary: text } }, { ai_results: { summary: text } });
          phCapture("summary_auto_generated");
        })
        .catch((err) => {
          console.error("[auto-summary] failed:", err);
          phCapture("summary_auto_failed", { error: String(err) });
        })
        .finally(() => setAutoSummaryIds((prev) => { const s = new Set(prev); s.delete(entry.id); return s; }));
    }
  }, [session, workspace, visibility, profile, patchLocal]);

  const cookBlob = useCallback(async (
    blob: Blob, durationSec: number, sessionId: string | null = null,
    archive: { recordingId?: string; source?: "record" | "upload" } = {},
  ) => {
    if (cooking) return;
    setCooking(true); setPipeline(null); setSbOpen(false); setStatusKind("info"); setStatus("uploading…");
    dotsRef.current?.wave(0.8);

    const token: CancelToken = { cancelled: false, jobId: null };
    cancelRef.current = token;

    phCapture("transcription_started", { language, duration_sec: durationSec });

    let lastStage = "", lastChunks = 0;
    const onProgress = (pr: JobProgress) => {
      // Honest pipeline timeline (rendered inside InputCard) — drives the radar too.
      if (pr.pipeline_steps) setPipeline(pr.pipeline_steps);
      if (pr.chunks_total) {
        if ((pr.chunks_done || 0) > lastChunks) { lastChunks = pr.chunks_done || 0; dotsRef.current?.wave(1); }
        setChunkProgress({ done: pr.chunks_done || 0, total: pr.chunks_total });
        setStatus(`chunk ${pr.chunks_done || 0}/${pr.chunks_total} · transcribing…`);
      } else {
        setChunkProgress(null);
        if (pr.stage && pr.stage !== lastStage) {
          lastStage = pr.stage; dotsRef.current?.wave(1);
          setStatus(STAGE_LABELS[pr.stage] || "");
        }
      }
    };

    const currentQuality = loadSettings().quality;

    try {
      const segments = await transcribe(
        blob,
        {
          language, numSpeakers: speakers, durationSec, prompt: context,
          quality: currentQuality === "best" ? "best" : undefined,
          recordingId: archive.recordingId ?? crypto.randomUUID(),
          source: archive.source ?? (sessionId ? "record" : "upload"),
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
        setStatus(""); setLiveSegs([]); if (sessionId) void idbDeleteSession(sessionId); setRecover(null);
      } else {
        setStatusKind("error");
        setStatus(`failed: ${e instanceof Error ? e.message : e}`);
        setRecover({ blob, durationSec, sizeMb: blob.size / 1048576, sessionId, source: "failed" });
        notify("Skriptly — transcription failed", "The recording is kept — you can retry.");
        phCapture("transcription_failed", { error: String(e), duration_sec: durationSec });
      }
    } finally {
      cancelRef.current = null; setCooking(false); setPipeline(null); setChunkProgress(null);
    }
  }, [cooking, language, speakers, context, finishWithSegments]);

  const onCancel = useCallback(() => {
    const tok = cancelRef.current;
    if (!tok) return;
    tok.cancelled = true;
    if (tok.jobId) void cancelJob(tok.jobId);
    setStatus("cancelling…");
    phCapture("transcription_cancelled");
  }, []);

  const onFile = useCallback(async (f: File) => {
    if (!passLimitGate()) return;
    setStatus("reading file…");
    phCapture("file_uploaded", { type: f.type, size_mb: +(f.size / 1048576).toFixed(2) });
    const dur = await probeDuration(f);

    let toUpload: Blob = f;
    if (shouldExtractAudio(f)) {
      setStatusKind("info"); setStatus("compressing audio…");
      try {
        toUpload = await extractAudioTrack(f, (ratio) => setStatus(`compressing audio… ${Math.round(ratio * 100)}%`));
        phCapture("audio_extracted", {
          original_mb: +(f.size / 1048576).toFixed(2),
          compressed_mb: +(toUpload.size / 1048576).toFixed(2),
        });
      } catch {
        toUpload = f; // extraction failed — fall back to uploading the original
      }
    }
    void cookBlob(toUpload, dur);
  }, [passLimitGate, cookBlob]);

  const onRecToggle = useCallback(async () => {
    if (recording) {
      const rec = recorderRef.current;
      recorderRef.current = null;
      window.clearInterval(recTimerRef.current);
      setRecording(false);
      levelsRef.current = { mic: 0, sys: 0 };
      keepAliveStopRef.current?.(); keepAliveStopRef.current = null;
      const live = liveRef.current;
      liveRef.current = null;
      if (live) {
        // Досылаем хвост и ждём последние слова параллельно с остановкой записи.
        void live.stop().then((st) => phCapture("live_transcript_stopped", { ...st }));
      }
      if (rec) {
        const { blob, durationSec, stats } = await rec.stop();
        void cookBlob(blob, durationSec, rec.sessionId, { recordingId: rec.recordingId, source: "record" });
        if (session?.user) {
          const { browser, os } = detectBrowserOS();
          phCapture("capture_stats", { ...stats, duration_sec: durationSec });
          void insertCaptureStats({
            user_id: session.user.id,
            recording_id: stats.recordingId,
            session_id: rec.sessionId,
            has_system_audio: stats.hasSystemAudio,
            mic_device_label: stats.micDeviceLabel,
            rms_mic_avg: stats.rmsMicAvg,
            rms_system_avg: stats.rmsSystemAvg,
            silent_seconds_mic: stats.silentSecondsMic,
            silent_seconds_system: stats.silentSecondsSystem,
            track_ended_events: stats.trackEndedEvents,
            duration_sec: durationSec,
            browser, os,
            display_surface: stats.displaySurface,
            events: stats.events,
          }).catch((err) => console.error("[capture_stats] insert failed:", err));
        }
      }
      return;
    }
    if (!passLimitGate()) return;
    try {
      const warn = await batteryWarning();
      if (warn && !window.confirm(warn)) return;
      ensureNotifyPermission();
      setLimitHit(false); setStatusKind("info"); setStatus("requesting microphone…");
      captureAlertRef.current = false;
      recorderRef.current = await startRecording({
        onSystemAudioMissing: () => window.confirm(`${systemAudioHelp()}\n\nContinue with microphone only?`),
        onSystemAudioLost: () => {
          captureAlertRef.current = true;
          setStatusKind("error");
          setStatus("call audio stopped — the other side is no longer being recorded. Stop and record again, sharing the call tab with “Share tab audio”");
          notify("Skriptly — call audio lost", "The other side of the call is no longer being recorded.");
          phCapture("capture_system_audio_lost");
        },
        onSystemAudioSilent: () => {
          captureAlertRef.current = true;
          setStatusKind("error");
          setStatus("we can't hear the other side — check that you shared the tab with the call and ticked “Share tab audio”");
          notify("Skriptly — can't hear the call", "No sound from the shared tab for a minute. Check the tab you shared.");
          phCapture("capture_system_audio_silent");
        },
        onMicDead: (label) => {
          captureAlertRef.current = true;
          setStatusKind("error");
          setStatus(`your microphone${label ? ` “${label}”` : ""} sends no sound — you won't be in the transcript. Pick a working microphone in your system sound settings (a Mac often picks a nearby iPhone automatically)`);
          notify("Skriptly — microphone is silent", "Your microphone sends no sound. Pick another one in system settings.");
          phCapture("capture_mic_dead", { label });
        },
        onMicSwitched: (label, reason) => {
          if (reason === "dead") {
            captureAlertRef.current = false;
            setStatusKind("info");
            setStatus(`recording — the selected microphone sent no sound, switched to ${label || "another one"}`);
            phCapture("capture_mic_dead_recovered", { label });
            return;
          }
          if (captureAlertRef.current) return;
          setStatusKind("info");
          setStatus(`recording — microphone switched to ${label || "a new device"}`);
        },
        onLevels: (mic, sys) => { levelsRef.current = { mic, sys }; },
      });
      keepAliveStopRef.current = await startKeepAlive();
      setLiveSegs([]); setLiveStatus("connecting");
      const rec = recorderRef.current;
      const live = new LiveTranscript({
        recordingId: rec.recordingId, language, context, numSpeakers: speakers,
        mic: rec.liveStreams.mic, call: rec.liveStreams.call,
        onUpdate: setLiveSegs,
        onStatus: (st) => {
          setLiveStatus(st);
          if (st === "off") phCapture("live_transcript_unavailable");
        },
      });
      liveRef.current = live;
      live.start();
      phCapture("live_transcript_started", { channels: rec.liveStreams.call ? 2 : 1 });
      setRecSeconds(0); setRecording(true); setActiveId(null);
      setStatus("recording — share a tab to capture call audio too");
      recTimerRef.current = window.setInterval(() => setRecSeconds((s) => s + 1), 1000);
      phCapture("recording_started");
    } catch (e) {
      if (e instanceof SystemAudioMissingError) {
        setStatusKind("info"); setStatus("recording cancelled — share tab/window audio, or record with microphone only next time");
        return;
      }
      setStatusKind("error"); setStatus(`microphone access failed: ${e instanceof Error ? e.message : e}`);
    }
  }, [recording, passLimitGate, cookBlob, session, language, context, speakers]);

  useEffect(() => { onRecToggleRef.current = onRecToggle; }, [onRecToggle]);
  useEffect(() => () => {
    window.clearInterval(recTimerRef.current); keepAliveStopRef.current?.(); void liveRef.current?.stop();
  }, []);

  // ── Undo-delete ─────────────────────────────────────────────────
  const dismissUndo = useCallback((flush = true) => {
    window.clearTimeout(undoTimerRef.current);
    setUndoEntry(null);
    if (flush && undoEntry) {
      void deleteEntry(undoEntry.id).catch((err) => console.error("[history] delete failed:", err));
    }
  }, [undoEntry]);

  const handleDelete = useCallback((id: string) => {
    if (id === "demo") return;
    const entry = entries.find((e) => e.id === id);
    if (!entry) return;
    if (undoEntry) {
      window.clearTimeout(undoTimerRef.current);
      void deleteEntry(undoEntry.id).catch(() => {});
    }
    setEntries((prev) => prev.filter((e) => e.id !== id));
    if (activeId === id) setActiveId(null);
    setUndoEntry(entry);
    undoTimerRef.current = window.setTimeout(() => {
      void deleteEntry(id).catch((err) => console.error("[history] delete failed:", err));
      setUndoEntry(null);
    }, 7000);
  }, [entries, activeId, undoEntry]);

  const handleUndo = useCallback(() => {
    if (!undoEntry) return;
    window.clearTimeout(undoTimerRef.current);
    setEntries((prev) => {
      const withEntry = [undoEntry, ...prev];
      return withEntry.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    });
    setUndoEntry(null);
  }, [undoEntry]);

  useEffect(() => () => window.clearTimeout(undoTimerRef.current), []);

  // ── Keyboard shortcuts ───────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isInput = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;

      if ((e.metaKey || e.ctrlKey) && e.key === "\\") { e.preventDefault(); setSbOpen((v) => !v); return; }
      if ((e.metaKey || e.ctrlKey) && e.key === ",") { e.preventDefault(); setSettingsOpen((v) => !v); return; }
      if ((e.metaKey || e.ctrlKey) && (e.key === "d" || e.key === "D")) {
        e.preventDefault();
        const current = (document.documentElement.getAttribute("data-theme") || "light") as "light" | "dark";
        applyThemeSmooth(current === "light" ? "dark" : "light");
        return;
      }
      if (e.key === "Escape") { setSbOpen(false); setSettingsOpen(false); setHotkeysOpen(false); return; }

      if (isInput) return;

      if (e.key === "?") { setHotkeysOpen((v) => !v); return; }
      if ((e.key === "r" || e.key === "R") && !e.metaKey && !e.ctrlKey) {
        if (viewRef.current === "INPUT") { void onRecToggleRef.current?.(); }
        return;
      }
      if (viewRef.current === "OUTPUT") {
        if (e.key === "1") { setActiveTab("transcript"); return; }
        if (e.key === "2") { setActiveTab("summary"); return; }
        if (e.key === "3") { setActiveTab("actions"); return; }
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  // ── Projects ─────────────────────────────────────────────────────
  const handleCreateProject = useCallback((name: string) => {
    const p: Project = { id: crypto.randomUUID(), name, entryIds: [], createdAt: new Date().toISOString() };
    setProjects((prev) => { const next = [...prev, p]; saveProjects(next); return next; });
  }, []);

  const handleDeleteProject = useCallback((id: string) => {
    setProjects((prev) => { const next = prev.filter((p) => p.id !== id); saveProjects(next); return next; });
  }, []);

  const handleMoveEntry = useCallback((entryId: string, targetProjectId: string | null) => {
    setProjects((prev) => {
      const next = prev.map((p) => ({
        ...p,
        entryIds: p.id === targetProjectId
          ? (p.entryIds.includes(entryId) ? p.entryIds : [...p.entryIds, entryId])
          : p.entryIds.filter((id) => id !== entryId),
      }));
      saveProjects(next);
      return next;
    });
  }, []);

  // ── Render ───────────────────────────────────────────────────────
  if (session === undefined) return <div className="ink-root" />;
  if (!session) return <LoginScreen />;

  const plan = profile?.plan || "free";
  const dotMode = settingsOpen || view === "OUTPUT" ? "reading" : "live";
  // workspace?.id is the reliable check: API returns non-null object with empty fields when no workspace
  const inWorkspace = !!(workspace?.id);

  return (
    <div className={`ink-root${sbOpen ? " sb-open" : ""}${team ? " team" : ""}`}>
      <InkSidebar
        open={sbOpen}
        team={team}
        entries={displayedEntries}
        activeId={activeId}
        profile={profile}
        hasWorkspace={inWorkspace}
        uiLang={uiLang}
        projects={projects}
        onCreateProject={handleCreateProject}
        onDeleteProject={handleDeleteProject}
        onMoveEntry={handleMoveEntry}
        onClose={() => setSbOpen(false)}
        onTeamChange={setTeam}
        onSelect={(id) => setActiveId(id)}
        onDelete={handleDelete}
        onSignOut={() => { void sb.auth.signOut(); }}
        onSettings={() => setSettingsOpen(true)}
      />

      <header className="i-topbar">
        <button
          type="button"
          className="i-iconbtn"
          aria-label="Open sidebar (⌘\\)"
          onClick={() => setSbOpen((v) => !v)}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <path d="M4 6h16M4 12h16M4 18h10" />
          </svg>
        </button>
        <div className="i-topbar-side">
          <button
            type="button"
            className="i-iconbtn"
            aria-label="Keyboard shortcuts (?)"
            onClick={() => setHotkeysOpen((v) => !v)}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="4" width="20" height="16" rx="2" />
              <path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M8 13h.01M12 13h.01M16 13h.01M6 17h12" />
            </svg>
          </button>
          <button
            type="button"
            className="i-iconbtn"
            aria-label="Settings (⌘,)"
            onClick={() => setSettingsOpen(true)}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
            </svg>
          </button>
          <InkThemeToggle />
        </div>
      </header>

      <main className="i-hero">
        <DotField ref={dotsRef} anchorRef={stageRef} mode={dotMode} processing={cooking} />
        <div className="i-center">
          <div ref={stageRef}>
            {view === "OUTPUT" && activeEntry ? (
              <>
                <button type="button" className="i-back" onClick={() => setActiveId(null)}>
                  {activeEntry.id === "demo" ? "← Try it yourself" : "← New recording"}
                </button>
                <ResultView
                  key={activeEntry.id}
                  entry={activeEntry}
                  plan={plan}
                  notionConnected={profile?.notion_connected}
                  activeTab={activeTab}
                  onTabChange={setActiveTab}
                  onPatch={(fields, db) => patchLocal(activeEntry.id, fields, db)}
                  autoSummaryPending={autoSummaryIds.has(activeEntry.id)}
                  onUpgrade={() => { setSettingsSection("subscription"); setSettingsOpen(true); }}
                />
                {status && (
                  <p className={`i-status${statusKind === "error" ? " err" : ""}`} aria-live="polite">
                    {status}
                  </p>
                )}
              </>
            ) : (
              <>
                <h1 className="i-title">Say it <em>messy</em>.</h1>
                <p className="i-sub">Talk it into shape — come back to clean, structured text.</p>

                <InputCard
                  cooking={cooking}
                  pipeline={pipeline}
                  chunkProgress={chunkProgress}
                  recording={recording}
                  recSeconds={recSeconds}
                  levelsRef={levelsRef}
                  language={language}
                  onLanguage={(v) => { setLanguage(v); saveSettings({ language: v }); }}
                  speakers={speakers}
                  onSpeakers={(v) => { setSpeakers(v); saveSettings({ speakers: v }); }}
                  context={context}
                  onContext={setContext}
                  onFile={(f) => void onFile(f)}
                  onRecToggle={() => void onRecToggle()}
                  inWorkspace={inWorkspace}
                  visibility={visibility}
                  onVisibility={setVisibility}
                />

                <div className="i-status-row">
                  <p className={`i-status${statusKind === "error" ? " err" : ""}`} aria-live="polite">
                    {/* Suppress chunk text when the StepTimeline already shows it inline */}
                    {chunkProgress && pipeline ? "" : status}
                  </p>
                  {cooking && (
                    <button type="button" className="i-cancel" onClick={onCancel}>[Cancel]</button>
                  )}
                </div>

                {/* Остаётся и после неудачной транскрипции: юзер хотя бы видит, что говорилось */}
                {(liveSegs.length > 0 || (recording && liveStatus !== "off")) && (
                  <LivePanel segments={liveSegs} status={liveStatus} recording={recording} cooking={cooking} />
                )}

                {limitHit && !cooking && (
                  <UpgradeCard
                    title="You've used all your minutes"
                    body="Upgrade your plan to keep transcribing this month."
                    onUpgrade={() => { setSettingsSection("subscription"); setSettingsOpen(true); }}
                  />
                )}

                {recover && !cooking && !recording && (
                  <div className="i-recover">
                    <span className="i-recover-text">
                      {recover.source === "crash" ? "Unfinished recording found" : "Upload failed — recording kept"}
                      <span className="sub">
                        ≈{Math.max(1, Math.round(recover.durationSec / 60))} min · {recover.sizeMb.toFixed(1)} MB
                      </span>
                    </span>
                    <button
                      type="button"
                      className="i-pill on"
                      onClick={() => void cookBlob(recover.blob, recover.durationSec, recover.sessionId)}
                    >Cook it</button>
                    <button type="button" className="i-pill" onClick={() => downloadBlob(recover.blob)}>
                      Download
                    </button>
                    <button
                      type="button"
                      className="i-pill"
                      onClick={() => { if (recover.sessionId) void idbDeleteSession(recover.sessionId); setRecover(null); }}
                    >Discard</button>
                  </div>
                )}

                {/* Onboarding — shown only when no real entries yet */}
                {!entries.length && !cooking && !recording && (
                  <div className="i-onboard">
                    <svg
                      className="i-onboard-icon"
                      width="36" height="36" viewBox="0 0 24 24"
                      fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"
                    >
                      <path d="M9 18V5l12-2v13"/>
                      <circle cx="6" cy="18" r="3"/>
                      <circle cx="18" cy="16" r="3"/>
                    </svg>
                    <p className="i-onboard-h">Welcome to Skriptly</p>
                    <p className="i-onboard-p">
                      Record a call, upload an audio file, or explore the demo transcript in the sidebar.
                    </p>
                    <ul className="i-onboard-steps">
                      <li>Click <strong>Record</strong> and talk — stop to transcribe</li>
                      <li>Or drag and drop any audio / video file</li>
                      <li>Open the sidebar to see the demo transcript</li>
                    </ul>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </main>

      {/* ── Settings Modal ── */}
      {settingsOpen && (
        <SettingsModal
          session={session}
          profile={profile}
          settings={settings}
          onSettingsChange={(patch) => setSettings((prev) => ({ ...prev, ...patch }))}
          onClose={() => { setSettingsOpen(false); setSettingsSection("account"); }}
          onSignOut={() => { void sb.auth.signOut(); }}
          workspace={workspace}
          onWorkspaceChange={setWorkspace}
          uiLang={uiLang}
          onUiLangChange={handleUiLangChange}
          initialSection={settingsSection}
        />
      )}

      {/* ── Hotkeys Overlay ── */}
      {hotkeysOpen && <HotkeysOverlay onClose={() => setHotkeysOpen(false)} />}

      {/* ── Undo Delete Toast ── */}
      {undoEntry && (
        <UndoToast onUndo={handleUndo} onDismiss={() => dismissUndo(true)} />
      )}
    </div>
  );
}

function InkThemeToggle() {
  const [theme, setTheme] = useState<"light" | "dark">("light");

  useEffect(() => {
    setTheme((document.documentElement.getAttribute("data-theme") || "light") as "light" | "dark");
    const sync = () => {
      setTheme((document.documentElement.getAttribute("data-theme") || "light") as "light" | "dark");
    };
    document.addEventListener("ink-theme-toggle", sync);
    return () => document.removeEventListener("ink-theme-toggle", sync);
  }, []);

  const toggle = () => {
    applyThemeSmooth(theme === "light" ? "dark" : "light");
  };

  return (
    <button type="button" className="i-iconbtn" onClick={toggle} aria-label="Toggle theme (⌘D)">
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
