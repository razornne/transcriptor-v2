"use client";
import { useState } from "react";
import { sb } from "@/lib/ink/supabase";

// Login — тот же «тихий» язык, что и приложение: бумага, чернила, одна карточка.
export function LoginScreen() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [error, setError] = useState("");

  const google = () =>
    sb.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin + "/app" },
    });

  const magic = async () => {
    const e = email.trim();
    if (!e || state === "sending") return;
    setState("sending");
    const { error: err } = await sb.auth.signInWithOtp({
      email: e,
      options: { emailRedirectTo: window.location.origin + "/app" },
    });
    if (err) { setError(err.message); setState("error"); }
    else setState("sent");
  };

  return (
    <div className="ink-root i-login">
      <header className="i-login-head">
        <div className="i-brand">
          <span className="i-brand-mark" aria-hidden="true">S</span>
          <span className="i-brand-name">Skriptly</span>
        </div>
      </header>
      <main className="i-login-main">
        <div className="i-login-col">
          <h1 className="i-title">Welcome <em>back</em>.</h1>
          <p className="i-sub">Sign in to continue.</p>
          <div className="i-login-card">
            <button type="button" className="i-login-google" onClick={google}>
              Continue with Google
            </button>
            <div className="i-login-div"><span>or magic link</span></div>
            {state === "sent" ? (
              <p className="i-login-sent">Check your inbox — the link signs you in.</p>
            ) : (
              <div className="i-login-row">
                <input
                  className="i-field"
                  type="email"
                  aria-label="Email"
                  placeholder="you@work.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void magic(); }}
                />
                <button type="button" className="i-login-send" onClick={() => void magic()}>
                  {state === "sending" ? "Sending…" : "Send link"}
                </button>
              </div>
            )}
            {state === "error" && <p className="i-error" style={{ margin: 0 }}>{error}</p>}
          </div>
        </div>
      </main>
    </div>
  );
}
