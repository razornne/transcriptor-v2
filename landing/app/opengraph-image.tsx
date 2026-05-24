import { ImageResponse } from "next/og";

// OpenGraph + Twitter card image — 1200x630, shown when link is shared
// in Telegram / Slack / Twitter / LinkedIn / iMessage etc.
// Composition matches the landing brand: parchment background, dark logo mark,
// huge tagline, CTA accent.

export const alt = "Skriptly — Every call, word for word.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          background: "#EDE8E0",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: 72,
          fontFamily: "system-ui, sans-serif",
        }}
      >
        {/* Top: brand mark + wordmark */}
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <div
            style={{
              width: 64,
              height: 64,
              background: "#1A1814",
              color: "#EDE8E0",
              borderRadius: 14,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 40,
              fontWeight: 700,
              letterSpacing: -1,
            }}
          >
            S
          </div>
          <div style={{ color: "#1A1814", fontSize: 38, fontWeight: 600, letterSpacing: -0.5 }}>
            Skriptly
          </div>
        </div>

        {/* Middle: tagline */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 16,
            color: "#1A1814",
          }}
        >
          <div
            style={{
              fontSize: 96,
              fontWeight: 700,
              lineHeight: 1.02,
              letterSpacing: -3,
              maxWidth: 1000,
            }}
          >
            Every call, word for word.
          </div>
          <div
            style={{
              fontSize: 30,
              fontWeight: 400,
              color: "#5A554C",
              maxWidth: 900,
              lineHeight: 1.3,
            }}
          >
            Best-in-class Ukrainian & English transcription. Speakers separated automatically.
          </div>
        </div>

        {/* Bottom: CTA dot + URL */}
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div
            style={{
              width: 14,
              height: 14,
              background: "#3F65DD",
              borderRadius: 999,
            }}
          />
          <div style={{ fontSize: 22, color: "#1A1814", fontWeight: 500, letterSpacing: -0.2 }}>
            skriptly.io
          </div>
        </div>
      </div>
    ),
    { ...size }
  );
}
