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
          Last updated: May 26, 2026
        </p>

        <DocSection title="1. Who We Are">
          <p>Skriptly (&quot;we&quot;, &quot;us&quot;, &quot;our&quot;) is a transcription service at <strong>skriptly.io</strong>. We turn audio recordings into text transcripts with automatic speaker separation, summaries, and action items.</p>
          <p style={{ marginTop: 12 }}>This Privacy Policy explains what we collect, why, and how to control your data.</p>
        </DocSection>

        <DocSection title="2. What We Collect">
          <p><strong>Account information:</strong> when you sign in (Google or email magic link), we receive your email address and a unique user identifier. Google Sign-In gives us only your email and display name — we do <strong>not</strong> access Gmail, Drive, Calendar, or any other Google service.</p>
          <p style={{ marginTop: 12 }}><strong>Audio:</strong> the audio you record or upload is sent to our cloud GPU (Modal) for transcription. It is held in memory only as long as needed to produce the transcript — typically 1–2 minutes — then <strong>discarded</strong>. We do not save audio files anywhere.</p>
          <p style={{ marginTop: 12 }}><strong>Transcripts:</strong> the resulting text (segments, speakers, your notes, generated Summary / Action items) is stored in your personal account in our Postgres database. Only you can read it. Row-Level Security ensures no other user can access your transcripts.</p>
          <p style={{ marginTop: 12 }}><strong>Personal vocabulary:</strong> when an AI correction step replaces a transcribed word with a different one (typically jargon, abbreviations, or proper names), we save those terms to your personal vocabulary so the next recording recognizes them automatically. This is plain text, tied to your user id.</p>
          <p style={{ marginTop: 12 }}><strong>Usage data:</strong> we count minutes of audio processed per month to enforce plan limits. We use PostHog to track product events (sign-in, transcription completed, button clicks) for analytics and bug-finding. Session replays are recorded with all input fields masked and transcript text blocked — we never see your actual transcripts via replay.</p>
          <p style={{ marginTop: 12 }}><strong>Payments:</strong> if you subscribe, Stripe handles your card details. We only see the Stripe customer / subscription ID, never card numbers.</p>
        </DocSection>

        <DocSection title="3. Where Your Data Goes">
          <p>By default, your transcript text passes through these third-party processors as part of normal operation:</p>
          <ul>
            <li><strong>Modal</strong> — runs Whisper (speech recognition), pyannote (speaker separation), and a local LLM (Qwen) on GPU. Audio + transcripts are processed in isolated containers; Modal does not have human access to runtime data.</li>
            <li><strong>Supabase</strong> — stores your account and transcripts. Encrypted at rest. Row-Level Security enforces per-user isolation.</li>
            <li><strong>Google Gemini API</strong> — improves transcription quality (corrects mis-heard words using world knowledge) and generates Summary / Action items. Only the transcript text is sent — no user id or email.</li>
            <li><strong>Stripe</strong> — payment processing for paid plans.</li>
            <li><strong>Vercel</strong> — hosts our landing page and routes traffic. Audio and transcripts <strong>do not</strong> go through Vercel — they go directly from your browser to Modal.</li>
            <li><strong>PostHog (EU region)</strong> — product analytics. Events stored in PostHog&apos;s EU servers (GDPR-friendly).</li>
            <li><strong>Resend</strong> — outbound email (magic link sign-in, account notifications).</li>
            <li><strong>Notion API</strong> — only if you explicitly connect your Notion workspace via OAuth. We use your token only when you click &quot;Send to Notion&quot; on a transcript.</li>
          </ul>
          <p style={{ marginTop: 12 }}>We do not sell or rent your data to anyone.</p>
        </DocSection>

        <DocSection title="4. Privacy Mode (Max & Team plans)">
          <p>If you are on a Max or Team plan, you can enable <strong>Privacy Mode</strong> in Settings. When on:</p>
          <ul>
            <li>Transcription correction skips the Google Gemini API and uses a smaller local model (Qwen) on our GPU.</li>
            <li>Summary and Action items use a self-hosted open-source model (gpt-oss-20b) on our GPU.</li>
            <li><strong>Your transcript text never reaches Google or any other LLM provider.</strong></li>
          </ul>
          <p style={{ marginTop: 12 }}>Trade-off: the self-hosted models produce summaries that are slightly less detailed than Gemini. Speed and accuracy of the core transcription (Whisper) are unchanged.</p>
        </DocSection>

        <DocSection title="5. How We Use Your Information">
          <ul>
            <li>To authenticate you and give you access to your account</li>
            <li>To process audio into transcripts and AI-generated summaries</li>
            <li>To store your transcript history so you can read it later</li>
            <li>To enforce subscription plan limits and process payments</li>
            <li>To improve the product (anonymized event analytics, bug tracking)</li>
            <li>To send service emails (magic-link sign-in, billing receipts)</li>
            <li>To notify our team operationally about new signups and payments (Telegram bot — includes only your email and user id)</li>
          </ul>
          <p style={{ marginTop: 12 }}>We do <strong>not</strong> use your transcripts to train models, advertise to you, or share them with anyone.</p>
        </DocSection>

        <DocSection title="6. Google User Data">
          <p>Skriptly uses Google Sign-In (via Supabase Auth) solely for authentication. We receive your email address and display name. We do not access, store, or share any other data from your Google account.</p>
          <p style={{ marginTop: 12 }}>Our use of Google API data adheres to the <a href="https://developers.google.com/terms/api-services-user-data-policy" target="_blank" rel="noopener noreferrer" style={{ color: "var(--cta, #3F65DD)" }}>Google API Services User Data Policy</a>, including the Limited Use requirements.</p>
        </DocSection>

        <DocSection title="7. Data Retention">
          <ul>
            <li><strong>Audio:</strong> discarded within minutes of processing — never stored.</li>
            <li><strong>Transcripts:</strong> kept as long as your account exists. You can delete individual transcripts at any time (the &quot;×&quot; button in History with a 7-second undo).</li>
            <li><strong>Account data:</strong> Settings → Danger zone → &quot;Delete my account&quot; immediately removes your account, all transcripts, all personal vocabulary, and cancels any active Stripe subscription. Workspace memberships are removed; if you owned a workspace, it&apos;s deleted too.</li>
            <li><strong>Payment records:</strong> kept by Stripe for accounting and tax compliance, even after account deletion. We retain the Stripe customer ID for historical invoice access but no other data.</li>
            <li><strong>Analytics events:</strong> PostHog stores aggregated events for up to 7 years per their default retention; we don&apos;t link them to deleted accounts beyond your last session.</li>
          </ul>
        </DocSection>

        <DocSection title="8. Workspace Sharing">
          <p>If you join a workspace, the owner sees a list of members. You can mark individual transcripts as &quot;visible to workspace&quot; (otherwise they stay private). Owners cannot see your private transcripts, only those you explicitly share. Leaving a workspace removes you from the member list but keeps your private transcripts intact.</p>
        </DocSection>

        <DocSection title="9. Security">
          <p>HTTPS everywhere. JWT-based authentication with short-lived tokens. Row-Level Security in Postgres (users can only query their own rows). Encrypted at-rest storage in Supabase. We never store plaintext passwords (Supabase handles all auth secrets). Stripe handles all card data — we never see it.</p>
        </DocSection>

        <DocSection title="10. Your Rights (GDPR / general)">
          <p>You have the right to:</p>
          <ul>
            <li><strong>Access</strong> your data — viewable directly in the app under History</li>
            <li><strong>Export</strong> any transcript as Markdown (Download .md button)</li>
            <li><strong>Correct</strong> any transcript (inline edit; renaming speakers)</li>
            <li><strong>Delete</strong> individual transcripts or your entire account, on demand, no questions asked</li>
            <li><strong>Object</strong> to processing — stop using the service and delete your account; we will not retain your data</li>
            <li><strong>Lodge a complaint</strong> with your local data-protection authority if you believe we have mishandled your data</li>
          </ul>
          <p style={{ marginTop: 12 }}>For any of the above that you cannot do yourself in the app, email <a href="mailto:hello@skriptly.io" style={{ color: "var(--cta, #3F65DD)" }}>hello@skriptly.io</a>.</p>
        </DocSection>

        <DocSection title="11. Cookies and Local Storage">
          <p>We use browser localStorage to remember preferences (theme, interface language, dismissed onboarding banners) and to cache your Supabase session token. Stripe and PostHog may set their own cookies on their respective domains. We do not use advertising or cross-site tracking cookies.</p>
        </DocSection>

        <DocSection title="12. Children's Privacy">
          <p>Skriptly is not directed to children under 13 (or under 16 in the EU). We do not knowingly collect data from minors. If you believe a child has created an account, contact us for immediate removal.</p>
        </DocSection>

        <DocSection title="13. International Transfers">
          <p>Skriptly is operated from Ukraine / Czechia. Modal and Supabase host data in the United States. PostHog hosts in the European Union. By using Skriptly you consent to this transfer. We rely on standard contractual clauses where required.</p>
        </DocSection>

        <DocSection title="14. Changes to This Policy">
          <p>We may update this Privacy Policy as the product evolves. Material changes will be announced in-app or via email. The &quot;Last updated&quot; date at the top of this page always reflects the current version. Continued use after changes constitutes acceptance.</p>
        </DocSection>

        <DocSection title="15. Contact">
          <p>For privacy questions, data export requests, or anything else: <a href="mailto:hello@skriptly.io" style={{ color: "var(--cta, #3F65DD)" }}>hello@skriptly.io</a>.</p>
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
