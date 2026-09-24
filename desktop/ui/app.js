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
  $("minutes").textContent = `${used} / ${limit} min this month`;
  const share = limit > 0 ? Math.min(1, used / limit) : 0;
  $("barFill").style.width = `${share * 100}%`;
  $("bar").classList.toggle("warn", share > 0.9);
}

// ── Шорткат ──────────────────────────────────────────────────────────────
function renderHotkey(label) {
  const box = $("hotkeyKeys");
  box.innerHTML = "";
  label.split(" + ").forEach((k, i) => {
    if (i) box.append(" + ");
    box.append(Object.assign(document.createElement("kbd"), { textContent: k }));
  });
  $("hotkeyReset").hidden = label === "Ctrl + Win";
}

let capturing = false;
async function captureHotkey() {
  if (capturing) { invoke("cancel_hotkey_capture"); return; }
  capturing = true;
  $("hotkeyErr").hidden = true;
  $("hotkeyHint").hidden = true;
  $("hotkeyCapture").hidden = false;
  $("hotkeyChange").textContent = "Cancel";
  try {
    const r = await invoke("capture_hotkey");
    renderHotkey(r.hotkey);
  } catch (e) {
    const msg = String(e);
    if (msg !== "cancelled") { $("hotkeyErr").textContent = msg; $("hotkeyErr").hidden = false; }
  } finally {
    capturing = false;
    $("hotkeyHint").hidden = false;
    $("hotkeyCapture").hidden = true;
    $("hotkeyChange").textContent = "Change";
  }
}
$("hotkeyChange").onclick = captureHotkey;
$("hotkeyReset").onclick = async () => renderHotkey((await invoke("reset_hotkey")).hotkey);
window.addEventListener("blur", () => { if (capturing) invoke("cancel_hotkey_capture"); });

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
  renderHotkey(st.hotkey);

  if (st.call.recording) callView("callLive");
  else if ($("callLive").hidden === false) callView("callIdle");
  renderPending(st.pending);

  $("language").value = settings.language || "";
  $("cleanup").checked = !!settings.cleanup;
  $("autostart").checked = !!settings.autostart;
  const mic = $("mic");
  mic.innerHTML = "";
  mic.append(new Option("System default", ""));
  for (const name of st.mics) mic.append(new Option(name, name));
  mic.value = settings.mic && st.mics.includes(settings.mic) ? settings.mic : "";

  if (st.signed_in) invoke("get_profile").then(renderUsage).catch(() => {});
}

async function save() {
  settings = {
    ...settings,
    language: $("language").value,
    cleanup: $("cleanup").checked,
    autostart: $("autostart").checked,
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
for (const id of ["language", "cleanup", "autostart", "mic"]) $(id).addEventListener("change", save);
$("signout").onclick = async () => { await invoke("sign_out"); await refresh(); };
$("web").onclick = () => invoke("open_web");
$("logs").onclick = () => invoke("open_log_folder");

listen("auth-changed", refresh);
listen("usage", (e) => renderUsage({ plan: $("plan").textContent, ...e.payload }));
window.addEventListener("focus", () => { if (settings && !capturing) refresh(); });

refresh().catch(showError);
