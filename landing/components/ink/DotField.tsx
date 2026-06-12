"use client";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

// DotField — halftone-ореол вокруг input-карточки (НЕ полноэкранные обои —
// фидбек юзера 2026-06-12). Плотность/яркость точки затухает с расстоянием
// до карточки; дальше MAX_DIST точек нет вообще — углы экрана чистые.
//
// Во время обработки родитель вызывает handle.wave(amp): от карточки наружу
// расходится волна — гауссов гребень по метрике "расстояние до карточки",
// поднимающий точки (opacity + radius) по мере прохождения. Волны привязаны
// к РЕАЛЬНЫМ событиям пайплайна (chunk done / stage) — никакой decorative
// анимации в покое.
//
// Один <canvas>, ≤ ~1200 точек, rAF крутится только пока живы волны.
// prefers-reduced-motion → wave() это no-op (точки остаются статичными).

export type DotFieldHandle = { wave: (amp?: number) => void };

const SPACING = 14;      // шаг сетки, px
const MAX_DIST = 290;    // дальше карточки на это расстояние — точек нет
const HIDE_DIST = 5;     // точки под самой карточкой не рисуем
const WAVE_SPEED = 0.27; // px за мс (≈270 px/с)
const WAVE_SIGMA = 48;   // ширина гребня волны

type Dot = { x: number; y: number; d: number; base: number };
type Wave = { start: number; amp: number };

export const DotField = forwardRef<
  DotFieldHandle,
  { cardRef: React.RefObject<HTMLDivElement | null> }
>(function DotField({ cardRef }, ref) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wavesRef = useRef<Wave[]>([]);
  const runningRef = useRef(false);
  const reducedRef = useRef(false);
  const rebuildRef = useRef<() => void>(() => {});
  const kickRef = useRef<() => void>(() => {});

  useImperativeHandle(ref, () => ({
    wave(amp = 1) {
      if (reducedRef.current) return;
      wavesRef.current.push({ start: performance.now(), amp });
      kickRef.current();
    },
  }));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    reducedRef.current =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let dots: Dot[] = [];
    let raf = 0;

    const dotColor = () => {
      const el = canvas.closest(".ink-root") || document.documentElement;
      return getComputedStyle(el as Element).getPropertyValue("--i-dot").trim() || "20,18,14";
    };

    function rebuild() {
      const parent = canvas!.parentElement;
      const card = cardRef.current;
      if (!parent || !card) return;
      const pr = parent.getBoundingClientRect();
      const cr = card.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas!.width = Math.max(1, Math.round(pr.width * dpr));
      canvas!.height = Math.max(1, Math.round(pr.height * dpr));
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);

      // Карточка в координатах canvas
      const rl = cr.left - pr.left, rt = cr.top - pr.top;
      const rr = rl + cr.width, rb = rt + cr.height;

      dots = [];
      for (let y = SPACING / 2; y < pr.height; y += SPACING) {
        for (let x = SPACING / 2; x < pr.width; x += SPACING) {
          const dx = Math.max(rl - x, x - rr, 0);
          const dy = Math.max(rt - y, y - rb, 0);
          const d = Math.hypot(dx, dy);
          if (d < HIDE_DIST || d > MAX_DIST) continue;
          // База: ярче у кромки карточки, мягкое затухание наружу
          const base = Math.exp(-d / 115);
          dots.push({ x, y, d, base });
        }
      }
      render(performance.now());
    }

    function render(now: number) {
      const rect = canvas!.parentElement?.getBoundingClientRect();
      if (!rect) return;
      ctx!.clearRect(0, 0, rect.width, rect.height);
      const rgb = dotColor();

      wavesRef.current = wavesRef.current.filter(
        (w) => (now - w.start) * WAVE_SPEED < MAX_DIST + WAVE_SIGMA * 3,
      );

      for (const p of dots) {
        let lift = 0;
        for (const w of wavesRef.current) {
          const r = (now - w.start) * WAVE_SPEED;
          const dd = p.d - r;
          lift += w.amp * Math.exp(-(dd * dd) / (2 * WAVE_SIGMA * WAVE_SIGMA));
        }
        const alpha = Math.min(0.9, p.base * 0.34 + lift * 0.42);
        if (alpha < 0.012) continue;
        const radius = 1.05 + p.base * 1.05 + lift * 1.5;
        ctx!.fillStyle = `rgba(${rgb},${alpha.toFixed(3)})`;
        ctx!.beginPath();
        ctx!.arc(p.x, p.y, radius, 0, 6.2832);
        ctx!.fill();
      }
    }

    function loop() {
      render(performance.now());
      if (wavesRef.current.length > 0) {
        raf = requestAnimationFrame(loop);
      } else {
        runningRef.current = false;
        render(performance.now()); // финальный статичный кадр
      }
    }

    function kick() {
      if (runningRef.current) return;
      runningRef.current = true;
      raf = requestAnimationFrame(loop);
    }

    rebuildRef.current = rebuild;
    kickRef.current = kick;

    rebuild();
    // Шрифты доезжают позже и меняют высоту карточки
    const t = window.setTimeout(rebuild, 350);

    const ro = new ResizeObserver(rebuild);
    if (canvas.parentElement) ro.observe(canvas.parentElement);
    if (cardRef.current) ro.observe(cardRef.current);

    // Смена темы → перерисовать цвет точек
    const mo = new MutationObserver(() => render(performance.now()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(t);
      ro.disconnect();
      mo.disconnect();
      runningRef.current = false;
    };
  }, [cardRef]);

  return <canvas ref={canvasRef} className="i-dots" aria-hidden="true" />;
});
