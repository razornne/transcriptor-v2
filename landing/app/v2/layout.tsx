import "./ink.css";

// /v2 — Ink & Halftone (направление 2026-06-12). Instrument Serif —
// editorial-акцент в display-заголовках; остальные шрифты (Bricolage,
// Manrope, JetBrains Mono) уже грузятся в root layout.
export default function V2Layout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&display=swap"
      />
      {children}
    </>
  );
}
