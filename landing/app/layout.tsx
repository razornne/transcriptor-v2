import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Analytics } from "@vercel/analytics/react";

export const metadata: Metadata = {
  title: "Skriptly — Every call, word for word.",
  description:
    "Best-in-class Ukrainian and English transcription. Speakers separated automatically. Audio processed and deleted — never stored.",
  metadataBase: new URL("https://skriptly.io"),
  openGraph: {
    title: "Skriptly — Every call, word for word.",
    description:
      "Best-in-class Ukrainian and English transcription. Audio is processed and deleted — never stored.",
    url: "https://skriptly.io",
    siteName: "Skriptly",
    type: "website",
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: "Skriptly — Every call, word for word.",
    description:
      "Best-in-class Ukrainian and English transcription. Audio is processed and deleted — never stored.",
  },
};

// Explicit viewport — mobile-friendly + respects user zoom.
// theme-color адаптируется к выбранной теме для status bar мобильных браузеров.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#F6F4EE" },
    { media: "(prefers-color-scheme: dark)",  color: "#100F0C" },
  ],
};

// Inline скрипт применяет сохранённую тему ДО первого рендера,
// чтобы не было flash-of-wrong-theme.
// Also captures ?ref=CODE into localStorage so the referral survives
// landing → /app navigation. /app's captureRefCode reads from localStorage.
const themeBootstrap = `
(function() {
  try {
    var saved = localStorage.getItem('skriptly-theme');
    var sys = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    var theme = saved || sys;
    document.documentElement.setAttribute('data-theme', theme);
    var lang = localStorage.getItem('skriptly-lang') || 'en';
    document.documentElement.setAttribute('data-lang', lang);
    document.documentElement.lang = lang === 'ua' ? 'uk' : 'en';
    // Referral code persistence — see app captureRefCode for redeem flow
    var params = new URLSearchParams(window.location.search);
    var ref = (params.get('ref') || '').toLowerCase().trim();
    if (ref && ref.length >= 4 && ref.length <= 32) {
      localStorage.setItem('skriptly-ref-code', ref);
    }
  } catch (e) {}
})();
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wdth,wght@12..96,75..100,300..800&family=Instrument+Serif:ital@0;1&family=Onest:wght@300;400;500;600;700;800;900&family=Manrope:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap"
        />
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      </head>
      <body>
        {children}
        <Analytics />
      </body>
    </html>
  );
}
