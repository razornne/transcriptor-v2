"use client";
import { forwardRef, memo, useEffect, useImperativeHandle, useRef } from "react";

// ═══════════════════════════════════════════════════════════════════════
// DotField v3 — дымчатый halftone-ореол вокруг stage-карточки.
//
// ВАЖНО ДЛЯ ПЕРФОРМАНСА (Спринт 1, критический баг):
//   Раньше canvas был absolute inset:0 внутри .i-hero, а hero растёт вместе
//   с контентом → на длинном транскрипте битмап достигал ~15000px высоты,
//   rAF рисовал десятки тысяч точек/кадр → интерфейс лагал тем сильнее, чем
//   длиннее текст. ТЕПЕРЬ canvas живёт в position:fixed обёртке размером
//   строго с вьюпорт (height:100dvh). Битмап = viewport × dpr и НИКОГДА не
//   зависит от длины документа. Сетка точек строится только по вьюпорту и
//   куллится в кольцо вокруг (клампленной к вьюпорту) карточки → реальное
//   число точек ~2000-2800 при любой длине транскрипта.
//
//   Декаплинг от текстового стейта:
//   • компонент обёрнут в React.memo — пропсы (anchorRef, mode) референциально
//     стабильны, поэтому ввод текста / смена статуса в page.tsx НЕ вызывают
//     ре-рендер DotField;
//   • вся горячая память (мышь, тайминги, волны, точки) — в useRef, внутри
//     requestAnimationFrame НЕТ ни одного setState;
//   • волны запускаются императивно через ref.wave(), не через пропсы.
//
//   Reading mode (mode="reading", состояние OUTPUT): pointermove-слушатель
//   игнорируется, rAF не крутится (физика не тратит CPU вхолостую), canvas
//   плавно гаснет до opacity 0.35 через CSS transition.
//
// МАТЕМАТИКА (дымка вместо стен):
//   base(d) = smoothstep(GAP, GAP+RAMP, d) · (1 − smoothstep(PEAK_END, R_OUT, d))
//   где d — честный SDF до скруглённого прямоугольника карточки. Точки
//   растворяются в ноль за ~GAP(44)px до бордера → карточка «дышит».
//   Края дизерятся детерминированным value-noise (без Math.random в кадре):
//   джиттер порогов ±12px, яркость ×0.6..1.4, радиус ±25%, позиция ±3px.
//   Курсор (lerp-пружина) гонит радиальную синус-волну и слегка раздвигает
//   точки; эффект аддитивно складывается с системными волнами Cook.
// ═══════════════════════════════════════════════════════════════════════

export type DotFieldHandle = { wave: (amp?: number) => void };
export type DotMode = "live" | "reading";

const BASE_SPACING = 13;     // шаг сетки, px
const MAX_DOTS = 2800;       // хард-кап: больше — увеличиваем SPACING
const GAP = 44;              // растворение в ноль за столько px до бордера
const RAMP = 36;             // ширина набора яркости
const PEAK_END = 110;        // докуда держится максимум
const R_OUT = 230;           // полный распад наружу
const CARD_RADIUS = 18;      // совпадает с --i-r-lg карточки
const WAVE_SPEED = 0.27;     // px/мс (~270 px/с)
const WAVE_SIGMA = 48;       // ширина гребня системной волны
const MOUSE_R = 150;         // радиус влияния курсора
const MOUSE_PUSH = 12;       // макс. смещение точки от курсора, px
const MOUSE_IDLE_MS = 1200;  // курсор «уснул» — гасим rAF

type Dot = {
  x: number; y: number;   // позиция в координатах вьюпорта (= canvas)
  d: number;              // SDF-расстояние до бордера карточки
  base: number;          // статичная яркость (профиль + noise)
  cut: number;           // per-dot порог видимости (рваный край)
  rr: number;            // вариация радиуса
};
type Wave = { start: number; amp: number };

function smoothstep(a: number, b: number, x: number): number {
  if (a === b) return x < a ? 0 : 1;
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// Детерминированный value-noise [0,1) по координатам (стабилен между кадрами)
function hashNoise(x: number, y: number, s: number): number {
  const v = Math.sin(x * 12.9898 + y * 78.233 + s * 37.719) * 43758.5453;
  return v - Math.floor(v);
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

  // Императивный API — волны не идут через пропсы (иначе ломали бы memo)
  useImperativeHandle(ref, () => ({
    wave(amp = 1) {
      if (reducedRef.current || modeRef.current !== "live") return;
      wavesRef.current.push({ start: performance.now(), amp });
      kickRef.current();
    },
  }), []);

  // Реакция на смену режима без пересоздания слушателей
  useEffect(() => {
    modeRef.current = mode;
    const cv = canvasRef.current;
    if (cv) cv.style.opacity = mode === "reading" ? "0.35" : "1";
    rebuildRef.current();           // перепозиционировать ореол под новый stage
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

    // Курсор: target (tx,ty) → сглаженный (x,y) пружиной; act — затухающая
    // «активность» (0..1), lastMove — для авто-усыпления.
    const mouse = { x: -9999, y: -9999, tx: -9999, ty: -9999, act: 0, lastMove: -9999 };

    const dotColor = (): string => {
      const el = canvas.closest(".ink-root") || document.documentElement;
      return getComputedStyle(el as Element).getPropertyValue("--i-dot").trim() || "20,18,14";
    };

    function buildAt(spacing: number, cx: number, cy: number, halfW: number, halfH: number): Dot[] {
      const out: Dot[] = [];
      for (let gy = spacing / 2; gy < vh; gy += spacing) {
        for (let gx = spacing / 2; gx < vw; gx += spacing) {
          // органический сдвиг от идеальной сетки (±3px)
          const x = gx + (hashNoise(gx, gy, 1) - 0.5) * 6;
          const y = gy + (hashNoise(gx, gy, 2) - 0.5) * 6;
          const d = sdfRoundRect(x, y, cx, cy, halfW, halfH, CARD_RADIUS);
          if (d <= 0) continue;                 // под карточкой точек нет
          // per-dot джиттер порогов ±12px — рваный аналоговый край
          const j = (hashNoise(gx, gy, 4) - 0.5) * 24;
          const rise = smoothstep(GAP + j, GAP + RAMP + j, d);
          const fall = 1 - smoothstep(PEAK_END + j, R_OUT + j, d);
          const profile = rise * fall;
          if (profile < 0.015) continue;        // вне кольца
          const bright = 0.6 + 0.8 * hashNoise(gx, gy, 3);
          out.push({
            x, y, d,
            base: profile * bright,
            cut: 0.03 + 0.05 * hashNoise(gx, gy, 5),
            rr: 0.8 + 0.5 * hashNoise(gx, gy, 6),
          });
        }
      }
      return out;
    }

    function rebuild() {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const wr = wrap!.getBoundingClientRect();   // = вьюпорт (fixed inset:0)
      vw = wr.width; vh = wr.height;
      const dpr = window.devicePixelRatio || 1;
      canvas!.width = Math.max(1, Math.round(vw * dpr));
      canvas!.height = Math.max(1, Math.round(vh * dpr));
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);

      // rect карточки в координатах вьюпорта, КЛАМП к видимой зоне — на
      // длинном результате ореол не уходит за экран и не плодит точки.
      const cr = anchor.getBoundingClientRect();
      const rl = Math.max(cr.left, -R_OUT);
      const rt = Math.max(cr.top, -R_OUT);
      const rr = Math.min(cr.right, vw + R_OUT);
      const rb = Math.min(cr.bottom, vh + R_OUT);
      const cx = (rl + rr) / 2, cy = (rt + rb) / 2;
      const halfW = Math.max(0, (rr - rl) / 2), halfH = Math.max(0, (rb - rt) / 2);

      // Адаптивный SPACING под хард-кап (защита для огромных мониторов)
      let spacing = BASE_SPACING;
      for (let i = 0; i < 4; i++) {
        dots = buildAt(spacing, cx, cy, halfW, halfH);
        if (dots.length <= MAX_DOTS) break;
        spacing *= 1.25;
      }
      render(performance.now());
    }

    function render(now: number) {
      ctx!.clearRect(0, 0, vw, vh);
      const rgb = dotColor();
      const live = modeRef.current === "live" && !reducedRef.current;

      // системные волны Cook
      wavesRef.current = wavesRef.current.filter(
        (w) => (now - w.start) * WAVE_SPEED < R_OUT + WAVE_SIGMA * 3,
      );

      // курсор: пружина + затухание активности
      if (live) {
        mouse.x += (mouse.tx - mouse.x) * 0.15;
        mouse.y += (mouse.ty - mouse.y) * 0.15;
      }
      const lively = live && (now - mouse.lastMove) < MOUSE_IDLE_MS;
      mouse.act += ((lively ? 1 : 0) - mouse.act) * 0.07;
      const act = mouse.act;

      for (const p of dots) {
        let lift = 0;
        for (const w of wavesRef.current) {
          const r = (now - w.start) * WAVE_SPEED;
          const dd = p.d - r;
          lift += w.amp * Math.exp(-(dd * dd) / (2 * WAVE_SIGMA * WAVE_SIGMA));
        }

        let ox = 0, oy = 0, mLift = 0;
        if (act > 0.01) {
          const mdx = p.x - mouse.x, mdy = p.y - mouse.y;
          const md = Math.hypot(mdx, mdy);
          if (md < MOUSE_R && md > 0.5) {
            const t = 1 - md / MOUSE_R;
            const env = t * t;                 // радиальное затухание
            const ripple = 0.55 + 0.45 * Math.sin(md * 0.09 - now * 0.0065);
            mLift = env * ripple * 0.5 * act;
            const push = MOUSE_PUSH * env * act;
            ox = (mdx / md) * push;
            oy = (mdy / md) * push;
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
      const now = performance.now();
      render(now);
      const active = wavesRef.current.length > 0 || mouse.act > 0.012;
      if (active && modeRef.current === "live") {
        raf = requestAnimationFrame(loop);
      } else {
        runningRef.current = false;
        mouse.act = 0;
        render(performance.now());            // финальный статичный кадр
      }
    }

    function kick() {
      if (runningRef.current || modeRef.current !== "live") return;
      runningRef.current = true;
      raf = requestAnimationFrame(loop);
    }

    kickRef.current = kick;
    rebuildRef.current = rebuild;

    const onMove = (e: PointerEvent) => {
      if (reducedRef.current || modeRef.current !== "live") return;
      mouse.tx = e.clientX; mouse.ty = e.clientY;
      if (mouse.act < 0.01) { mouse.x = mouse.tx; mouse.y = mouse.ty; }
      mouse.lastMove = performance.now();
      kick();
    };
    // window — курсор работает в координатах вьюпорта (canvas fixed inset:0)
    window.addEventListener("pointermove", onMove, { passive: true });

    rebuild();
    const t = window.setTimeout(rebuild, 350);  // шрифты доезжают позже

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
