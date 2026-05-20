"use client";

// Табы Transcript / Summary / Actions / Notes над основным контентом

export type TabKey = "transcript" | "summary" | "actions" | "notes";

export type TabDef = {
  key: TabKey;
  label: string;
  count?: number;
};

export function TranscriptTabs({
  tabs,
  active,
  onChange,
}: {
  tabs: TabDef[];
  active: TabKey;
  onChange: (key: TabKey) => void;
}) {
  return (
    <div className="s-tabs" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.key}
          type="button"
          role="tab"
          aria-selected={t.key === active}
          className={"s-tab" + (t.key === active ? " active" : "")}
          onClick={() => onChange(t.key)}
        >
          {t.label}
          {t.count !== undefined && <span className="s-tab-count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}
