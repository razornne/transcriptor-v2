import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default async function AppleIcon() {
  let fontData: ArrayBuffer | undefined;
  try {
    const css = await fetch(
      "https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wdth,wght@12..96,75..100,800&display=swap",
      { headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36" } }
    ).then((r) => r.text());
    const urlMatch = css.match(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/);
    if (urlMatch) fontData = await fetch(urlMatch[1]).then((r) => r.arrayBuffer());
  } catch {}

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          background: "#100F0C",
          color: "#F6F4EE",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 124,
          fontWeight: 800,
          fontFamily: fontData ? "Bricolage Grotesque" : "serif",
          letterSpacing: -2,
        }}
      >
        S
      </div>
    ),
    {
      ...size,
      ...(fontData
        ? { fonts: [{ name: "Bricolage Grotesque", data: fontData, weight: 800, style: "normal" as const }] }
        : {}),
    }
  );
}
