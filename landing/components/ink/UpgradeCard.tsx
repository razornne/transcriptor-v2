"use client";
import { BILLING_URL } from "@/lib/ink/config";

// Единый upgrade-блок (Спринт 2): лимит исчерпан / AI-гейт Free / 402 с сервера.
// Klein-accent (не киноварь — киноварь только для rec). CTA ведёт в биллинг
// боевого /app (до Спринта 3, который перенесёт Settings в Ink).

export function UpgradeCard({
  title,
  body,
  ctaLabel = "Open billing",
}: {
  title: string;
  body: string;
  ctaLabel?: string;
}) {
  return (
    <div className="i-upsell">
      <div className="i-upsell-text">
        <span className="i-upsell-title">{title}</span>
        <span className="i-upsell-body">{body}</span>
      </div>
      <a className="i-upsell-cta" href={BILLING_URL} target="_blank" rel="noopener noreferrer">
        {ctaLabel}
      </a>
    </div>
  );
}
