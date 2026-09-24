"use client";
import { memo, useEffect, useLayoutEffect, useRef } from "react";
import type { LiveSegment, LiveStatus } from "@/lib/ink/live";

// Живой транскрипт под карточкой записи: текст по спикерам появляется по ходу
// разговора. Остаётся на экране, пока готовится финальный транскрипт.
// Цвета/подписи спикеров те же, что в ResultView, чтобы переход был бесшовным.

const SPK_COLORS = ["var(--i-spk-1)", "var(--i-spk-2)", "var(--i-spk-3)", "var(--i-spk-4)"];

function spkIndex(label: string): number {
  const m = label.match(/(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

const STATUS_LABEL: Record<LiveStatus, string> = {
  connecting: "connecting…",
  live: "live",
  reconnecting: "reconnecting…",
  off: "unavailable",
};

const Row = memo(function Row({ seg }: { seg: LiveSegment }) {
  const i = spkIndex(seg.speaker);
  return (
    <div className="i-live-seg">
      <div className="i-seg-head">
        <span className="i-spk" style={{ color: SPK_COLORS[i % SPK_COLORS.length] }}>Speaker {i + 1}</span>
        <span className="i-seg-time">{fmtTime(seg.start)}</span>
      </div>
      <p className="i-seg-text">
        {seg.text}
        {seg.pending && <span className="i-live-pending">{seg.text ? " " : ""}{seg.pending}</span>}
      </p>
    </div>
  );
}, (a, b) => a.seg.text === b.seg.text && a.seg.pending === b.seg.pending && a.seg.speaker === b.seg.speaker);

export function LivePanel({ segments, status, recording, cooking }: {
  segments: LiveSegment[];
  status: LiveStatus;
  recording: boolean;
  cooking: boolean;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true); // юзер у низа — едем за текстом; прокрутил вверх — не дёргаем

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const onScroll = () => { stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48; };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useLayoutEffect(() => {
    const el = boxRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [segments]);

  const on = recording && status === "live";
  return (
    <section className="i-live" aria-label="Live transcript">
      <header className="i-live-head">
        <span className={`i-live-dot${on ? " on" : ""}`} aria-hidden />
        <span className="i-live-title">Live transcript</span>
        <span className="i-live-state">
          {recording ? STATUS_LABEL[status] : cooking ? "preview · final transcript is on its way" : "preview"}
        </span>
      </header>
      <div ref={boxRef} className="i-live-box">
        {segments.length ? (
          segments.map((s) => <Row key={s.key} seg={s} />)
        ) : (
          <p className="i-live-empty">
            {status === "off" ? "Live text isn't available right now — your recording is unaffected." : "Listening… text will appear as people speak."}
          </p>
        )}
      </div>
    </section>
  );
}
