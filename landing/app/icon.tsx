import { ImageResponse } from "next/og";

// Favicon — 32x32, matches the brand mark (.logo-mark): "S" on dark warm ink.
// Next.js automatically generates /icon and the corresponding <link rel="icon"> tag.

export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          background: "#1a1a1a",
          color: "#ffffff",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 22,
          fontWeight: 700,
          fontFamily: "system-ui, sans-serif",
          borderRadius: 7,
          letterSpacing: -0.5,
        }}
      >
        S
      </div>
    ),
    { ...size }
  );
}
