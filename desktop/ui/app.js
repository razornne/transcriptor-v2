// Любая ошибка UI видна прямо в окне, а не молча оставляет пустое окно.
function showError(msg) {
  const el = document.getElementById("fatal") || Object.assign(document.createElement("pre"), { id: "fatal" });
  el.style.cssText = "white-space:pre-wrap;color:#B23A22;font:12px Consolas,monospace;margin:0";
  el.textContent = String(msg);
  document.querySelector(".app").append(el);
}
window.addEventListener("error", (e) => showError(e.message));
window.addEventListener("unhandledrejection", (e) => showError(e.reason));

// Окно настроек. Вся логика — в Rust (src-tauri/src/lib.rs), здесь только UI.
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const $ = (id) => document.getElementById(id);

let settings = null;
const langBoxes = () => [...document.querySelectorAll("#langs input")];

function setAuthStatus(text, err = false) {
  const s = $("authStatus");
  s.textContent = text;
  s.classList.toggle("err", err);
}

function renderUsage(p) {
  if (!p || p.minutes_limit == null) return;
  $("usageCard").hidden = false;
  $("plan").textContent = p.plan || "";
  const used = Math.round(p.minutes_used || 0);
  const limit = Math.round(p.minutes_limit || 0);
  $("minutes").textContent = `${used} / ${limit} min of calls this month`;
  const share = limit > 0 ? Math.min(1, used / limit) : 0;
  $("barFill").style.width = `${share * 100}%`;
  $("bar").classList.toggle("warn", share > 0.9);
  // Диктовка — своя квота (часы речи в месяц); у Pro/Team «без лимита»
  if (p.dictation_limit_s != null) {
    const h = (s) => Math.round((s || 0) / 360) / 10;
    $("dictRow").hidden = false;
    $("dictation").textContent = p.dictation_unlimited
      ? `${h(p.dictation_used_s)} h · unlimited`
      : `${h(p.dictation_used_s)} / ${h(p.dictation_limit_s)} h this month`;
  }
}

// ── Шорткаты: «удерживать» и «закрепить» ──────────────────────────────────
const DEFAULTS = { hold: "Ctrl + Win", lock: "Ctrl + Win + Space" };

function renderKeys(kind, label) {
  const box = $(`keys-${kind}`);
  box.innerHTML = "";
  label.split(" + ").forEach((k, i) => {
    if (i) box.append(" + ");
    box.append(Object.assign(document.createElement("kbd"), { textContent: k }));
  });
  $(`reset-${kind}`).hidden = label === DEFAULTS[kind];
}
function renderHotkeys(r) {
  renderKeys("hold", r.hotkey);
  renderKeys("lock", r.lock_hotkey);
}

// Сочетание записывает само окно: пока оно в фокусе, Windows не зовёт глобальный
// хук клавиатуры (из-за этого запись в 0.1–0.5 ни разу не сработала).
// e.code → виртуальный код Windows (как в hotkey.rs; левый/правый различаются).
function vkOf(code) {
  const named = {
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

// Запись идёт до отпускания сочетания, Esc, «Cancel» или 15 с.
let capturing = null; // { kind, keys: [vk], down: Set<vk>, timer }
function endCapture() {
  if (!capturing) return;
  clearTimeout(capturing.timer);
  $(`change-${capturing.kind}`).textContent = "Change";
  capturing = null;
  $("hotkeyHint").hidden = false;
  $("hotkeyCapture").hidden = true;
}
function captureError(msg) {
  $("hotkeyErr").textContent = msg;
  $("hotkeyErr").hidden = false;
}
function captureHotkey(kind) {
  if (capturing) { endCapture(); return; }
  capturing = { kind, keys: [], down: new Set(), timer: setTimeout(() => { endCapture(); captureError("No keys pressed — try again"); }, 15000) };
  $("hotkeyErr").hidden = true;
  $("hotkeyHint").hidden = true;
  $("hotkeyCapture").hidden = false;
  $("hotkeyLive").textContent = "";
  $(`change-${kind}`).textContent = "Cancel";
  $(`change-${kind}`).blur(); // иначе Space/Enter «нажмут» кнопку
}
window.addEventListener("keydown", async (e) => {
  if (!capturing) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.code === "Escape" && capturing.keys.length === 0) { endCapture(); return; }
  const vk = vkOf(e.code);
  if (vk == null || capturing.down.has(vk)) return;
  capturing.down.add(vk);
  if (!capturing.keys.includes(vk)) capturing.keys.push(vk);
  const c = capturing;
  const label = await invoke("hotkey_label", { keys: c.keys });
  if (capturing === c) $("hotkeyLive").textContent = label;
}, true);
window.addEventListener("keyup", async (e) => {
  if (!capturing) return;
  e.preventDefault();
  e.stopPropagation();
  const vk = vkOf(e.code);
  capturing.down.delete(vk);
  if (!capturing.keys.includes(vk) || capturing.down.size > 0) return;
  const { kind, keys } = capturing;
  endCapture();
  try { renderHotkeys(await invoke("set_hotkey", { kind, keys })); }
  catch (err) { captureError(String(err)); }
}, true);
// Ушли из окна посреди записи (Alt+Tab) — отпускания не увидим, начинаем заново.
window.addEventListener("blur", () => { if (capturing) { capturing.keys = []; capturing.down.clear(); $("hotkeyLive").textContent = ""; } });
for (const kind of ["hold", "lock"]) {
  $(`change-${kind}`).onclick = () => captureHotkey(kind);
  $(`reset-${kind}`).onclick = async () => {
    try { renderHotkeys(await invoke("reset_hotkey", { kind })); }
    catch (e) { $("hotkeyErr").textContent = String(e); $("hotkeyErr").hidden = false; }
  };
}

// ── Запись созвона ───────────────────────────────────────────────────────
let lastTranscriptId = null;
const CALL_VIEWS = ["callIdle", "callLive", "callBusy", "callDone", "callError"];
function callView(name) { for (const v of CALL_VIEWS) $(v).hidden = v !== name; }

const fmt = (s) => {
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? `${h}:${String(m).padStart(2, "0")}` : `${m}`) + `:${String(sec).padStart(2, "0")}`;
};
const lvl = (v) => `${Math.min(100, Math.sqrt(v || 0) * 240)}%`;

function renderPending(list) {
  const box = $("pending");
  box.innerHTML = "";
  for (const p of list || []) {
    const row = document.createElement("div");
    row.className = "pending-row";
    row.append(Object.assign(document.createElement("span"), { textContent: `Unsent recording · ${fmt(p.seconds)}` }));
    const go = Object.assign(document.createElement("button"), { className: "btn", textContent: "Transcribe" });
    go.onclick = () => { row.remove(); invoke("call_retry", { id: p.id }).catch((e) => callFailed(String(e))); };
    const del = Object.assign(document.createElement("button"), { className: "link", textContent: "Discard" });
    del.onclick = () => {
      if (!confirm("Delete this recording for good?")) return;
      row.remove(); invoke("call_discard", { id: p.id });
    };
    row.append(go, del);
    box.append(row);
  }
}

function callFailed(msg) {
  $("callErrorText").textContent = msg;
  callView("callError");
}

$("callStart").onclick = async () => {
  $("callStart").disabled = true;
  try { await invoke("call_start"); } catch (e) { callFailed(String(e)); } finally { $("callStart").disabled = false; }
};
$("callStop").onclick = async () => {
  $("callStop").disabled = true;
  try { await invoke("call_stop"); } catch (e) { callFailed(String(e)); } finally { $("callStop").disabled = false; }
};
$("callOpen").onclick = () => lastTranscriptId && invoke("open_transcript", { id: lastTranscriptId });
$("callAgain").onclick = () => callView("callIdle");
$("callErrorOk").onclick = async () => { callView("callIdle"); await refresh(); };

const BUSY_TEXT = {
  compressing: "Compressing audio…",
  uploading: "Uploading…",
  transcribing: "Transcribing…",
  saving: "Saving to your history…",
};
listen("call", ({ payload: p }) => {
  if (p.state === "recording") {
    callView("callLive");
    $("callTimer").textContent = "0:00";
    $("callWarn").hidden = p.system_audio !== false;
  } else if (BUSY_TEXT[p.state]) {
    callView("callBusy");
    $("callBusyText").textContent = p.label || BUSY_TEXT[p.state];
  } else if (p.state === "done") {
    lastTranscriptId = p.transcript_id;
    callView("callDone");
    invoke("get_profile").then(renderUsage).catch(() => {});
  } else if (p.state === "error") {
    callFailed(p.message || "Something went wrong");
    refresh();
  }
});
listen("call-level", ({ payload: p }) => {
  if ($("callLive").hidden) callView("callLive");
  $("callTimer").textContent = fmt(p.seconds);
  $("lvlMic").style.width = lvl(p.mic);
  $("lvlSys").style.width = lvl(p.sys);
});

// ── Общее состояние ──────────────────────────────────────────────────────
async function refresh() {
  const st = await invoke("get_state");
  settings = st.settings;
  $("version").textContent = `v${st.version}`;
  $("signedOut").hidden = st.signed_in;
  $("signedIn").hidden = !st.signed_in;
  $("footer").hidden = !st.signed_in;
  $("who").textContent = st.email;
  renderHotkeys(st);

  if (st.call.recording) callView("callLive");
  else if ($("callLive").hidden === false) callView("callIdle");
  renderPending(st.pending);

  for (const box of langBoxes()) box.checked = (settings.languages || []).includes(box.value);
  $("cleanup").checked = !!settings.cleanup;
  $("autostart").checked = !!settings.autostart;
  $("showBar").checked = settings.show_bar !== false;
  $("instant").checked = !!settings.instant_start;
  $("pauseMedia").checked = settings.pause_media !== false;
  const mic = $("mic");
  mic.innerHTML = "";
  mic.append(new Option("System default", ""));
  for (const name of st.mics) mic.append(new Option(name, name));
  mic.value = settings.mic && st.mics.includes(settings.mic) ? settings.mic : "";

  if (st.signed_in) {
    invoke("get_profile").then(renderUsage).catch(() => {});
  }
}

async function save() {
  settings = {
    ...settings,
    languages: langBoxes().filter((b) => b.checked).map((b) => b.value),
    cleanup: $("cleanup").checked,
    autostart: $("autostart").checked,
    show_bar: $("showBar").checked,
    instant_start: $("instant").checked,
    pause_media: $("pauseMedia").checked,
    mic: $("mic").value || null,
  };
  await invoke("save_settings", { settings });
}

async function signIn(cmd, args, waitingText) {
  $("google").disabled = $("magic").disabled = true;
  setAuthStatus(waitingText);
  try {
    await invoke(cmd, args);
    setAuthStatus("");
    await refresh();
  } catch (e) {
    const msg = String(e);
    setAuthStatus(msg === "cancelled" ? "" : msg, msg !== "cancelled");
  } finally {
    $("google").disabled = $("magic").disabled = false;
  }
}

$("google").onclick = () => signIn("sign_in_google", {}, "Finish signing in in your browser…");
$("magic").onclick = () => {
  const email = $("email").value.trim();
  if (!email) { $("email").focus(); return; }
  signIn("sign_in_email", { email }, `Check ${email} and open the sign-in link on this computer…`);
};
$("email").addEventListener("keydown", (e) => { if (e.key === "Enter") $("magic").click(); });
for (const id of ["cleanup", "autostart", "mic", "showBar", "instant", "pauseMedia"]) $(id).addEventListener("change", save);
for (const box of langBoxes()) box.addEventListener("change", save);
$("signout").onclick = async () => { await invoke("sign_out"); await refresh(); };
$("web").onclick = () => invoke("open_web");
$("logs").onclick = () => invoke("open_log_folder");

listen("auth-changed", refresh);
listen("usage", (e) => renderUsage({ plan: $("plan").textContent, ...e.payload }));
window.addEventListener("focus", () => { if (settings && !capturing) refresh(); });

refresh().catch(showError);
