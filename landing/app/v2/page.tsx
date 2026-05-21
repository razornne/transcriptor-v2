"use client";
import { useEffect, useState } from "react";
import { Sidebar } from "@/components/studio/Sidebar";
import { Topbar } from "@/components/studio/Topbar";
import { StudioPanel } from "@/components/studio/StudioPanel";
import { SpeakerChips } from "@/components/studio/SpeakerChips";
import { TranscriptTabs, type TabKey } from "@/components/studio/TranscriptTabs";
import { TranscriptView } from "@/components/studio/TranscriptView";
import { Footer } from "@/components/studio/Footer";
import { CommandPalette } from "@/components/studio/CommandPalette";
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
  const [recording, setRecording] = useState(true);
  const [language, setLanguage] = useState("");
  const [activeHistory, setActiveHistory] = useState(MOCK_HISTORY[0].id);
  const [paletteOpen, setPaletteOpen] = useState(false);

  // Global keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // ⌘K / Ctrl+K — открыть/закрыть command palette
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      // ⌘R / Ctrl+R — toggle recording
      if ((e.metaKey || e.ctrlKey) && (e.key === "r" || e.key === "R")) {
        // Не перехватываем дефолтный F5/reload
        if (!e.shiftKey) {
          e.preventDefault();
          setRecording((r) => !r);
          return;
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

        {/* Всё между topbar и footer скроллится одной плоскостью */}
        <div className="s-scroll">
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
          />

          <TranscriptTabs tabs={tabs} active={activeTab} onChange={setActiveTab} />

          {activeTab === "transcript" && (
            <TranscriptView
              segments={MOCK_TRANSCRIPT}
              speakerNames={MOCK_SPEAKER_NAMES}
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

        <Footer status={recording ? "Auto-saving" : "Saved locally"} />
      </main>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        history={MOCK_HISTORY}
        isRecording={recording}
        onToggleRecord={() => setRecording((r) => !r)}
        onSelectRecording={(id) => setActiveHistory(id)}
        onOpenSettings={() => { /* TODO Phase 5 */ }}
      />
    </div>
  );
}

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
        flex: "0 0 auto",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 14,
        padding: 60,
        textAlign: "center",
        minHeight: 320,
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
