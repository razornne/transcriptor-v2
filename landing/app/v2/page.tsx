"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { DotField, type DotFieldHandle } from "@/components/ink/DotField";
import { InputCard } from "@/components/ink/InputCard";
import { InkSidebar } from "@/components/ink/InkSidebar";

// /v2 — Ink & Halftone, главный экран (Phase 1: визуальный каркас + mock).
// Старый Studio v2 (components/studio/*) отменён по направлению 2026-06-12,
// файлы оставлены dormant. ML/API сюда подключаются в Phase 2-3:
// Cook-симуляция ниже один-в-один повторяет контракт реального прогресса
// (stage / chunks_done / chunks_total из /api/jobs polling).

const CHUNKS = 6; // mock: число чанков "длинной" записи

export default function InkPage() {
  const [sbOpen, setSbOpen] = useState(false);
  const [team, setTeam] = useState(false);
  const [cooking, setCooking] = useState(false);
  const [done, setDone] = useState(false);
  const [status, setStatus] = useState("");
  const dotsRef = useRef<DotFieldHandle>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const timersRef = useRef<number[]>([]);

  const clearTimers = () => {
    timersRef.current.forEach((t) => window.clearTimeout(t));
    timersRef.current = [];
  };
  useEffect(() => clearTimers, []);

  const startCook = useCallback(() => {
    if (cooking) return;
    clearTimers();
    setDone(false);
    setCooking(true);
    setSbOpen(false);

    // Тайм-лайн = реальные стадии пайплайна; каждая шлёт волну по точкам.
    type Step = { label: string; ms: number; amp?: number };
    const steps: Step[] = [
      { label: "uploading…", ms: 450, amp: 0.7 },
      { label: "splitting audio…", ms: 600, amp: 0.8 },
      ...Array.from({ length: CHUNKS }, (_, k) => ({
        label: `chunk ${k + 1}/${CHUNKS} · transcribing…`,
        ms: 680,
        amp: 1,
      })),
      { label: "stitching speakers…", ms: 800, amp: 1.1 },
      { label: "correcting terms…", ms: 650, amp: 1 },
    ];

    let at = 0;
    steps.forEach((s) => {
      timersRef.current.push(
        window.setTimeout(() => {
          setStatus(s.label);
          dotsRef.current?.wave(s.amp ?? 1);
        }, at),
      );
      at += s.ms;
    });
    timersRef.current.push(
      window.setTimeout(() => {
        setStatus("done in 0:42 · saved to history");
        dotsRef.current?.wave(1.8);
        setCooking(false);
        setDone(true);
      }, at),
    );
  }, [cooking]);

  // Шорткаты: ⌘\ / Ctrl+\ — сайдбар, Esc — закрыть
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "\\") {
        e.preventDefault();
        setSbOpen((v) => !v);
        return;
      }
      if (e.key === "Escape") setSbOpen(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  return (
    <div className={`ink-root${sbOpen ? " sb-open" : ""}${team ? " team" : ""}`}>
      <InkSidebar
        open={sbOpen}
        team={team}
        onClose={() => setSbOpen(false)}
        onTeamChange={setTeam}
      />

      <header className="i-topbar">
        <button
          type="button"
          className="i-iconbtn"
          aria-label="Open sidebar (⌘\)"
          onClick={() => setSbOpen((v) => !v)}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <path d="M4 6h16M4 12h16M4 18h10" />
          </svg>
        </button>
        <div className="i-topbar-side">
          <InkThemeToggle />
          <div className="i-avatar">NB</div>
        </div>
      </header>

      <main className="i-hero">
        <DotField ref={dotsRef} cardRef={cardRef} />
        <div className="i-center">
          <h1 className="i-title">
            Say it <em>messy</em>.
          </h1>
          <p className="i-sub">Talk it into shape — come back to clean, structured text.</p>

          <InputCard ref={cardRef} cooking={cooking} onCook={startCook} />

          <p className="i-status" aria-live="polite">{status}</p>

          {done && (
            <div className="i-result">
              <div className="i-result-head">
                <span className="i-result-title">Client call — billing · summary</span>
                <span className="i-result-meta">2 speakers · 47m</span>
              </div>
              <p className="i-result-body">
                Agreed to merge three surveys into one sheet with a type filter;
                dashboard MVP owned by Artem, due Sunday. Payment deltas under
                100k traced to unfiltered commercial units…
              </p>
              <div className="i-result-actions">
                <button type="button" className="i-pill">Copy</button>
                <button type="button" className="i-pill">.md</button>
                <button type="button" className="i-pill">Send to Notion</button>
                <button
                  type="button"
                  className="i-pill"
                  onClick={() => { setDone(false); setStatus(""); }}
                >
                  ＋ New
                </button>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

// Тот же глобальный механизм темы, что и у landing (data-theme + localStorage)
function InkThemeToggle() {
  const [theme, setTheme] = useState<"light" | "dark">("light");

  useEffect(() => {
    const current = (document.documentElement.getAttribute("data-theme") || "light") as
      | "light"
      | "dark";
    setTheme(current);
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
