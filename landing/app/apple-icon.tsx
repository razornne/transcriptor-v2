import { ImageResponse } from "next/og";

// Apple touch icon — 180x180, shown on iOS when user adds to home screen.

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          background: "#1A1814",
          color: "#EDE8E0",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 124,
          fontWeight: 700,
          fontFamily: "system-ui, sans-serif",
          borderRadius: 40,
          letterSpacing: -2,
        }}
      >
        S
      </div>
    ),
    { ...size }
  );
}
