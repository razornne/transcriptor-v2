"use client";

// Footer под транскриптом: статус автосейва + Copy / Download

export function Footer({
  status,
  onCopy,
  onDownload,
}: {
  status: string;
  onCopy?: () => void;
  onDownload?: () => void;
}) {
  return (
    <div className="s-footer">
      <div className="s-footer-status">
        <span className="dot" />
        <span>{status}</span>
      </div>
      <div className="s-footer-actions">
        <button type="button" className="s-btn" onClick={onCopy}>
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="3" y="3" width="7" height="8" rx="1.2" />
            <path d="M5 3V2a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-1" />
          </svg>
          Copy
        </button>
        <button type="button" className="s-btn s-btn-primary" onClick={onDownload}>
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6.5 2v7M3 6l3.5 3.5L10 6M2.5 11h8" />
          </svg>
          Download .md
        </button>
      </div>
    </div>
  );
}
