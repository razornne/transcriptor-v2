"use client";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

// DotField v2 — живой halftone-ореол вокруг stage-блока.
//
// Органика вместо «коробки»: позиция каждой точки слегка сдвинута от сетки,
// яркость и порог видимости рандомизированы per-dot — граница ореола
// растворяется неровно (stochastic dithering), параллельных «стенок» нет.
//
// Интерактив: курсор мягко раздвигает точки (радиальное отталкивание с
// затуханием) и подсвечивает их синусоидальной рябью вокруг себя. Эффект
// складывается с системными волнами Cook (реальные события пайплайна) —
// во время обработки мышь «гонит волну» поверх прогресса.
//
// Перфоманс: один canvas, rAF крутится только пока есть волны или активен
// курсор; в покое — статичный кадр. prefers-reduced-motion отключает всё
// динамическое.

export type DotFieldHandle = { wave: (amp?: number) => void };

const SPACING = 12;
const MAX_DIST = 250;     // дальше stage-блока точек нет вовсе
const HIDE_DIST = 5;
const FALLOFF = 70;       // мягче, чем раньше (55) — ореол «дышит» шире
const WAVE_SPEED = 0.27;  // px/мс
const WAVE_SIGMA = 48;
const MOUSE_R = 150;      // радиус влияния курсора
const MOUSE_PUSH = 13;    // макс. смещение точки от курсора, px

type Dot = {
  x: number; y: number; d: number;
  base: number;   // статичная яркость (рандомизирована)
  cut: number;    // per-dot порог видимости — рваная граница ореола
  rr: number;     // вариация радиуса
};
type Wave = { start: number; amp: number };

export const DotField = forwardRef<
  DotFieldHandle,
  { anchorRef: React.RefObject<HTMLDivElement | null> }
>(function DotField({ anchorRef }, ref) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wavesRef = useRef<Wave[]>([]);
  const runningRef = useRef(false);
  const reducedRef = useRef(false);
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
    const parent = canvas?.parentElement;
    if (!canvas || !parent) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    reducedRef.current =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let dots: Dot[] = [];
    let raf = 0;
    let parentRect = parent.getBoundingClientRect();

    // курсор: target → плавный (lerp), активность затухает после ухода
    const mouse = { x: -9999, y: -9999, tx: -9999, ty: -9999, act: 0, inside: false };

    // Детерминированный per-dot шум (без Math.random — стабильно между rebuild)
    const noise = (x: number, y: number, s: number) => {
      const v = Math.sin(x * 12.9898 + y * 78.233 + s * 37.719) * 43758.5453;
      return v - Math.floor(v);
    };

    const dotColor = () => {
      const el = canvas.closest(".ink-root") || document.documentElement;
      return getComputedStyle(el as Element).getPropertyValue("--i-dot").trim() || "20,18,14";
    };

    function rebuild() {
      const card = anchorRef.current;
      if (!card) return;
      parentRect = parent!.getBoundingClientRect();
      const cr = card.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas!.width = Math.max(1, Math.round(parentRect.width * dpr));
      canvas!.height = Math.max(1, Math.round(parentRect.height * dpr));
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);

      const rl = cr.left - parentRect.left, rt = cr.top - parentRect.top;
      const rr = rl + cr.width, rb = rt + cr.height;

      dots = [];
      for (let gy = SPACING / 2; gy < parentRect.height; gy += SPACING) {
        for (let gx = SPACING / 2; gx < parentRect.width; gx += SPACING) {
          // органический сдвиг от идеальной сетки
          const x = gx + (noise(gx, gy, 1) - 0.5) * 6;
          const y = gy + (noise(gx, gy, 2) - 0.5) * 6;
          const dx = Math.max(rl - x, x - rr, 0);
          const dy = Math.max(rt - y, y - rb, 0);
          const d = Math.hypot(dx, dy);
          if (d < HIDE_DIST || d > MAX_DIST) continue;
          const base = Math.exp(-d / FALLOFF) * (0.6 + 0.8 * noise(gx, gy, 3));
          dots.push({
            x, y, d,
            base,
            cut: 0.028 + 0.05 * noise(gx, gy, 4),
            rr: 0.8 + 0.5 * noise(gx, gy, 5),
          });
        }
      }
      render(performance.now());
    }

    function render(now: number) {
      ctx!.clearRect(0, 0, parentRect.width, parentRect.height);
      const rgb = dotColor();

      wavesRef.current = wavesRef.current.filter(
        (w) => (now - w.start) * WAVE_SPEED < MAX_DIST + WAVE_SIGMA * 3,
      );

      // плавное следование за курсором + затухание активности
      mouse.x += (mouse.tx - mouse.x) * 0.18;
      mouse.y += (mouse.ty - mouse.y) * 0.18;
      mouse.act += ((mouse.inside ? 1 : 0) - mouse.act) * 0.07;

      const act = mouse.act;
      for (const p of dots) {
        let lift = 0;
        for (const w of wavesRef.current) {
          const r = (now - w.start) * WAVE_SPEED;
          const dd = p.d - r;
          lift += w.amp * Math.exp(-(dd * dd) / (2 * WAVE_SIGMA * WAVE_SIGMA));
        }

        // курсор: отталкивание + рябь
        let ox = 0, oy = 0, mLift = 0;
        if (act > 0.01) {
          const mdx = p.x - mouse.x, mdy = p.y - mouse.y;
          const md = Math.hypot(mdx, mdy);
          if (md < MOUSE_R && md > 0.5) {
            const t = 1 - md / MOUSE_R;
            const f = t * t;
            const push = MOUSE_PUSH * f * act;
            ox = (mdx / md) * push;
            oy = (mdy / md) * push;
            const ripple = 0.75 + 0.25 * Math.sin(md * 0.085 - now * 0.0065);
            mLift = f * 0.5 * act * ripple;
          }
        }

        const alpha = Math.min(0.92, p.base * 0.5 + lift * 0.45 + mLift);
        if (alpha < p.cut) continue;
        const radius = (0.95 + p.base * 1.3 + (lift + mLift) * 1.5) * p.rr;
        ctx!.fillStyle = `rgba(${rgb},${alpha.toFixed(3)})`;
        ctx!.beginPath();
        ctx!.arc(p.x + ox, p.y + oy, radius, 0, 6.2832);
        ctx!.fill();
      }
    }

    function loop() {
      render(performance.now());
      if (wavesRef.current.length > 0 || mouse.act > 0.012) {
        raf = requestAnimationFrame(loop);
      } else {
        runningRef.current = false;
        mouse.act = 0;
        render(performance.now());
      }
    }

    function kick() {
      if (runningRef.current) return;
      runningRef.current = true;
      raf = requestAnimationFrame(loop);
    }
    kickRef.current = kick;

    const onMove = (e: PointerEvent) => {
      if (reducedRef.current) return;
      mouse.tx = e.clientX - parentRect.left;
      mouse.ty = e.clientY - parentRect.top;
      if (!mouse.inside) { mouse.x = mouse.tx; mouse.y = mouse.ty; }
      mouse.inside = true;
      kick();
    };
    const onLeave = () => { mouse.inside = false; kick(); };
    parent.addEventListener("pointermove", onMove);
    parent.addEventListener("pointerleave", onLeave);

    rebuild();
    const t = window.setTimeout(rebuild, 350); // шрифты доезжают позже

    const ro = new ResizeObserver(rebuild);
    ro.observe(parent);
    if (anchorRef.current) ro.observe(anchorRef.current);

    const mo = new MutationObserver(() => render(performance.now()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(t);
      ro.disconnect();
      mo.disconnect();
      parent.removeEventListener("pointermove", onMove);
      parent.removeEventListener("pointerleave", onLeave);
      runningRef.current = false;
    };
  }, [anchorRef]);

  return <canvas ref={canvasRef} className="i-dots" aria-hidden="true" />;
});
