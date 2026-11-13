import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// OpenGraph image, 1200x630. Shown when the link is shared on LinkedIn, Telegram,
// Slack, iMessage etc. LinkedIn shows it at ~450px wide, so everything here is big:
// brand mark, two-line headline and a sample transcript card with three speakers.
// Fonts are the same as the site and live next to this file (satori needs static TTFs).

export const alt = "Skriptly — Every call, word for word.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const PAPER = "#F6F4EE";
const INK = "#14120E";
const MUTE = "#6B6557";
const LINE = "#E4DFD2";
const SURFACE = "#FCFBF8";
const BLUE = "#2740E6";
const TERRACOTTA = "#B25E4B";
const LILAC = "#6E6496";

const S_PATH =
  "M50.15 75Q45.31 75 41.52 74Q37.72 73.01 35.06 71.05Q32.39 69.1 30.96 66.22Q29.53 63.34 29.39 59.64L39.91 56.62Q40.1 59.8 41.52 61.85Q42.94 63.9 45.36 64.88Q47.79 65.86 50.77 65.86Q53.45 65.86 55.35 65.19Q57.25 64.52 58.27 63.42Q59.3 62.31 59.3 60.96Q59.3 59.3 57.95 58.22Q56.6 57.13 54.25 56.35Q51.89 55.58 48.82 54.82Q45.41 53.95 42.09 52.91Q38.77 51.88 36.06 50.26Q33.35 48.64 31.73 46.08Q30.1 43.51 30.1 39.65Q30.1 35.12 32.4 31.85Q34.7 28.58 39.01 26.79Q43.31 25 49.27 25Q55.31 25 59.74 26.86Q64.18 28.73 66.57 32.16Q68.97 35.6 68.88 40.31L58.29 42.81Q58.32 40.67 57.71 39.04Q57.1 37.41 55.94 36.31Q54.78 35.21 53.06 34.63Q51.33 34.05 49.07 34.05Q46.53 34.05 44.79 34.68Q43.05 35.3 42.16 36.34Q41.27 37.38 41.27 38.73Q41.27 40.38 42.64 41.46Q44.01 42.54 46.42 43.3Q48.83 44.06 51.89 44.82Q55.02 45.57 58.28 46.58Q61.55 47.59 64.36 49.24Q67.18 50.88 68.9 53.59Q70.61 56.3 70.61 60.44Q70.61 65.03 68.19 68.29Q65.77 71.55 61.18 73.28Q56.6 75 50.15 75Z";

// Static route: rendered once at build time, so reading from disk is fine.
const font = (file: string) => readFile(join(process.cwd(), "app", "og-fonts", file));

const TURNS = [
  { name: "Anna", time: "00:12", color: BLUE, text: "Let's lock the launch for the 14th." },
  { name: "Max", time: "00:16", color: TERRACOTTA, text: "Works for me. I'll send the brief today." },
  { name: "Olena", time: "00:21", color: LILAC, text: "Чудово, тоді до зустрічі." },
];

export default async function OpengraphImage() {
  const [bricolage600, bricolage700, serifItalic, mono, manrope] = await Promise.all([
    font("bricolage-600.ttf"),
    font("bricolage-700.ttf"),
    font("instrument-serif-italic.ttf"),
    font("jetbrains-mono-500.ttf"),
    font("manrope-500.ttf"),
  ]);

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          background: PAPER,
          color: INK,
          display: "flex",
          flexDirection: "column",
          padding: 72,
          fontFamily: "Manrope",
        }}
      >
        {/* Top: mark + wordmark, url */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center" }}>
            <div
              style={{
                width: 60,
                height: 60,
                borderRadius: 14,
                background: INK,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <svg width="60" height="60" viewBox="0 0 100 100">
                <path d={S_PATH} fill={PAPER} />
              </svg>
            </div>
            <div
              style={{
                marginLeft: 18,
                fontFamily: "Bricolage Grotesque",
                fontWeight: 600,
                fontSize: 38,
                letterSpacing: -0.6,
              }}
            >
              Skriptly
            </div>
          </div>
          <div style={{ fontFamily: "JetBrains Mono", fontSize: 24, color: MUTE }}>skriptly.io</div>
        </div>

        {/* Main: headline + transcript card */}
        <div style={{ display: "flex", flex: 1, alignItems: "center" }}>
          <div style={{ display: "flex", flexDirection: "column", flex: 1, paddingRight: 48 }}>
            <div
              style={{
                fontFamily: "Bricolage Grotesque",
                fontWeight: 700,
                fontSize: 86,
                lineHeight: 1,
                letterSpacing: -2.6,
              }}
            >
              Every call,
            </div>
            <div
              style={{
                fontFamily: "Instrument Serif",
                fontStyle: "italic",
                fontWeight: 400,
                fontSize: 95,
                lineHeight: 1.04,
                letterSpacing: -1,
                color: BLUE,
              }}
            >
              word for word.
            </div>
            <div style={{ display: "flex", flexDirection: "column", fontSize: 28, lineHeight: 1.35, color: MUTE, marginTop: 28 }}>
              <div>Speakers separated automatically,</div>
              <div>in 60+ languages.</div>
            </div>
          </div>

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              width: 456,
              background: SURFACE,
              border: `1px solid ${LINE}`,
              borderRadius: 24,
              padding: "30px 34px",
              boxShadow: "0 29px 60px -29px rgba(20,18,14,0.28)",
            }}
          >
            {TURNS.map((t, i) => (
              <div key={t.name} style={{ display: "flex", flexDirection: "column", marginTop: i === 0 ? 0 : 24 }}>
                <div style={{ display: "flex", alignItems: "baseline" }}>
                  <div
                    style={{
                      fontFamily: "Bricolage Grotesque",
                      fontWeight: 600,
                      fontSize: 23,
                      lineHeight: 1,
                      color: t.color,
                    }}
                  >
                    {t.name}
                  </div>
                  <div style={{ fontFamily: "JetBrains Mono", fontSize: 15, color: MUTE, marginLeft: 12 }}>
                    {t.time}
                  </div>
                </div>
                <div style={{ fontSize: 26, lineHeight: 1.35, marginTop: 6 }}>{t.text}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [
        { name: "Bricolage Grotesque", data: bricolage600, weight: 600, style: "normal" },
        { name: "Bricolage Grotesque", data: bricolage700, weight: 700, style: "normal" },
        { name: "Instrument Serif", data: serifItalic, weight: 400, style: "italic" },
        { name: "JetBrains Mono", data: mono, weight: 500, style: "normal" },
        { name: "Manrope", data: manrope, weight: 500, style: "normal" },
      ],
    }
  );
}
