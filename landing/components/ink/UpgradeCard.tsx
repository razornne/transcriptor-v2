"use client";

// Единый upgrade-блок: лимит исчерпан / AI-гейт Free / 402 с сервера.
// Klein-accent (не киноварь — киноварь только для rec).
// onUpgrade открывает SettingsModal на вкладке Subscription.

export function UpgradeCard({
  title,
  body,
  ctaLabel = "View plans",
  onUpgrade,
}: {
  title: string;
  body: string;
  ctaLabel?: string;
  onUpgrade?: () => void;
}) {
  return (
    <div className="i-upsell">
      <div className="i-upsell-text">
        <span className="i-upsell-title">{title}</span>
        <span className="i-upsell-body">{body}</span>
      </div>
      <button type="button" className="i-upsell-cta" onClick={onUpgrade}>
        {ctaLabel}
      </button>
    </div>
  );
}
