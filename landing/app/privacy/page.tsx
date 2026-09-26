import type { Metadata } from "next";
import { Logo } from "@/components/Logo";

export const metadata: Metadata = {
  title: "Privacy Policy — Skriptly",
  description: "Skriptly processes audio in-memory and deletes it immediately. We never store your recordings.",
};

export default function PrivacyPage() {
  return (
    <div className="legal-page">
      <header className="legal-header">
        <a href="/" aria-label="Back to Skriptly home"><Logo /></a>
        <a href="/" className="legal-back">← Back to home</a>
      </header>

      <main className="legal-content">
        <span className="eyebrow">Legal</span>
        <h1 className="display xxl">Privacy Policy</h1>
        <p className="legal-date">Last updated: June 2026</p>

        <section>
          <h2>1. Overview</h2>
          <p>Skriptly (&quot;we&quot;, &quot;our&quot;, &quot;us&quot;) is a cloud transcription service. This policy explains what data we collect, how we use it, and what rights you have.</p>
        </section>

        <section>
          <h2>2. Audio data — zero retention</h2>
          <p>Audio you record or upload is processed entirely in memory on our GPU servers. <strong>We do not store your audio.</strong> The file is deleted within the same request — processing starts, transcription is produced, audio bytes are discarded. Retention time: <strong>0 seconds</strong>.</p>
          <p>We do not use your audio for model training, dataset collection, or any purpose other than producing your transcription.</p>
        </section>

        <section>
          <h2>3. Transcript data</h2>
          <p>Your transcripts are stored in our database (Supabase Postgres, EU region) so you can access your history across devices. Transcripts are private by default — only you can see them unless you explicitly share a workspace. You can delete any transcript at any time; deletion is permanent.</p>
        </section>

        <section>
          <h2>4. Account data</h2>
          <p>We collect your email address for authentication. We store: email, subscription plan and usage minutes, preferences (language, theme), and auto-learned vocabulary terms. We do not collect payment card data — purchases are sold and processed by Link (Stripe) as the merchant of record.</p>
        </section>

        <section>
          <h2>5. Analytics</h2>
          <p>We use PostHog (EU instance) for product analytics. Session replays have privacy masking — transcript text and AI content are never recorded. All input fields are masked.</p>
        </section>

        <section>
          <h2>6. Sub-processors</h2>
          <ul>
            <li><strong>Modal Labs</strong> — serverless GPU compute (US). Processes audio in-memory, no data persisted after transcription.</li>
            <li><strong>Supabase</strong> — auth and database (EU region).</li>
            <li><strong>Google Gemini API</strong> — AI correction and summaries. Only text is sent, never audio. Google&apos;s data terms apply.</li>
            <li><strong>Stripe / Link</strong> — merchant of record for purchases: payment, receipts, sales tax and VAT. Card data never touches our servers.</li>
            <li><strong>PostHog</strong> — privacy-masked analytics (EU).</li>
            <li><strong>Vercel</strong> — web hosting (US/EU).</li>
          </ul>
        </section>

        <section>
          <h2>7. Security</h2>
          <p>All data in transit uses TLS. Data at rest in Supabase is encrypted. Row-Level Security policies ensure you only access your own data. JWTs are short-lived and validated on every request.</p>
        </section>

        <section>
          <h2>8. Your rights</h2>
          <p>Under GDPR you have the right to access, delete, export, and correct your data. Delete your account entirely from <strong>Settings → Danger zone</strong>. Export transcripts as Markdown at any time. For other requests: <a href="mailto:privacy@skriptly.io">privacy@skriptly.io</a>.</p>
        </section>

        <section>
          <h2>9. Contact</h2>
          <p>Privacy questions: <a href="mailto:privacy@skriptly.io">privacy@skriptly.io</a></p>
        </section>
      </main>

      <footer className="legal-footer">
        <span>© 2026 Skriptly</span>
        <a href="/terms">Terms of Service</a>
        <a href="/">Back to home</a>
      </footer>
    </div>
  );
}
