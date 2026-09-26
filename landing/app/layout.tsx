import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Analytics } from "@vercel/analytics/react";

export const metadata: Metadata = {
  title: "Skriptly — Every call, word for word.",
  description:
    "Accurate call transcription in 60+ languages with automatic speaker separation, AI summaries and a Windows dictation app.",
  metadataBase: new URL("https://skriptly.io"),
  openGraph: {
    title: "Skriptly — Every call, word for word.",
    description:
      "Accurate call transcription in 60+ languages with automatic speaker separation, AI summaries and a Windows dictation app.",
    url: "https://skriptly.io",
    siteName: "Skriptly",
    type: "website",
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: "Skriptly — Every call, word for word.",
    description:
      "Accurate call transcription in 60+ languages with automatic speaker separation, AI summaries and a Windows dictation app.",
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

const faqJsonLd = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: [
    {
      "@type": "Question",
      name: "Is my audio stored anywhere?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "We keep a copy of each recording for 90 days so we can investigate transcription errors, then it is deleted automatically. Only the founder can access it, and it is never used to train AI models or shared. Deleting your account deletes it immediately. Details are in the Privacy Policy.",
      },
    },
    {
      "@type": "Question",
      name: "Which languages are supported?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Transcription recognizes 60+ languages and detects the language automatically, even when people switch mid-call. Ukrainian, Russian, English, Polish and Czech can also be picked explicitly, and an AI correction pass learns your domain terms.",
      },
    },
    {
      "@type": "Question",
      name: "How accurate is the transcription?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Very accurate for clear audio — comparable to professional transcription services. Accuracy depends on audio quality, accents, and speaker overlap. The AI correction layer further improves proper nouns, abbreviations, and domain terms specific to you.",
      },
    },
    {
      "@type": "Question",
      name: "How do I cancel my subscription?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "From the app: Settings → Subscription → Cancel. Cancellation takes effect at the end of the current billing period. No questions asked, no cancellation fee.",
      },
    },
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
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
        />
      </head>
      <body>
        {children}
        <Analytics />
      </body>
    </html>
  );
}
