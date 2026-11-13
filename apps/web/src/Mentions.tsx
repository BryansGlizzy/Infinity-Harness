import { createContext, useContext, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { Mention } from '@ih/core';
import { matchMentions, mentionAt } from './mentionText.ts';

/** The projects of other swarms that can be named after an @. Provided once by the app. */
export const MentionsContext = createContext<Mention[]>([]);

interface Props {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel: string;
  multiline?: boolean;
  rows?: number;
  className?: string;
  /** Ctrl or Cmd with Enter. */
  onSubmit?: () => void;
}

/**
 * A text box that completes `@swarm/project` as you type: press @ and the projects other swarms share are offered
 * (arrow keys and Enter or Tab to pick, Esc to dismiss). A name that is typed in full is attached by the daemon when the
 * prompt is sent, whatever client sent it.
 */
export function MentionInput({ value, onChange, placeholder, ariaLabel, multiline, rows, className, onSubmit }: Props) {
  const all = useContext(MentionsContext);
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const [index, setIndex] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null);

  const at = useMemo(() => mentionAt(value, caret), [value, caret]);
  const candidates = useMemo(() => (at && all.length ? matchMentions(all, at.query) : []), [at, all]);
  const open = candidates.length > 0 && dismissed !== at?.start;
  useEffect(() => setIndex(0), [at?.query]);

  function pick(m: Mention) {
    if (!at) return;
    const next = `${value.slice(0, at.start)}${m.token} ${value.slice(caret)}`;
    onChange(next);
    const pos = at.start + m.token.length + 1;
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(pos, pos);
      setCaret(pos);
    });
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && onSubmit) {
      e.preventDefault();
      onSubmit();
      return;
    }
    if (!open) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setIndex((i) => (e.key === 'ArrowDown' ? (i + 1) % candidates.length : (i - 1 + candidates.length) % candidates.length));
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      pick(candidates[index]!);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setDismissed(at?.start ?? null);
    }
  }

  const common = {
    ref,
    value,
    placeholder,
    'aria-label': ariaLabel,
    'aria-autocomplete': 'list' as const,
    'aria-expanded': open,
    className,
    onChange: (e: { target: { value: string; selectionStart: number | null } }) => {
      onChange(e.target.value);
      setCaret(e.target.selectionStart ?? e.target.value.length);
      setDismissed(null);
    },
    onKeyDown,
    onKeyUp: () => setCaret(ref.current?.selectionStart ?? 0),
    onClick: () => setCaret(ref.current?.selectionStart ?? 0),
  };

  return (
    <div className="mention-wrap">
      {multiline ? <textarea {...common} rows={rows ?? 3} /> : <input {...common} />}
      {open && (
        <ul className="mention-list" role="listbox" aria-label="Projects of other swarms">
          {candidates.map((m, i) => (
            <li key={m.token} role="option" aria-selected={i === index} className={i === index ? 'on' : ''} onMouseDown={(e) => (e.preventDefault(), pick(m))} onMouseEnter={() => setIndex(i)}>
              <span className="mention-token">{m.token}</span>
              <span className="muted small"> {m.swarm}: {m.oneLine || m.project}</span>
              {m.takesRequests && <span className="badge">takes requests</span>}
            </li>
          ))}
          <li className="mention-hint muted small" aria-hidden="true">Shared by other swarms. Its card goes to the planner as data; asking them for something is a request you approve.</li>
        </ul>
      )}
    </div>
  );
}
