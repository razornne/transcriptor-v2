"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";

type Option<T> = { value: T; label: ReactNode } | T;

export function SegToggle<T extends string>({
  value, onChange, options, ariaLabel, size = "sm",
}: {
  value: T;
  onChange: (v: T) => void;
  options: Option<T>[];
  ariaLabel: string;
  size?: "sm" | "md";
}) {
  const btnRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [ind, setInd] = useState({ x: 0, w: 0, ready: false });

  const idx = options.findIndex((o) => {
    const v = typeof o === "object" && o !== null && "value" in o ? o.value : o;
    return v === value;
  });

  // Меряем размер активной кнопки. ResizeObserver ловит изменения
  // после загрузки шрифтов (Bricolage / Onest догружаются после первого
  // рендера → ширина кнопки меняется → индикатор должен поспеть).
  useEffect(() => {
    const btn = btnRefs.current[idx];
    if (!btn) return;
    const remeasure = () => {
      const b = btnRefs.current[idx];
      if (b) setInd({ x: b.offsetLeft, w: b.offsetWidth, ready: true });
    };
    remeasure();
    const ro = new ResizeObserver(remeasure);
    btnRefs.current.forEach((b) => b && ro.observe(b));
    window.addEventListener("resize", remeasure);
    if (typeof document !== "undefined" && (document as any).fonts?.ready) {
      (document as any).fonts.ready.then(remeasure).catch(() => {});
    }
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", remeasure);
    };
  }, [idx, options.length, value]);

  return (
    <div className={`seg seg-${size}`} role="group" aria-label={ariaLabel}>
      <span
        className="seg-ind"
        aria-hidden="true"
        style={{
          transform: `translateX(${ind.x}px)`,
          width: ind.w,
          opacity: ind.ready ? 1 : 0,
        }}
      />
      {options.map((o, i) => {
        const v = typeof o === "object" && o !== null && "value" in o ? o.value : o;
        const label = typeof o === "object" && o !== null && "label" in o ? o.label : (o as ReactNode);
        const active = v === value;
        return (
          <button
            key={String(v)}
            ref={(el) => { btnRefs.current[i] = el; }}
            className={"seg-btn" + (active ? " on" : "")}
            onClick={() => onChange(v as T)}
            aria-pressed={active}
            type="button"
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
