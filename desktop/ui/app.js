// Любая ошибка UI видна прямо в окне (и в логе), а не молча оставляет пустое окно.
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

async function refresh() {
  const st = await invoke("get_state");
  settings = st.settings;
  $("version").textContent = `v${st.version}`;
  $("signedOut").hidden = st.signed_in;
  $("signedIn").hidden = !st.signed_in;
  $("footer").hidden = !st.signed_in;
  $("who").textContent = st.email;

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
    await refresh().catch(showError);
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
window.addEventListener("focus", () => { if (settings) refresh(); });

refresh().catch(showError);
