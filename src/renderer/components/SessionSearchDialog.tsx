import { useEffect, useMemo, useRef, useState } from 'react';
import type { SessionInfo, EnvironmentInfo, SessionState } from '../../shared/types';
import { CliToolBadge } from './CliToolBadge';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { onKeyActivate, stopPropagationOnKey } from '../utils/a11y';
import { abbreviatePath } from '../utils/paths';
import { searchSessions, type SearchableSession, type SearchHit } from '../utils/session-search';

interface SessionSearchDialogProps {
  isOpen: boolean;
  sessions: SessionInfo[];
  environments: EnvironmentInfo[];
  onClose: () => void;
  /** Activate (focus / bring forward) the chosen session. Reuses the same
   *  selection path the sidebar uses — see App.tsx handleActivateFromSearch. */
  onActivate: (sessionId: string) => void;
}

/** Map a session state to the status-dot modifier class used in the sidebar. */
function statusDotClass(state: SessionState): string {
  switch (state) {
    case 'running':
    case 'starting':
      return 'running';
    case 'waiting':
      return 'waiting';
    case 'idle':
      return 'idle';
    case 'stopped':
    case 'dead':
      return 'dead';
    default:
      return 'idle';
  }
}

/**
 * Ctrl+P quick switcher. Compact VS-Code-style overlay: a query input on top
 * and a roving-highlight result list below. Arrow keys move the selection,
 * Enter activates, Escape closes, click activates. Matching is delegated to the
 * pure functions in utils/session-search.ts (regex-free fuzzy subsequence).
 */
export function SessionSearchDialog({ isOpen, sessions, environments, onClose, onActivate }: Readonly<SessionSearchDialogProps>) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);

  useFocusTrap(dialogRef, isOpen);

  const envNameById = useMemo(
    () => new Map(environments.map(env => [env.id, env.name])),
    [environments],
  );

  // Reduce live sessions to the searchable shape. Local sessions may have a
  // null environmentId — fall back to a friendly "Local" so the env field is
  // still searchable.
  const searchable = useMemo<Array<SearchableSession & { info: SessionInfo }>>(
    () => sessions.map(s => ({
      info: s,
      id: s.id,
      label: s.label,
      workingDir: s.workingDir,
      environmentName: (s.environmentId ? envNameById.get(s.environmentId) : undefined) ?? 'Local',
      cliToolId: s.cliTool ?? 'claude',
    })),
    [sessions, envNameById],
  );

  const hits = useMemo<Array<SearchHit<SearchableSession & { info: SessionInfo }>>>(
    () => searchSessions(query, searchable),
    [query, searchable],
  );

  // Reset query + selection each time the dialog opens, and re-focus the input.
  useEffect(() => {
    if (!isOpen) return;
    setQuery('');
    setSelectedIndex(0);
    // useFocusTrap won't steal focus from an already-focused element; focusing
    // the input here also gives us a known initial selection target.
    inputRef.current?.focus();
  }, [isOpen]);

  // Keep the selected index in range as results shrink/grow.
  useEffect(() => {
    setSelectedIndex(prev => {
      if (hits.length === 0) return 0;
      return Math.min(prev, hits.length - 1);
    });
  }, [hits.length]);

  // Scroll the active option into view as the roving highlight moves.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const active = list.querySelector<HTMLElement>('[data-selected="true"]');
    active?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex, hits.length]);

  if (!isOpen) return null;

  const activate = (sessionId: string) => {
    onActivate(sessionId);
    onClose();
  };

  const handleInputKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (hits.length > 0) setSelectedIndex(i => (i + 1) % hits.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (hits.length > 0) setSelectedIndex(i => (i - 1 + hits.length) % hits.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const chosen = hits[selectedIndex];
      if (chosen) activate(chosen.session.id);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  const activeOptionId = hits[selectedIndex]
    ? `session-search-option-${hits[selectedIndex].session.id}`
    : undefined;

  return (
    <div
      className="dialog-overlay"
      onClick={onClose}
      onKeyDown={onKeyActivate(onClose)}
      role="button"
      tabIndex={-1}
    >
      <div
        ref={dialogRef}
        className="dialog session-search-dialog"
        onClick={e => e.stopPropagation()}
        onKeyDown={stopPropagationOnKey}
        role="dialog"
        aria-modal="true"
        aria-label="Find session"
        tabIndex={-1}
      >
        <div className="session-search-input-row">
          <input
            ref={inputRef}
            className="session-search-input"
            type="text"
            value={query}
            placeholder="Search sessions by label, directory, environment, or CLI…"
            aria-label="Search sessions"
            aria-controls="session-search-list"
            aria-activedescendant={activeOptionId}
            autoComplete="off"
            spellCheck={false}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleInputKeyDown}
          />
        </div>
        <ul
          ref={listRef}
          id="session-search-list"
          className="session-search-list"
          role="listbox"
          aria-label="Matching sessions"
        >
          {hits.length === 0 ? (
            <li className="session-search-empty" role="presentation">
              {sessions.length === 0 ? 'No sessions open.' : 'No matching sessions.'}
            </li>
          ) : (
            hits.map((hit, index) => {
              const s = hit.session.info;
              const selected = index === selectedIndex;
              return (
                <li
                  key={s.id}
                  id={`session-search-option-${s.id}`}
                  className={`session-search-option ${selected ? 'session-search-option--selected' : ''}`}
                  role="option"
                  aria-selected={selected}
                  data-selected={selected}
                  onClick={() => activate(s.id)}
                  onMouseMove={() => setSelectedIndex(index)}
                >
                  <span className={`status-dot status-dot--${statusDotClass(s.state)}`} aria-hidden="true" />
                  <span className="session-search-label">{s.label}</span>
                  <CliToolBadge session={s} />
                  <span className="session-search-dir">{abbreviatePath(s.workingDir)}</span>
                </li>
              );
            })
          )}
        </ul>
      </div>
    </div>
  );
}
