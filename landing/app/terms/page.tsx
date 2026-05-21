import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Terms of Service — Skriptly",
  description: "Terms of Service for Skriptly transcription service.",
};

export default function TermsPage() {
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
          Terms of Service
        </h1>
        <p style={{ color: "var(--muted, #6A6358)", fontSize: 14, marginBottom: 48 }}>
          Last updated: May 2025
        </p>

        <DocSection title="1. Acceptance of Terms">
          <p>By accessing or using Skriptly (&quot;the Service&quot;), you agree to be bound by these Terms of Service. If you do not agree, please do not use the Service.</p>
        </DocSection>

        <DocSection title="2. Description of Service">
          <p>Skriptly is a cloud-based transcription service that converts audio recordings into text with automatic speaker identification. The Service uses third-party AI infrastructure (Modal, OpenAI-compatible models, Google Gemini) to process audio.</p>
        </DocSection>

        <DocSection title="3. User Accounts">
          <p>You must create an account to use the Service. You may sign in using Google OAuth or email magic link, provided by Supabase Auth. You are responsible for keeping your account credentials secure.</p>
        </DocSection>

        <DocSection title="4. Audio Data">
          <p>Audio files you upload are processed in-memory and are not permanently stored on our servers. Transcription results are stored in your personal account history and are accessible only to you. You may delete your transcripts at any time.</p>
        </DocSection>

        <DocSection title="5. Acceptable Use">
          <p>You agree not to use the Service to:</p>
          <ul>
            <li>Record or transcribe conversations without the consent of all participants</li>
            <li>Process, store, or transmit unlawful, harmful, or abusive content</li>
            <li>Attempt to reverse-engineer, copy, or resell the Service</li>
            <li>Circumvent usage limits or subscription restrictions</li>
          </ul>
        </DocSection>

        <DocSection title="6. Subscription and Billing">
          <p>Skriptly offers free and paid subscription plans. Paid subscriptions are billed via Stripe. You may cancel at any time through the account settings. Refunds are handled on a case-by-case basis — contact support if you believe you were incorrectly charged.</p>
        </DocSection>

        <DocSection title="7. Service Availability">
          <p>We strive to maintain high availability but do not guarantee uninterrupted service. We may modify, suspend, or discontinue features with reasonable notice.</p>
        </DocSection>

        <DocSection title="8. Intellectual Property">
          <p>The transcripts generated from your audio are your content. You retain all rights to your audio files and transcriptions. Skriptly does not claim ownership of your data.</p>
        </DocSection>

        <DocSection title="9. Disclaimer of Warranties">
          <p>The Service is provided &quot;as is&quot; without warranties of any kind. Transcription accuracy depends on audio quality, language, and accents — we do not guarantee 100% accuracy.</p>
        </DocSection>

        <DocSection title="10. Limitation of Liability">
          <p>To the fullest extent permitted by law, Skriptly shall not be liable for indirect, incidental, or consequential damages arising from your use of the Service.</p>
        </DocSection>

        <DocSection title="11. Changes to Terms">
          <p>We may update these Terms from time to time. Continued use of the Service after changes constitutes acceptance of the updated Terms.</p>
        </DocSection>

        <DocSection title="12. Contact">
          <p>For questions about these Terms, contact us at <a href="mailto:hello@skriptly.io" style={{ color: "var(--cta, #3F65DD)" }}>hello@skriptly.io</a>.</p>
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
