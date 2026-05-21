import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy Policy — Skriptly",
  description: "Privacy Policy for Skriptly transcription service.",
};

export default function PrivacyPage() {
  return (
    <main style={{
      minHeight: "100vh",
      background: "var(--ground, #EDE8E0)",
      color: "var(--ink, #1A1814)",
      fontFamily: "var(--sans, sans-serif)",
      padding: "clamp(40px, 8vw, 96px) clamp(20px, 6vw, 80px)",
    }}>
      <div style={{ maxWidth: 720, margin: "0 auto" }}>
        <Link href="/" style={{
          display: "inline-flex", alignItems: "center", gap: 6,
          fontSize: 14, color: "var(--muted, #6A6358)",
          textDecoration: "none", marginBottom: 40,
        }}>
          ← Back to Skriptly
        </Link>

        <h1 style={{
          fontFamily: "var(--display, sans-serif)",
          fontSize: "clamp(28px, 5vw, 42px)",
          fontWeight: 700, marginBottom: 8, lineHeight: 1.1,
        }}>
          Privacy Policy
        </h1>
        <p style={{ color: "var(--muted, #6A6358)", fontSize: 14, marginBottom: 48 }}>
          Last updated: May 2025
        </p>

        <DocSection title="1. Who We Are">
          <p>Skriptly (&quot;we&quot;, &quot;us&quot;, &quot;our&quot;) is a transcription service accessible at <strong>skriptly.io</strong>. We process audio recordings to produce text transcripts with automatic speaker identification.</p>
        </DocSection>

        <DocSection title="2. Information We Collect">
          <p><strong>Account information:</strong> When you sign in with Google or email, we receive your email address and a unique user identifier from Supabase Auth. If you use Google Sign-In, we receive only your name and email address as granted by the Google OAuth consent — we do not request access to your Google Drive, Gmail, Calendar, or any other Google services.</p>
          <p style={{ marginTop: 12 }}><strong>Audio files:</strong> Audio you upload for transcription is processed in real-time on our cloud infrastructure (Modal) and is not stored permanently.</p>
          <p style={{ marginTop: 12 }}><strong>Transcripts:</strong> The resulting text transcripts are stored in your personal account (Supabase Postgres) and are associated with your user ID. Only you can access your transcripts.</p>
          <p style={{ marginTop: 12 }}><strong>Usage data:</strong> We track minutes of audio processed per user per month to enforce plan limits. Vercel Analytics may collect anonymized page-view data (no personally identifiable information).</p>
        </DocSection>

        <DocSection title="3. How We Use Your Information">
          <ul>
            <li>To authenticate you and provide access to your account</li>
            <li>To process your audio and return transcription results</li>
            <li>To store your transcript history so you can access it later</li>
            <li>To enforce subscription plan limits (minutes used per month)</li>
            <li>To process subscription payments via Stripe (we do not store card details)</li>
          </ul>
        </DocSection>

        <DocSection title="4. Google User Data">
          <p>Skriptly uses Google Sign-In (via Supabase Auth) solely for authentication. We receive your Google account email address and display name. We do not access, store, or share any other data from your Google account. We do not use Google user data for advertising or any purpose beyond authentication and account identification.</p>
          <p style={{ marginTop: 12 }}>Our use of information received from Google APIs adheres to the <a href="https://developers.google.com/terms/api-services-user-data-policy" target="_blank" rel="noopener noreferrer" style={{ color: "var(--cta, #3F65DD)" }}>Google API Services User Data Policy</a>, including the Limited Use requirements.</p>
        </DocSection>

        <DocSection title="5. Data Sharing">
          <p>We do not sell, rent, or share your personal data with third parties except:</p>
          <ul>
            <li><strong>Supabase</strong> — authentication and database (your transcripts are stored here)</li>
            <li><strong>Modal</strong> — cloud GPU infrastructure for audio processing</li>
            <li><strong>Stripe</strong> — payment processing for subscriptions</li>
            <li><strong>Google Gemini API</strong> — AI analysis (Summary, Action Items) — only the transcript text, no personal info</li>
            <li><strong>Vercel</strong> — hosting and edge network</li>
          </ul>
          <p style={{ marginTop: 12 }}>All processors handle data under their own privacy policies and applicable data protection regulations.</p>
        </DocSection>

        <DocSection title="6. Data Retention">
          <p>Your transcript history is retained as long as your account exists. You may delete individual transcripts or your entire account at any time. Audio files are not stored — they are processed and discarded.</p>
        </DocSection>

        <DocSection title="7. Security">
          <p>We use industry-standard security: HTTPS everywhere, JWT-based authentication, Row Level Security in Supabase (each user can only access their own data), and encrypted storage. We do not store plaintext passwords.</p>
        </DocSection>

        <DocSection title="8. Your Rights">
          <p>You have the right to access, correct, export, or delete your data at any time. To delete your account or request a data export, contact us at <a href="mailto:hello@skriptly.io" style={{ color: "var(--cta, #3F65DD)" }}>hello@skriptly.io</a>.</p>
        </DocSection>

        <DocSection title="9. Cookies">
          <p>We use browser localStorage (not traditional cookies) to store your preferences (theme, language) and session tokens. We do not use tracking cookies or third-party advertising cookies.</p>
        </DocSection>

        <DocSection title="10. Children's Privacy">
          <p>Skriptly is not directed to children under 13. We do not knowingly collect data from children. If you believe a child has created an account, please contact us for removal.</p>
        </DocSection>

        <DocSection title="11. Changes to This Policy">
          <p>We may update this Privacy Policy. We will notify users of material changes via email or in-app notification. Continued use of the Service after changes constitutes acceptance.</p>
        </DocSection>

        <DocSection title="12. Contact">
          <p>For privacy questions or data requests, contact us at <a href="mailto:hello@skriptly.io" style={{ color: "var(--cta, #3F65DD)" }}>hello@skriptly.io</a>.</p>
        </DocSection>
      </div>
    </main>
  );
}

function DocSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 36 }}>
      <h2 style={{
        fontSize: 18, fontWeight: 600, marginBottom: 10,
        fontFamily: "var(--display, sans-serif)",
      }}>{title}</h2>
      <div style={{
        fontSize: 15, lineHeight: 1.7,
        color: "var(--ink-2, #2C2922)",
      }}>
        {children}
      </div>
    </section>
  );
}
