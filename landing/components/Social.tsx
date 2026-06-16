import type { Copy } from "@/lib/content";

const STATS_EN = [
  { label: "Languages", value: "100+ languages", live: false },
  { label: "Retention", value: "0 seconds", live: false },
  { label: "Processing", value: "GPU-hosted", live: true },
  { label: "Install", value: "None required", live: false },
  { label: "Export", value: "Markdown / .txt", live: false },
  { label: "Speaker ID", value: "Automatic", live: false },
];

const STATS_UA = [
  { label: "Мови", value: "100+ мов", live: false },
  { label: "Збереження", value: "0 секунд", live: false },
  { label: "Обробка", value: "GPU-сервер", live: true },
  { label: "Встановлення", value: "Не потрібне", live: false },
  { label: "Експорт", value: "Markdown / .txt", live: false },
  { label: "Спікери", value: "Автоматично", live: false },
];

export function Social({ t }: { t: Copy }) {
  // Use UA stats when the copy language looks Ukrainian
  const stats = t.hero.eyebrow.includes("сервер") ? STATS_UA : STATS_EN;
  return (
    <div className="trust-bar">
      <div className="wrap">
        <div className="trust-inner">
          {stats.map((s, i) => (
            <div className="trust-stat" key={i}>
              {s.live && <span className="trust-live" aria-hidden="true" />}
              <span>{s.label} <strong>{s.value}</strong></span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
