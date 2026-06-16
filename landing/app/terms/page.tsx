import type { Metadata } from "next";
import { Logo } from "@/components/Logo";

export const metadata: Metadata = {
  title: "Terms of Service — Skriptly",
  description: "Terms governing your use of Skriptly, the cloud transcription service.",
};

export default function TermsPage() {
  return (
    <div className="legal-page">
      <header className="legal-header">
        <a href="/" aria-label="Back to Skriptly home"><Logo /></a>
        <a href="/" className="legal-back">← Back to home</a>
      </header>

      <main className="legal-content">
        <span className="eyebrow">Legal</span>
        <h1 className="display xxl">Terms of Service</h1>
        <p className="legal-date">Last updated: June 2026</p>

        <section>
          <h2>1. Acceptance</h2>
          <p>By creating an account or using Skriptly you agree to these Terms. If you do not agree, do not use the service.</p>
        </section>

        <section>
          <h2>2. The service</h2>
          <p>Skriptly provides cloud-based audio transcription with speaker diarisation, AI-assisted correction, and related features. We process audio files you provide and return text transcripts. Audio is processed in-memory and discarded immediately — we do not store your recordings.</p>
        </section>

        <section>
          <h2>3. Your account</h2>
          <p>You must provide a valid email address. You are responsible for keeping your account secure and for all activity under your account. Notify us immediately of any unauthorised access at <a href="mailto:hello@skriptly.io">hello@skriptly.io</a>.</p>
        </section>

        <section>
          <h2>4. Acceptable use</h2>
          <p>You may not use Skriptly to:</p>
          <ul>
            <li>Record or transcribe conversations without the consent of all participants where required by law</li>
            <li>Process content that violates applicable law (including content involving minors)</li>
            <li>Attempt to reverse-engineer, scrape, or abuse the API</li>
            <li>Resell or redistribute the service without a written agreement</li>
          </ul>
          <p>You are solely responsible for obtaining any necessary consents before recording calls.</p>
        </section>

        <section>
          <h2>5. Subscription and billing</h2>
          <p>Paid plans are billed monthly or annually via Stripe. Annual plans offer approximately 20% discount. Prices are in USD. Taxes may apply depending on your location.</p>
          <p>Unused minutes do not roll over between billing periods. If you exceed your plan limit, recording is blocked until the next period or you upgrade.</p>
        </section>

        <section>
          <h2>6. Cancellation and refunds</h2>
          <p>You can cancel your subscription at any time from <strong>Settings → Subscription → Cancel</strong>. Cancellation takes effect at the end of the current billing period — you retain access until then. We do not offer pro-rata refunds for partial periods except where required by law.</p>
        </section>

        <section>
          <h2>7. Accuracy</h2>
          <p>Transcription accuracy depends on audio quality, accents, background noise, and language. Skriptly is a tool, not a legal record. Do not rely solely on Skriptly transcripts for legal, medical, or safety-critical purposes without independent verification.</p>
        </section>

        <section>
          <h2>8. Intellectual property</h2>
          <p>Your audio and transcripts remain your property. By using the service you grant us a limited licence to process your content solely to provide the service. We claim no ownership over your content.</p>
          <p>The Skriptly software, brand, and website are our intellectual property. You may not copy, modify, or distribute them without permission.</p>
        </section>

        <section>
          <h2>9. Limitation of liability</h2>
          <p>To the maximum extent permitted by law, Skriptly is provided &quot;as is&quot; without warranty. We are not liable for indirect, consequential, or incidental damages, loss of data, or business interruption. Our total liability for any claim is limited to the amount you paid us in the three months preceding the claim.</p>
        </section>

        <section>
          <h2>10. Service availability</h2>
          <p>We aim for high availability but do not guarantee uninterrupted service. We may modify or discontinue features with reasonable notice. We will notify you of any discontinuation of the core service with at least 30 days notice.</p>
        </section>

        <section>
          <h2>11. Termination</h2>
          <p>We may suspend or terminate accounts that violate these Terms. You may delete your account at any time from <strong>Settings → Danger zone</strong>. Upon termination, your transcripts will be deleted within 30 days.</p>
        </section>

        <section>
          <h2>12. Changes to these terms</h2>
          <p>We may update these Terms as the product evolves. We will notify you of material changes via email. Continued use after notification constitutes acceptance.</p>
        </section>

        <section>
          <h2>13. Governing law</h2>
          <p>These Terms are governed by the laws of Ukraine. Disputes will be resolved in Ukrainian courts, except where prohibited by local consumer protection law.</p>
        </section>

        <section>
          <h2>14. Contact</h2>
          <p>Questions about these Terms: <a href="mailto:hello@skriptly.io">hello@skriptly.io</a></p>
        </section>
      </main>

      <footer className="legal-footer">
        <span>© 2026 Skriptly</span>
        <a href="/privacy">Privacy Policy</a>
        <a href="/">Back to home</a>
      </footer>
    </div>
  );
}
