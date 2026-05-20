"use client";
import { useEffect, useRef, useState } from "react";

const REDUCED = typeof window !== "undefined"
  && window.matchMedia
  && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// ─── useTypewriter ──────────────────────────────────────────────
// Печатает строку посимвольно, держит, стирает, печатает заново.
// enabled=false → возвращает полную строку сразу (для статичных копий).
export function useTypewriter(
  text: string,
  opts: { speed?: number; holdMs?: number; restartMs?: number; loop?: boolean; enabled?: boolean } = {},
): string {
  const { speed = 32, holdMs = 5000, restartMs = 800, loop = true, enabled = true } = opts;
  const [count, setCount] = useState<number>(
    REDUCED || !enabled ? text.length : 0,
  );

  useEffect(() => {
    if (REDUCED || !enabled) { setCount(text.length); return; }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const sched = (fn: () => void, ms: number) => {
      timer = setTimeout(() => { if (!cancelled) fn(); }, ms);
    };
    function typeStep(n: number) {
      if (cancelled) return;
      setCount(n);
      if (n < text.length) {
        sched(() => typeStep(n + 1), speed);
      } else if (loop) {
        sched(() => {
          setCount(0);
          sched(() => typeStep(1), restartMs);
        }, holdMs);
      }
    }
    setCount(0);
    sched(() => typeStep(1), 600);
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [text, speed, holdMs, restartMs, loop, enabled]);

  return text.slice(0, count);
}

// ─── useReveal ──────────────────────────────────────────────────
// Добавляет .in на все элементы .reveal когда они появляются в viewport.
export function useReveal() {
  useEffect(() => {
    const els = document.querySelectorAll(".reveal:not(.in)");
    if (!("IntersectionObserver" in window)) {
      els.forEach((e) => e.classList.add("in"));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((en) => {
          if (en.isIntersecting) {
            en.target.classList.add("in");
            io.unobserve(en.target);
          }
        });
      },
      { rootMargin: "0px 0px -10% 0px", threshold: 0.05 },
    );
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
  }, []);
}

// ─── useParallax ────────────────────────────────────────────────
// Параллакс light-blobs за курсором. Селектор + массив коэффициентов
// (по одному на каждый matched элемент). Знак коэффициента = направление.
export function useParallax(selector: string, factors: number[]) {
  useEffect(() => {
    if (REDUCED) return;
    let rafId: number | null = null;
    let mx = 0, my = 0;
    let cx = 0, cy = 0;
    const ease = () => {
      rafId = null;
      cx += (mx - cx) * 0.08;
      cy += (my - cy) * 0.08;
      document.querySelectorAll<HTMLElement>(selector).forEach((el, i) => {
        const f = factors[i] != null ? factors[i] : 18;
        el.style.transform = `translate3d(${cx * f}px, ${cy * f}px, 0)`;
      });
      if (Math.abs(cx - mx) > 0.001 || Math.abs(cy - my) > 0.001) {
        rafId = requestAnimationFrame(ease);
      }
    };
    const onMove = (e: PointerEvent) => {
      mx = (e.clientX / window.innerWidth) - 0.5;
      my = (e.clientY / window.innerHeight) - 0.5;
      if (!rafId) rafId = requestAnimationFrame(ease);
    };
    window.addEventListener("pointermove", onMove);
    return () => {
      window.removeEventListener("pointermove", onMove);
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [selector, factors.join(",")]);
}
