"use client";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { sb } from "@/lib/ink/supabase";
import {
  adminListRecordings, adminGetRecording, adminRecordingAudio,
  type ArchivedRecording,
} from "@/lib/ink/api";

// /app/review — admin-only archive of every recording for error analysis:
// raw pipeline output next to the audio (each stereo channel separately)
// and the capture telemetry of that call.

function fmtDur(sec: number | null | undefined): string {
  if (!sec && sec !== 0) return "—";
  const s = Math.round(sec);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}` : `${m}:${String(ss).padStart(2, "0")}`;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

type Flag = { label: string; bad: boolean };

function flagsOf(r: ArchivedRecording): Flag[] {
  const out: Flag[] = [];
  if (r.error) out.push({ label: "failed", bad: true });
  else if (!r.completed_at) out.push({ label: "no result", bad: false });
  const c = r.capture;
  if (r.source === "record" && c) {
    const dur = c.duration_sec || r.duration_sec || 0;
    const pct = (s: number | null) => (dur ? Math.round(((s ?? 0) / dur) * 100) : 0);
    if (!c.has_system_audio) out.push({ label: "no call audio", bad: true });
    else if (pct(c.silent_seconds_system) > 90) out.push({ label: `call silent ${pct(c.silent_seconds_system)}%`, bad: true });
    if (pct(c.silent_seconds_mic) > 90) out.push({ label: `mic silent ${pct(c.silent_seconds_mic)}%`, bad: true });
    if (c.events.some((e) => e.type === "system_audio_ended")) out.push({ label: "call audio lost", bad: true });
    if (c.events.some((e) => e.type === "mic_lost")) out.push({ label: "mic lost", bad: true });
    const switches = c.events.filter((e) => e.type === "mic_switch").length;
    if (switches) out.push({ label: `mic switched ×${switches}`, bad: false });
  }
  return out;
}

type Mode = "both" | "mic" | "call";

function ChannelPlayer({ id, stereo, audioRef }: { id: string; stereo: boolean; audioRef: RefObject<HTMLAudioElement> }) {
  const graphRef = useRef<{ ctx: AudioContext; l: GainNode; r: GainNode } | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [mode, setMode] = useState<Mode>("both");

  useEffect(() => {
    let alive = true;
    let objectUrl: string | null = null;
    adminRecordingAudio(id)
      .then((b) => { if (!alive) return; objectUrl = URL.createObjectURL(b); setUrl(objectUrl); })
      .catch((e) => alive && setErr(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      void graphRef.current?.ctx.close().catch(() => {});
    };
  }, [id]);

  const applyMode = useCallback((m: Mode) => {
    const g = graphRef.current;
    if (!g) return;
    g.l.gain.value = m === "call" ? 0 : 1;
    g.r.gain.value = m === "mic" ? 0 : 1;
  }, []);

  // Split L (mic) / R (call) and route the chosen channel(s) to both ears.
  const ensureGraph = () => {
    if (graphRef.current || !audioRef.current) return;
    const ctx = new AudioContext();
    const src = ctx.createMediaElementSource(audioRef.current);
    const split = ctx.createChannelSplitter(2);
    const merge = ctx.createChannelMerger(2);
    const l = ctx.createGain(), r = ctx.createGain();
    src.connect(split);
    split.connect(l, 0);
    split.connect(r, 1);
    for (const g of [l, r]) { g.connect(merge, 0, 0); g.connect(merge, 0, 1); }
    merge.connect(ctx.destination);
    graphRef.current = { ctx, l, r };
    applyMode(mode);
  };

  useEffect(() => { applyMode(mode); }, [mode, applyMode]);

  if (err) return <p className="i-rv-err">Audio unavailable: {err}</p>;
  return (
    <div className="i-rv-player">
      {url ? (
        <audio
          ref={audioRef}
          src={url}
          controls
          preload="metadata"
          onPlay={() => { ensureGraph(); void graphRef.current?.ctx.resume(); }}
        />
      ) : <p className="i-rv-muted">Loading audio…</p>}
      {stereo && (
        <div className="i-rv-seg" role="group" aria-label="Channel">
          {(["both", "mic", "call"] as Mode[]).map((m) => (
            <button key={m} type="button" className={mode === m ? "on" : ""} onClick={() => setMode(m)}>
              {m === "both" ? "Both" : m === "mic" ? "Mic (L)" : "Call (R)"}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Detail({ id }: { id: string }) {
  const [rec, setRec] = useState<ArchivedRecording | null>(null);
  const [err, setErr] = useState("");
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    let alive = true;
    setRec(null); setErr("");
    adminGetRecording(id)
      .then((r) => alive && setRec(r))
      .catch((e) => alive && setErr(e instanceof Error ? e.message : String(e)));
    return () => { alive = false; };
  }, [id]);

  if (err) return <p className="i-rv-err">{err}</p>;
  if (!rec) return <p className="i-rv-muted">Loading…</p>;
  const c = rec.capture;
  const seek = (t: number) => {
    const a = audioRef.current;
    if (!a) return;
    a.currentTime = t;
    void a.play();
  };

  return (
    <div className="i-rv-detail">
      <div className="i-rv-dhead">
        <h2>{rec.user_email || "unknown user"}</h2>
        <p className="i-rv-muted">
          {fmtDate(rec.created_at)} · {rec.source} · {fmtDur(rec.duration_sec)} · {rec.language || "auto"} ·
          {" "}spk {rec.num_speakers ?? "auto"} · {rec.quality} · {((rec.size_bytes || 0) / 1048576).toFixed(1)} MB
        </p>
        <div className="i-rv-flags">
          {flagsOf(rec).map((f) => <span key={f.label} className={`i-rv-flag${f.bad ? " bad" : ""}`}>{f.label}</span>)}
        </div>
      </div>

      <ChannelPlayer key={rec.id} id={rec.id} stereo={rec.source === "record"} audioRef={audioRef} />

      {rec.error && <pre className="i-rv-errbox">{rec.error}</pre>}

      {c && (
        <section>
          <h3>Capture</h3>
          <dl className="i-rv-kv">
            <dt>Call audio</dt><dd>{c.has_system_audio ? `yes (${c.display_surface || "?"})` : "no"}</dd>
            <dt>Mic</dt><dd>{c.mic_device_label || "—"}</dd>
            <dt>Silent: mic / call</dt><dd>{fmtDur(c.silent_seconds_mic)} / {c.has_system_audio ? fmtDur(c.silent_seconds_system) : "—"}</dd>
            <dt>Level: mic / call</dt><dd>{(c.rms_mic_avg ?? 0).toFixed(3)} / {(c.rms_system_avg ?? 0).toFixed(3)}</dd>
            <dt>Browser</dt><dd>{c.browser} · {c.os}</dd>
          </dl>
          {c.events.length > 0 && (
            <ul className="i-rv-events">
              {c.events.map((e, i) => (
                <li key={i}>
                  <button type="button" onClick={() => seek(e.t)}>{fmtDur(e.t)}</button>
                  {e.type === "mic_switch" ? ` mic switched (${e.reason}): ${e.from || "?"} → ${e.to || "?"}` : ` ${e.type.replace(/_/g, " ")}`}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {rec.vocab_additions && rec.vocab_additions.length > 0 && (
        <section>
          <h3>Gemini corrections learned</h3>
          <p className="i-rv-muted">{rec.vocab_additions.map((v) => `${v.wrong} → ${v.right}`).join(" · ")}</p>
        </section>
      )}

      <section>
        <h3>Raw transcript</h3>
        {rec.segments && rec.segments.length ? (
          <ol className="i-rv-segs">
            {rec.segments.map((s, i) => (
              <li key={i}>
                <button type="button" onClick={() => seek(s.start)}>{fmtDur(s.start)}</button>
                <span className="i-rv-spk">{s.speaker}</span>
                <span>{s.text}</span>
              </li>
            ))}
          </ol>
        ) : <p className="i-rv-muted">No segments stored.</p>}
      </section>
    </div>
  );
}

export default function ReviewPage() {
  const [state, setState] = useState<"loading" | "signed-out" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [rows, setRows] = useState<ArchivedRecording[]>([]);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const { data } = await sb.auth.getSession();
      if (!data.session) { setState("signed-out"); return; }
      try {
        const list = await adminListRecordings();
        setRows(list);
        setSelected(list[0]?.id ?? null);
        setState("ready");
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setState("error");
      }
    })();
  }, []);

  return (
    <div className="ink-root i-rv-root">
      <header className="i-rv-top">
        <a href="/app" className="i-rv-back">← Skriptly</a>
        <h1>Recording review</h1>
        <span className="i-rv-muted">{state === "ready" ? `${rows.length} recordings · kept 90 days` : ""}</span>
      </header>
      {state === "loading" && <p className="i-rv-muted i-rv-pad">Loading…</p>}
      {state === "signed-out" && <p className="i-rv-pad">Sign in at <a href="/app">/app</a> first.</p>}
      {state === "error" && <p className="i-rv-err i-rv-pad">{error === "admin only" ? "This page is for admins only." : error}</p>}
      {state === "ready" && (
        <div className="i-rv-body">
          <ul className="i-rv-list">
            {rows.length === 0 && <li className="i-rv-muted">No archived recordings yet.</li>}
            {rows.map((r) => (
              <li key={r.id}>
                <button type="button" className={selected === r.id ? "on" : ""} onClick={() => setSelected(r.id)}>
                  <span className="i-rv-row1">
                    <span>{r.user_email || "?"}</span>
                    <span className="i-rv-muted">{fmtDur(r.duration_sec)}</span>
                  </span>
                  <span className="i-rv-row2 i-rv-muted">{fmtDate(r.created_at)} · {r.source} · {r.language || "auto"}</span>
                  <span className="i-rv-flags">
                    {flagsOf(r).map((f) => <span key={f.label} className={`i-rv-flag${f.bad ? " bad" : ""}`}>{f.label}</span>)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <main className="i-rv-main">
            {selected ? <Detail key={selected} id={selected} /> : <p className="i-rv-muted">Select a recording.</p>}
          </main>
        </div>
      )}
    </div>
  );
}
