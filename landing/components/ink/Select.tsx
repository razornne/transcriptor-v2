"use client";
import { useCallback, useEffect, useId, useRef, useState } from "react";

// Выпадающий список в стиле приложения. Системный <select> рисует список сам: не
// наши шрифты и формы, а в тёмной теме — светлый текст на светлом фоне. Этот
// компонент рисует список через CSS-переменные приложения, поэтому обе темы работают.
// Клавиатура: ↑↓ Home End, Enter/Space — выбрать, Esc — закрыть, буква — перейти.

export type SelectOption = { value: string; label: string };

type Pos = { left: number; minWidth: number; maxHeight: number; top?: number; bottom?: number };

export function Select({
  value, onChange, options, id, ariaLabel, ariaLabelledBy, variant = "box", disabled = false,
}: {
  value: string;
  onChange: (v: string) => void;
  options: SelectOption[];
  id?: string;
  ariaLabel?: string;
  ariaLabelledBy?: string;
  /** inline — компактное поле без рамки (панель параметров), box — поле с рамкой (настройки) */
  variant?: "inline" | "box";
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<Pos | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = useId();

  const selected = Math.max(0, options.findIndex((o) => o.value === value));
  const current = options[selected];

  const measure = useCallback(() => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    const wanted = Math.min(options.length * 40 + 14, 320);
    const below = window.innerHeight - r.bottom - 14;
    const above = r.top - 14;
    const up = below < Math.min(wanted, 260) && above > below;
    const minWidth = Math.max(r.width, 168);
    // триггер в правой половине экрана (строки настроек) — список выравниваем по его правому краю
    const wantLeft = r.left > window.innerWidth / 2 ? r.right - minWidth : r.left;
    const left = Math.max(8, Math.min(wantLeft, window.innerWidth - minWidth - 8));
    setPos(up
      ? { left, minWidth, bottom: window.innerHeight - r.top + 6, maxHeight: Math.min(wanted, above) }
      : { left, minWidth, top: r.bottom + 6, maxHeight: Math.min(wanted, below) });
  }, [options.length]);

  const openList = () => {
    if (disabled) return;
    measure();
    setActive(selected);
    setOpen(true);
  };
  const close = useCallback(() => setOpen(false), []);
  const choose = (i: number) => {
    const o = options[i];
    if (o && o.value !== value) onChange(o.value);
    setOpen(false);
    btnRef.current?.focus();
  };

  // закрытие: клик мимо, прокрутка страницы, изменение окна
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || listRef.current?.contains(t)) return;
      close();
    };
    const onScroll = (e: Event) => { if (!listRef.current?.contains(e.target as Node)) close(); };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
    };
  }, [open, close]);

  useEffect(() => {
    if (open) listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    const last = options.length - 1;
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) { e.preventDefault(); openList(); }
      return;
    }
    switch (e.key) {
      case "ArrowDown": e.preventDefault(); setActive((a) => Math.min(last, a + 1)); break;
      case "ArrowUp": e.preventDefault(); setActive((a) => Math.max(0, a - 1)); break;
      case "Home": e.preventDefault(); setActive(0); break;
      case "End": e.preventDefault(); setActive(last); break;
      case "Enter": case " ": e.preventDefault(); choose(active); break;
      case "Escape": e.preventDefault(); e.stopPropagation(); close(); break;   // не закрывать страницу настроек
      case "Tab": close(); break;
      default:
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
          const ch = e.key.toLowerCase();
          const from = active + 1;
          const idx = [...options.slice(from), ...options.slice(0, from)]
            .findIndex((o) => o.label.toLowerCase().startsWith(ch));
          if (idx >= 0) setActive((from + idx) % options.length);
        }
    }
  };

  return (
    <div className={`i-sel ${variant}${open ? " open" : ""}`}>
      <button
        ref={btnRef}
        id={id}
        type="button"
        className="i-sel-btn"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={ariaLabelledBy ? undefined : ariaLabel}
        aria-labelledby={ariaLabelledBy}
        onClick={() => (open ? close() : openList())}
        onKeyDown={onKeyDown}
      >
        <span className="i-sel-val">{current?.label ?? ""}</span>
        <svg className="i-sel-chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && pos && (
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          className="i-sel-pop"
          aria-label={ariaLabel}
          style={{ left: pos.left, top: pos.top, bottom: pos.bottom, minWidth: pos.minWidth, maxHeight: pos.maxHeight }}
          onMouseDown={(e) => e.preventDefault()}  // фокус остаётся на кнопке
        >
          {options.map((o, i) => (
            <li
              key={o.value}
              role="option"
              aria-selected={i === selected}
              data-active={i === active}
              className="i-sel-opt"
              onPointerEnter={() => setActive(i)}
              onClick={() => choose(i)}
            >
              <span>{o.label}</span>
              {i === selected && (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"
                  strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
