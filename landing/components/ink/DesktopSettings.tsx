"use client";
import { useCallback, useEffect, useState } from "react";
import { desktopInvoke } from "@/lib/ink/desktop";
import { Select } from "./Select";

// Настройки диктовки в приложении Skriptly (хоткеи, языки, микрофон…). Видны только
// в окне приложения: сама диктовка работает в Rust (desktop/src-tauri), страница
// лишь меняет её настройки через мост.

type AppSettings = {
  languages: string[]; cleanup: boolean; mic: string | null; autostart: boolean;
  show_bar: boolean; instant_start: boolean; pause_media: boolean;
  [k: string]: unknown;
};
type State = {
  settings: AppSettings; mics: string[]; version: string;
  hotkey: string; lock_hotkey: string; default_hotkey: string; default_lock_hotkey: string;
};
type Kind = "hold" | "lock";

const LANGS: [string, string][] = [
  ["en", "English"], ["ru", "Русский"], ["uk", "Українська"], ["pl", "Polski"], ["cs", "Čeština"],
];

// e.code → виртуальный код Windows (как в hotkey.rs; левый и правый различаются).
function vkOf(code: string): number | null {
  const named: Record<string, number> = {
    ControlLeft: 0xA2, ControlRight: 0xA3, ShiftLeft: 0xA0, ShiftRight: 0xA1, AltLeft: 0xA4, AltRight: 0xA5,
    MetaLeft: 0x5B, MetaRight: 0x5C, OSLeft: 0x5B, OSRight: 0x5C,
    Space: 0x20, Enter: 0x0D, Tab: 0x09, Backspace: 0x08, Pause: 0x13, CapsLock: 0x14, ScrollLock: 0x91,
    Insert: 0x2D, Delete: 0x2E, Home: 0x24, End: 0x23, PageUp: 0x21, PageDown: 0x22,
    ArrowLeft: 0x25, ArrowUp: 0x26, ArrowRight: 0x27, ArrowDown: 0x28, Backquote: 0xC0,
  };
  if (code in named) return named[code];
  let m = /^Key([A-Z])$/.exec(code);
  if (m) return m[1].charCodeAt(0);
  if ((m = /^Digit(\d)$/.exec(code))) return 0x30 + +m[1];
  if ((m = /^F(\d{1,2})$/.exec(code)) && +m[1] >= 1 && +m[1] <= 24) return 0x6F + +m[1];
  return null;
}

function Keys({ label }: { label: string }) {
  return (
    <span className="i-keys">
      {label.split(" + ").map((k, i) => (
        <span key={i} style={{ display: "contents" }}>
          {i > 0 && <span className="plus">+</span>}
          <kbd>{k}</kbd>
        </span>
      ))}
    </span>
  );
}

function Toggle({ checked, onChange, id }: { checked: boolean; onChange: (v: boolean) => void; id: string }) {
  return (
    <label className="i-toggle" htmlFor={id}>
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="i-toggle-track" />
      <span className="i-toggle-thumb" />
    </label>
  );
}

export function DesktopSettings() {
  const [st, setSt] = useState<State | null>(null);
  const [err, setErr] = useState("");
  const [cap, setCap] = useState<Kind | null>(null);
  const [live, setLive] = useState("");

  const load = useCallback(async () => {
    try { setSt(await desktopInvoke<State>("get_state")); }
    catch (e) { setErr(String(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const save = async (patch: Partial<AppSettings>) => {
    if (!st) return;
    const next = { ...st.settings, ...patch };
    setSt({ ...st, settings: next });
    try { await desktopInvoke("save_settings", { settings: next }); }
    catch (e) { setErr(String(e)); }
  };

  // Сочетание записывает сама страница: пока в фокусе окно приложения, Windows не
  // отдаёт клавиши глобальному хуку. Запись идёт до отпускания, Esc или 15 с.
  useEffect(() => {
    if (!cap) return;
    const c = { keys: [] as number[], down: new Set<number>() };
    const timer = window.setTimeout(() => { setCap(null); setErr("No keys pressed. Try again"); }, 15000);
    const end = () => { window.clearTimeout(timer); setCap(null); setLive(""); };
    const onDown = async (e: KeyboardEvent) => {
      e.preventDefault(); e.stopPropagation();
      if (e.code === "Escape" && c.keys.length === 0) { end(); return; }
      const vk = vkOf(e.code);
      if (vk == null || c.down.has(vk)) return;
      c.down.add(vk);
      if (!c.keys.includes(vk)) c.keys.push(vk);
      try { setLive(await desktopInvoke<string>("hotkey_label", { keys: [...c.keys] })); } catch { /* ignore */ }
    };
    const onUp = async (e: KeyboardEvent) => {
      e.preventDefault(); e.stopPropagation();
      const vk = vkOf(e.code);
      if (vk == null) return;
      c.down.delete(vk);
      if (!c.keys.includes(vk) || c.down.size > 0) return;
      const keys = [...c.keys];
      end();
      try {
        const r = await desktopInvoke<{ hotkey: string; lock_hotkey: string }>("set_hotkey", { kind: cap, keys });
        setSt((s) => (s ? { ...s, ...r } : s));
      } catch (er) { setErr(String(er)); }
    };
    // ушли из окна посреди записи (Alt+Tab) — отпускания не увидим, начинаем заново
    const onBlur = () => { c.keys = []; c.down.clear(); setLive(""); };
    window.addEventListener("keydown", onDown, true);
    window.addEventListener("keyup", onUp, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("keydown", onDown, true);
      window.removeEventListener("keyup", onUp, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [cap]);

  const reset = async (kind: Kind) => {
    setErr("");
    try {
      const r = await desktopInvoke<{ hotkey: string; lock_hotkey: string }>("reset_hotkey", { kind });
      setSt((s) => (s ? { ...s, ...r } : s));
    } catch (e) { setErr(String(e)); }
  };

  if (!st) {
    return (
      <div className="i-modal-pane">
        <p className="i-msect-title">Dictation</p>
        <p className="i-mrow-sub">{err || "Loading…"}</p>
      </div>
    );
  }
  const s = st.settings;
  const rows: { kind: Kind; title: string; desc: string; label: string; def: string }[] = [
    { kind: "hold", title: "Hold to dictate", desc: "Release to paste where your cursor is", label: st.hotkey, def: st.default_hotkey },
    { kind: "lock", title: "Hands-free", desc: "Press to start, press again to finish", label: st.lock_hotkey, def: st.default_lock_hotkey },
  ];

  return (
    <div className="i-modal-pane">
      <p className="i-msect-title">Dictation</p>
      <p className="i-mrow-sub" style={{ margin: "-12px 0 18px" }}>
        Hold a key, speak, release: the text is pasted into any app. <kbd className="i-kbd">Esc</kbd> cancels.
      </p>

      <div className="i-msect-card">
        {rows.map((r) => (
          <div className="i-mrow" key={r.kind}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="i-mrow-label">{r.title}</div>
              <div className="i-mrow-sub">
                {cap === r.kind
                  ? <>Press and release the new shortcut{live ? <>: <b>{live}</b></> : "…"}</>
                  : r.desc}
              </div>
            </div>
            {cap !== r.kind && <Keys label={r.label} />}
            <button type="button" className="i-textbtn"
              onClick={(e) => { (e.currentTarget as HTMLButtonElement).blur(); setErr(""); setLive(""); setCap(cap === r.kind ? null : r.kind); }}>
              {cap === r.kind ? "Cancel" : "Change"}
            </button>
            {cap !== r.kind && r.label !== r.def && (
              <button type="button" className="i-textbtn" onClick={() => void reset(r.kind)}>Reset</button>
            )}
          </div>
        ))}
      </div>
      {err && <p className="i-error">{err}</p>}

      <p className="i-msect-title" style={{ marginTop: 28 }}>Languages</p>
      <div className="i-msect-card">
        <div className="i-mrow" style={{ flexDirection: "column", alignItems: "flex-start", gap: 12 }}>
          <div className="i-mrow-sub" style={{ marginTop: 0 }}>
            Tick the ones you speak. None = Auto, which can mix up Russian and Ukrainian.
          </div>
          <div className="i-langs">
            {LANGS.map(([code, name]) => (
              <label key={code} className={`i-langchip${s.languages.includes(code) ? " on" : ""}`}>
                <input
                  type="checkbox"
                  checked={s.languages.includes(code)}
                  onChange={(e) => void save({
                    languages: e.target.checked ? [...s.languages, code] : s.languages.filter((l) => l !== code),
                  })}
                />
                {name}
              </label>
            ))}
          </div>
        </div>
      </div>

      <p className="i-msect-title" style={{ marginTop: 28 }}>Behaviour</p>
      <div className="i-msect-card">
        <div className="i-mrow">
          <div style={{ flex: 1 }}>
            <label className="i-mrow-label" htmlFor="d-cleanup">Polish with AI</label>
            <div className="i-mrow-sub">Removes “um”, repeats and self-corrections</div>
          </div>
          <Toggle id="d-cleanup" checked={!!s.cleanup} onChange={(v) => void save({ cleanup: v })} />
        </div>
        <div className="i-mrow">
          <div style={{ flex: 1 }}>
            <label className="i-mrow-label" htmlFor="d-pause">Pause media while dictating</label>
            <div className="i-mrow-sub">YouTube, series, music: resumes after</div>
          </div>
          <Toggle id="d-pause" checked={s.pause_media !== false} onChange={(v) => void save({ pause_media: v })} />
        </div>
        <div className="i-mrow">
          <div style={{ flex: 1 }}>
            <label className="i-mrow-label" htmlFor="d-bar">Show dictation bar</label>
            <div className="i-mrow-sub">A small pill at the bottom of the screen</div>
          </div>
          <Toggle id="d-bar" checked={s.show_bar !== false} onChange={(v) => void save({ show_bar: v })} />
        </div>
        <div className="i-mrow">
          <div style={{ flex: 1 }}>
            <label className="i-mrow-label" htmlFor="d-instant">Instant start</label>
            <div className="i-mrow-sub">Keeps the mic open so the first word is never lost. Bluetooth headsets stay in call mode</div>
          </div>
          <Toggle id="d-instant" checked={!!s.instant_start} onChange={(v) => void save({ instant_start: v })} />
        </div>
        <div className="i-mrow">
          <div style={{ flex: 1 }}>
            <label className="i-mrow-label" htmlFor="d-auto">Start with Windows</label>
            <div className="i-mrow-sub">Skriptly waits in the tray, ready to dictate</div>
          </div>
          <Toggle id="d-auto" checked={!!s.autostart} onChange={(v) => void save({ autostart: v })} />
        </div>
      </div>

      <p className="i-msect-title" style={{ marginTop: 28 }}>Microphone</p>
      <div className="i-msect-card">
        <div className="i-mrow">
          <label className="i-mrow-label" htmlFor="d-mic">Input device (dictation and call recording)</label>
          <Select
            id="d-mic"
            value={s.mic && st.mics.includes(s.mic) ? s.mic : ""}
            onChange={(v) => void save({ mic: v || null })}
            options={[{ value: "", label: "System default" }, ...st.mics.map((m) => ({ value: m, label: m }))]}
          />
        </div>
      </div>

      <p className="i-mrow-sub" style={{ marginTop: 22 }}>
        Skriptly for Windows v{st.version} ·{" "}
        <button type="button" className="i-textbtn" onClick={() => void desktopInvoke("open_log_folder")}>Open logs folder</button>
      </p>
    </div>
  );
}
