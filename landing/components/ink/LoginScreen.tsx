"use client";
import { useRef, useState } from "react";
import { sb } from "@/lib/ink/supabase";
import { DotField } from "./DotField";

// Login в стиле Ink & Halftone: та же сцена с ореолом, карточка вместо инпута.
export function LoginScreen() {
  const stageRef = useRef<HTMLDivElement>(null);
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [error, setError] = useState("");

  const google = () =>
    sb.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin + "/v2" },
    });

  const magic = async () => {
    const e = email.trim();
    if (!e || state === "sending") return;
    setState("sending");
    const { error: err } = await sb.auth.signInWithOtp({
      email: e,
      options: { emailRedirectTo: window.location.origin + "/v2" },
    });
    if (err) { setError(err.message); setState("error"); }
    else setState("sent");
  };

  return (
    <div className="ink-root">
      <main className="i-hero">
        <DotField anchorRef={stageRef} />
        <div className="i-center" style={{ width: "min(420px, 92vw)" }}>
          <div ref={stageRef}>
            <h1 className="i-title">Welcome <em>back</em>.</h1>
            <p className="i-sub">Sign in to continue.</p>
            <div className="i-card" style={{ padding: 20 }}>
              <button type="button" className="i-cook" style={{ width: "100%" }} onClick={google}>
                Continue with Google
              </button>
              <div className="i-login-div"><span>or magic link</span></div>
              {state === "sent" ? (
                <p className="i-login-sent">Check your inbox — the link signs you in.</p>
              ) : (
                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    className="i-field"
                    type="email"
                    placeholder="you@work.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") void magic(); }}
                  />
                  <button type="button" className="i-pill" style={{ flex: "none" }} onClick={() => void magic()}>
                    {state === "sending" ? "Sending…" : "Send link"}
                  </button>
                </div>
              )}
              {state === "error" && <p className="i-error">{error}</p>}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
