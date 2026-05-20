"use client";
import { useEffect, useState } from "react";
import { Sidebar } from "@/components/studio/Sidebar";
import { Topbar } from "@/components/studio/Topbar";
import { StudioPanel } from "@/components/studio/StudioPanel";
import { SpeakerChips } from "@/components/studio/SpeakerChips";
import { TranscriptTabs, type TabKey } from "@/components/studio/TranscriptTabs";
import { TranscriptView } from "@/components/studio/TranscriptView";
import { Footer } from "@/components/studio/Footer";
import {
  MOCK_HISTORY,
  MOCK_TRANSCRIPT,
  MOCK_SPEAKER_NAMES,
  MOCK_USER,
} from "@/lib/studio/mock-data";

// Phase 1: композер показывает «состояние live recording» со всей статикой
// дизайна. Стейт пока локальный mock, без бэка.

export default function StudioPage() {
  const [activeTab, setActiveTab] = useState<TabKey>("transcript");
  const [recording, setRecording] = useState(true); // показываем live state по дефолту
  const [language, setLanguage] = useState("");      // auto-detect
  const [activeHistory, setActiveHistory] = useState(MOCK_HISTORY[0].id);

  // Global keyboard shortcuts: ⌘K / Ctrl+K — focus search в sidebar
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isModK = (e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K");
      if (isModK) {
        e.preventDefault();
        const input = document.getElementById("studio-search") as HTMLInputElement | null;
        input?.focus();
        input?.select();
      }
      // Esc — снимает фокус с любых input в studio
      if (e.key === "Escape" && document.activeElement instanceof HTMLElement) {
        if (document.activeElement.tagName === "INPUT" || document.activeElement.tagName === "TEXTAREA") {
          (document.activeElement as HTMLElement).blur();
        }
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  const tabs = [
    { key: "transcript" as TabKey, label: "Transcript", count: MOCK_TRANSCRIPT.length },
    { key: "summary"    as TabKey, label: "Summary" },
    { key: "actions"    as TabKey, label: "Actions" },
    { key: "notes"      as TabKey, label: "Notes" },
  ];

  return (
    <div className="studio-root">
      <Sidebar
        history={MOCK_HISTORY}
        activeId={activeHistory}
        user={{
          displayName: MOCK_USER.displayName,
          initials: MOCK_USER.initials,
          plan: MOCK_USER.plan,
          hoursUsed: MOCK_USER.hoursUsed,
          hoursLimit: MOCK_USER.hoursLimit,
        }}
        onSelect={setActiveHistory}
      />

      <main className="s-main">
        <Topbar
          eyebrow={recording ? "Recording · live" : "Last session"}
          title="Standup"
          meta="May 20"
        />

        <StudioPanel
          state={recording ? "recording" : "transcript"}
          timer={recording ? "00:04:21" : "00:24:31"}
          detectedSpeakers={3}
          language={language}
          onLanguageChange={setLanguage}
          onToggleRecord={() => setRecording((r) => !r)}
        />

        <SpeakerChips
          segments={MOCK_TRANSCRIPT}
          speakerNames={MOCK_SPEAKER_NAMES}
          activeRaw={recording ? "SPEAKER_00" : undefined}
        />

        <TranscriptTabs tabs={tabs} active={activeTab} onChange={setActiveTab} />

        {/* min-height: 0 КРИТИЧНО — без этого flex item не уважает overflow
            и transcript внутри не скроллится, просто обрезается за пределами */}
        <div style={{ flex: 1, minHeight: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}>
          {activeTab === "transcript" && (
            <TranscriptView
              segments={MOCK_TRANSCRIPT}
              speakerNames={MOCK_SPEAKER_NAMES}
              liveLast={recording}
            />
          )}
          {activeTab === "summary" && (
            <EmptyTabState
              icon="∑"
              title="No summary yet"
              hint="Click Generate to create a structured summary of this conversation."
              ctaLabel="Generate summary"
            />
          )}
          {activeTab === "actions" && (
            <EmptyTabState
              icon="✓"
              title="No action items yet"
              hint="Extract a checklist of tasks discussed during the call."
              ctaLabel="Extract action items"
            />
          )}
          {activeTab === "notes" && (
            <EmptyTabState
              icon="✎"
              title="No notes yet"
              hint="Quick thoughts you jot down while recording show up here."
            />
          )}
        </div>

        <Footer status={recording ? "● Auto-saving" : "✓ Saved locally"} />
      </main>
    </div>
  );
}

// Простое empty state для пустых табов (summary / actions / notes)
function EmptyTabState({
  icon,
  title,
  hint,
  ctaLabel,
}: {
  icon: string;
  title: string;
  hint: string;
  ctaLabel?: string;
}) {
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 14,
        padding: 40,
        textAlign: "center",
      }}
    >
      <div
        style={{
          width: 56,
          height: 56,
          borderRadius: 16,
          background: "var(--s-surface)",
          border: "1px solid var(--s-border)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "var(--s-display)",
          fontSize: 26,
          color: "var(--s-mute)",
        }}
      >
        {icon}
      </div>
      <div
        style={{
          fontFamily: "var(--s-display)",
          fontSize: 20,
          fontWeight: 500,
          color: "var(--s-ink)",
        }}
      >
        {title}
      </div>
      <div style={{ color: "var(--s-mute)", maxWidth: 360, fontSize: 14 }}>{hint}</div>
      {ctaLabel && (
        <button type="button" className="s-btn s-btn-primary" style={{ marginTop: 6 }}>
          {ctaLabel}
        </button>
      )}
    </div>
  );
}
