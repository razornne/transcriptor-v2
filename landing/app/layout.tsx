import type { Metadata } from "next";
import "./globals.css";

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
  },
};

// Inline скрипт применяет сохранённую тему ДО первого рендера,
// чтобы не было flash-of-wrong-theme.
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
          href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wdth,wght@12..96,75..100,300..800&family=Onest:wght@300;400;500;600;700;800;900&family=Manrope:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap"
        />
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
