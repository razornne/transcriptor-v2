"use client";
import { forwardRef, memo, useEffect, useImperativeHandle, useRef } from "react";

// ═══════════════════════════════════════════════════════════════════════
// DotField v4 — амбиентное облако точек (генеративный жидкий туман).
//
// КОНЦЕПЦИЯ (хотфикс дизайна): точки больше НЕ образуют прямоугольный ореол
// вокруг карточки. Они покрывают весь фон как мягкое асимметричное облако,
// лениво дрейфующее во времени (интерференция нескольких синусоид). Точки
// стоят строго на идеальной сетке — в покое НЕ дрожат; меняются только их
// РАДИУС (0..~1.5px) и OPACITY по фазе облака, поэтому они «проявляются» и
// «растворяются» в пространстве.
//
// SAFETY MASK: вокруг контентной зоны (заголовок + карточка = anchor) точки
// принудительно гасятся в АБСОЛЮТНЫЙ 0 — комбинация мягкой радиально-
// эллиптической маски (органичный внешний край) и жёсткой rounded-rect
// очистки по самому anchor (гарантия чистоты карточки и текста). Заголовок
// "Say it messy." и поле ввода всегда идеально читаемы.
//
// ПЕРФ (декаплинг сохранён со Спринта 1): canvas в position:fixed обёртке
// размером строго с ВЬЮПОРТ; React.memo + вся горячая память в useRef +
// НОЛЬ setState в rAF → ввод текста / смена статуса в page.tsx не доходят
// до canvas. Шаг сетки адаптивен: число точек ≤ MAX_DOTS при любом экране.
// В reading mode (OUTPUT) rAF паркуется, canvas гаснет до 0.35 — дрейф не
// крутится вхолостую над длинным текстом. prefers-reduced-motion → статика.
//
// ИНТЕРАКТИВ: курсор (lerp-пружина) пускает сквозь облако мягкую затухающую
// рябь подсветки и лёгкого искажения; складывается с волнами Cook (ref.wave).
// ═══════════════════════════════════════════════════════════════════════

export type DotFieldHandle = { wave: (amp?: number) => void };
export type DotMode = "live" | "reading";

const MAX_DOTS = 2800;
const MIN_SPACING = 15;
const CARD_RADIUS = 18;
const CLOUD_LO = 0.5;        // нижний порог проявления облака
const CLOUD_HI = 0.9;        // верхний (полная плотность)
const MAX_ALPHA = 0.42;      // макс. базовая прозрачность точки облака
const MAX_RADIUS = 1.5;      // макс. радиус точки облака, px
const WAVE_SPEED = 0.3;      // px/мс — скорость системной волны Cook
const WAVE_SIGMA = 52;
const MOUSE_R = 150;
const MOUSE_DISP = 4;        // макс. искажение позиции у курсора, px

type Dot = {
  x: number; y: number;   // строго на сетке (координаты вьюпорта = canvas)
  mask: number;           // 0 под контентом → 1 в открытом поле (статично)
  dc: number;             // радиальное расстояние от центра карточки (для волн)
};
type Wave = { start: number; amp: number };

function smoothstep(a: number, b: number, x: number): number {
  if (a === b) return x < a ? 0 : 1;
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// SDF до скруглённого прямоугольника: <0 внутри, >0 снаружи (px до бордера)
function sdfRoundRect(
  px: number, py: number,
  cx: number, cy: number, halfW: number, halfH: number, r: number,
): number {
  const qx = Math.abs(px - cx) - halfW + r;
  const qy = Math.abs(py - cy) - halfH + r;
  const ax = Math.max(qx, 0), ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

// Дрейфующее облако: интерференция синусоид (две октавы) → [0,1]
function cloud(x: number, y: number, t: number): number {
  const a1 = Math.sin(x * 0.0045 + t * 0.00020);
  const a2 = Math.cos(y * 0.0052 - t * 0.00016);
  const a3 = Math.sin((x * 0.6 + y * 0.8) * 0.0050 + t * 0.00024);
  const a4 = Math.cos((x * 0.8 - y * 0.5) * 0.0042 - t * 0.00013);
  const base = (a1 + a2 + a3 + a4) * 0.25;                    // [-1,1]
  // вторая октава для биллоунга (рвёт регулярность интерференции)
  const b1 = Math.sin((x + 1000) * 0.0083 + t * 0.00028);
  const b2 = Math.cos((y + 500) * 0.0091 - t * 0.00022);
  const detail = (b1 + b2) * 0.5;                            // [-1,1]
  const v = base * 0.66 + detail * 0.34;                      // [-1,1]
  return v * 0.5 + 0.5;                                       // [0,1]
}

const DotFieldInner = forwardRef<
  DotFieldHandle,
  { anchorRef: React.RefObject<HTMLDivElement | null>; mode?: DotMode }
>(function DotFieldInner({ anchorRef, mode = "live" }, ref) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wavesRef = useRef<Wave[]>([]);
  const runningRef = useRef(false);
  const reducedRef = useRef(false);
  const modeRef = useRef<DotMode>(mode);
  const kickRef = useRef<() => void>(() => {});
  const rebuildRef = useRef<() => void>(() => {});

  useImperativeHandle(ref, () => ({
    wave(amp = 1) {
      if (reducedRef.current || modeRef.current !== "live") return;
      wavesRef.current.push({ start: performance.now(), amp });
      kickRef.current();
    },
  }), []);

  // Смена режима без пересоздания слушателей
  useEffect(() => {
    modeRef.current = mode;
    const cv = canvasRef.current;
    if (cv) cv.style.opacity = mode === "reading" ? "0.35" : "1";
    rebuildRef.current();
    if (mode === "live") kickRef.current();
  }, [mode]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = canvas?.parentElement;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    reducedRef.current =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let dots: Dot[] = [];
    let raf = 0;
    let vw = 0, vh = 0;
    let centerX = 0, centerY = 0;

    const mouse = { x: -9999, y: -9999, tx: -9999, ty: -9999, act: 0 };

    const dotColor = (): string => {
      const el = canvas.closest(".ink-root") || document.documentElement;
      return getComputedStyle(el as Element).getPropertyValue("--i-dot").trim() || "20,18,14";
    };

    function rebuild() {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const wr = wrap!.getBoundingClientRect();   // = вьюпорт (fixed inset:0)
      vw = wr.width; vh = wr.height;
      const dpr = window.devicePixelRatio || 1;
      canvas!.width = Math.max(1, Math.round(vw * dpr));
      canvas!.height = Math.max(1, Math.round(vh * dpr));
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);

      // anchor (заголовок + карточка) в координатах вьюпорта
      const cr = anchor.getBoundingClientRect();
      const cx = (cr.left + cr.right) / 2;
      const cy = (cr.top + cr.bottom) / 2;
      const halfW = cr.width / 2, halfH = cr.height / 2;
      centerX = cx; centerY = cy;
      // эллипс safety-маски — органичный внешний край вокруг контента
      const rx = halfW * 1.18 + 34;
      const ry = halfH * 1.22 + 30;

      // адаптивный шаг: число точек по всему вьюпорту ≤ MAX_DOTS
      const spacing = Math.max(MIN_SPACING, Math.sqrt((vw * vh) / MAX_DOTS));

      dots = [];
      for (let y = spacing / 2; y < vh; y += spacing) {
        for (let x = spacing / 2; x < vw; x += spacing) {
          // эллиптическая маска: 0 внутри (er<0.80), плавно до 1 (er>1.15)
          const ex = (x - cx) / rx, ey = (y - cy) / ry;
          const er = Math.hypot(ex, ey);
          const ellipse = smoothstep(0.80, 1.15, er);
          // жёсткая rounded-rect очистка строго по anchor — гарантия, что
          // карточка и буквы заголовка чисты (0 внутри, 1 за 22px снаружи)
          const dRect = sdfRoundRect(x, y, cx, cy, halfW, halfH, CARD_RADIUS);
          const rectMask = smoothstep(0, 22, dRect);
          const mask = Math.min(ellipse, rectMask);
          if (mask < 0.01) continue;            // под контентом — точки нет
          dots.push({ x, y, mask, dc: Math.hypot(x - cx, y - cy) });
        }
      }
      render(performance.now());
    }

    function render(now: number) {
      ctx!.clearRect(0, 0, vw, vh);
      const rgb = dotColor();
      const t = reducedRef.current ? 0 : now;
      const live = modeRef.current === "live" && !reducedRef.current;

      wavesRef.current = wavesRef.current.filter(
        (w) => (now - w.start) * WAVE_SPEED < Math.max(vw, vh) + WAVE_SIGMA * 3,
      );

      if (live) {
        mouse.x += (mouse.tx - mouse.x) * 0.15;
        mouse.y += (mouse.ty - mouse.y) * 0.15;
        // активность мыши плавно затухает (рябь гаснет после остановки)
        const near = Math.hypot(mouse.tx - centerX, mouse.ty - centerY) < Math.max(vw, vh);
        mouse.act += ((near ? 1 : 0) - mouse.act) * 0.05;
      }
      const act = mouse.act;
      const hasWaves = wavesRef.current.length > 0;

      for (const p of dots) {
        // базовое облако
        const n = cloud(p.x, p.y, t);
        let density = smoothstep(CLOUD_LO, CLOUD_HI, n);
        if (density < 0.01 && !hasWaves && act < 0.01) continue;

        let alpha = density * MAX_ALPHA;
        let radius = density * MAX_RADIUS;
        let ox = 0, oy = 0;

        // системные волны Cook — ряби наружу от карточки сквозь облако
        if (hasWaves) {
          let lift = 0;
          for (const w of wavesRef.current) {
            const r = (now - w.start) * WAVE_SPEED;
            const dd = p.dc - r;
            lift += w.amp * Math.exp(-(dd * dd) / (2 * WAVE_SIGMA * WAVE_SIGMA));
          }
          alpha += lift * 0.5;
          radius += lift * 1.3;
        }

        // курсор: подсветка + лёгкое искажение позиции (рябь сквозь туман)
        if (act > 0.01) {
          const mdx = p.x - mouse.x, mdy = p.y - mouse.y;
          const md = Math.hypot(mdx, mdy);
          if (md < MOUSE_R && md > 0.5) {
            const env = (1 - md / MOUSE_R) ** 2;
            const wob = Math.sin(md * 0.09 - now * 0.006);
            alpha += env * act * (0.4 + 0.3 * wob);
            radius += env * act * 0.8;
            const disp = env * act * MOUSE_DISP * wob;
            ox = (mdx / md) * disp;
            oy = (mdy / md) * disp;
          }
        }

        alpha *= p.mask;
        radius *= p.mask;
        if (alpha < 0.012 || radius < 0.2) continue;

        ctx!.fillStyle = `rgba(${rgb},${Math.min(0.9, alpha).toFixed(3)})`;
        ctx!.beginPath();
        ctx!.arc(p.x + ox, p.y + oy, Math.min(2.4, radius), 0, 6.2832);
        ctx!.fill();
      }
    }

    function loop() {
      render(performance.now());
      // в live облако дрейфует ВСЕГДА; останавливаемся только в reading/reduced
      if (modeRef.current === "live" && !reducedRef.current) {
        raf = requestAnimationFrame(loop);
      } else {
        runningRef.current = false;
        render(performance.now());
      }
    }

    function kick() {
      if (runningRef.current || modeRef.current !== "live" || reducedRef.current) return;
      runningRef.current = true;
      raf = requestAnimationFrame(loop);
    }

    kickRef.current = kick;
    rebuildRef.current = rebuild;

    const onMove = (e: PointerEvent) => {
      if (reducedRef.current || modeRef.current !== "live") return;
      mouse.tx = e.clientX; mouse.ty = e.clientY;
      if (mouse.act < 0.01) { mouse.x = mouse.tx; mouse.y = mouse.ty; }
      kick();
    };
    window.addEventListener("pointermove", onMove, { passive: true });

    rebuild();
    if (modeRef.current === "live") kick();       // запустить дрейф облака
    const t = window.setTimeout(rebuild, 350);   // шрифты доезжают позже

    const ro = new ResizeObserver(rebuild);
    ro.observe(wrap);
    if (anchorRef.current) ro.observe(anchorRef.current);

    const mo = new MutationObserver(() => render(performance.now()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(t);
      window.removeEventListener("pointermove", onMove);
      ro.disconnect();
      mo.disconnect();
      runningRef.current = false;
    };
  }, [anchorRef]);

  return (
    <div className="i-dotwrap" aria-hidden="true">
      <canvas ref={canvasRef} className="i-dots" />
    </div>
  );
});

// React.memo: пропсы (anchorRef-объект, mode-строка) референциально стабильны,
// поэтому ре-рендеры page.tsx от текстового/статусного стейта НЕ доходят сюда.
export const DotField = memo(DotFieldInner);
