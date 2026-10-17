"use client";
import { memo, useEffect, useRef } from "react";
import type { Turn } from "@/lib/ink/speakers";
import {
  fmtTime, spkBar, spkColor, spkDisplay, spkInitial, spkSoft, stripDash,
  type NameSuggestion, type SpeakerStat,
} from "@/lib/ink/speakers";

// Транскрипт «ходами»: аватар, имя и время в одной строке, под ними реплики
// спикера. Редактирование имени и текста — как раньше (двойной клик / карандаш).

export const TurnRow = memo(function TurnRow({
  turn, name, displayName, editingSpk, editingIdx,
  onStartEdit, onRename, onCancelEdit, onStartTextEdit, onSaveText, onCancelTextEdit,
}: {
  turn: Turn; name: string; displayName: string;
  editingSpk: boolean; editingIdx: number | null;
  onStartEdit: (idx: number) => void;
  onRename: (label: string, value: string) => void;
  onCancelEdit: () => void;
  onStartTextEdit: (idx: number) => void;
  onSaveText: (idx: number, val: string) => void;
  onCancelTextEdit: () => void;
}) {
  const color = spkColor(turn.speaker);
  const first = turn.items[0];
  // Фокус в поле имени БЕЗ прокрутки страницы (иначе транскрипт дёргается).
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editingSpk) inputRef.current?.focus({ preventScroll: true });
  }, [editingSpk]);

  return (
    <section className="i-turn" id={`seg-${first.idx}`}>
      <div className="i-av2" style={{ background: spkSoft(turn.speaker), color }} aria-hidden="true">
        {spkInitial(displayName)}
      </div>
      <div className="i-turn-body">
        <div className="i-turn-head">
          {editingSpk ? (
            <input
              ref={inputRef}
              className="i-spk-edit"
              style={{ color }}
              defaultValue={name} placeholder={displayName}
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
              onBlur={(e) => onRename(turn.speaker, e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                if (e.key === "Escape") onCancelEdit();
              }}
            />
          ) : (
            <button
              type="button" className="i-spk" style={{ color }}
              title="Click to rename"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); e.preventDefault(); onStartEdit(first.idx); }}
            >
              {displayName}<span className="i-spk-hint"> ✎</span>
            </button>
          )}
          <span className="i-seg-time">{fmtTime(first.seg.start)}</span>
        </div>

        {turn.items.map(({ idx, seg }, k) =>
          editingIdx === idx ? (
            <textarea
              key={idx}
              className="i-seg-edit-area"
              autoFocus
              defaultValue={seg.text}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  onSaveText(idx, (e.target as HTMLTextAreaElement).value);
                }
                if (e.key === "Escape") onCancelTextEdit();
              }}
              onBlur={(e) => onSaveText(idx, e.target.value)}
            />
          ) : (
            <div key={idx} className="i-para" onDoubleClick={() => onStartTextEdit(idx)}>
              <p className="i-seg-text">
                {stripDash(seg.text)}
                {seg.edited && <span className="i-seg-edited">edited</span>}
              </p>
              <button type="button" className="i-seg-pencil" aria-label="Edit text" onClick={() => onStartTextEdit(idx)}>✎</button>
              {k > 0 && <span className="i-para-time">{fmtTime(seg.start)}</span>}
            </div>
          ),
        )}
      </div>
    </section>
  );
});

// «Кто говорил»: доли времени и найденные в разговоре имена.
export function SpeakersCard({
  stats, names, suggestions, onPick, onAccept, onDismiss, onAcceptAll,
}: {
  stats: SpeakerStat[];
  names: Record<string, string>;
  suggestions: NameSuggestion[];
  onPick: (stat: SpeakerStat) => void;
  onAccept: (s: NameSuggestion) => void;
  onDismiss: (s: NameSuggestion) => void;
  onAcceptAll: () => void;
}) {
  return (
    <section className="i-spkcard" aria-label="Speakers">
      <div className="i-spkcard-head">
        <span className="i-eyebrow">Who spoke</span>
        <span className="i-spkcard-hint">share of talk time</span>
      </div>
      <div className="i-share" aria-hidden="true">
        {stats.map((s) => (
          <span key={s.label} style={{ width: `${Math.max(2, s.share * 100)}%`, background: spkBar(s.label) }} />
        ))}
      </div>
      <div className="i-spkchips">
        {stats.map((s) => {
          const display = spkDisplay(s.label, names);
          return (
            <button key={s.label} type="button" className="i-spkchip" title="Rename" onClick={() => onPick(s)}>
              <span className="i-av2 sm" style={{ background: spkSoft(s.label), color: spkColor(s.label) }}>{spkInitial(display)}</span>
              <span className="i-spkchip-name" style={{ color: spkColor(s.label) }}>{display}</span>
              <span className="i-spkchip-pct">{Math.round(s.share * 100)}%</span>
            </button>
          );
        })}
      </div>

      {suggestions.length > 0 && (
        <div className="i-suggest">
          <div className="i-suggest-head">
            <b>{suggestions.length > 1 ? "We found names in the conversation" : "We found a name in the conversation"}</b>
            {suggestions.length > 1 && (
              <button type="button" className="i-suggest-all" onClick={onAcceptAll}>Accept all</button>
            )}
          </div>
          <div className="i-suggest-list">
            {suggestions.map((s) => (
              <div className="i-suggest-row" key={s.speaker}>
                <span className="i-suggest-what">{spkDisplay(s.speaker, names)} → <b>{s.name}</b></span>
                <span className="i-suggest-why">“{s.evidence}” at {fmtTime(s.at)}</span>
                <span className="i-suggest-act">
                  <button type="button" className="i-suggest-yes" onClick={() => onAccept(s)}>Accept</button>
                  <button type="button" className="i-suggest-no" onClick={() => onDismiss(s)}>Dismiss</button>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
