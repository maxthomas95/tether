import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';

interface TerminalSearchBarProps {
  paneId: string;
  onSearch: (paneId: string, term: string, options?: { caseSensitive?: boolean; wholeWord?: boolean; previous?: boolean; incremental?: boolean }) => boolean;
  onClose: () => void;
}

export function TerminalSearchBar({ paneId, onSearch, onClose }: TerminalSearchBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [term, setTerm] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [hasResult, setHasResult] = useState<boolean | null>(null);

  const runSearch = useCallback((nextTerm: string, options?: { previous?: boolean; incremental?: boolean }) => {
    if (!nextTerm) {
      setHasResult(null);
      onSearch(paneId, '', { caseSensitive, wholeWord, incremental: true });
      return false;
    }
    const found = onSearch(paneId, nextTerm, {
      caseSensitive,
      wholeWord,
      previous: options?.previous,
      incremental: options?.incremental,
    });
    setHasResult(found);
    return found;
  }, [caseSensitive, onSearch, paneId, wholeWord]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, [paneId]);

  useEffect(() => {
    runSearch(term, { incremental: true });
  }, [caseSensitive, runSearch, term, wholeWord]);

  return (
    <div className="terminal-search-bar" role="search" aria-label="Find in terminal" onMouseDown={e => e.stopPropagation()}>
      <Icon name="search" size={14} />
      <input
        ref={inputRef}
        className="terminal-search-input"
        value={term}
        placeholder="Find in terminal"
        aria-label="Find in terminal"
        onChange={e => setTerm(e.target.value)}
        onKeyDown={e => {
          e.stopPropagation();
          if (e.key === 'Enter') {
            e.preventDefault();
            runSearch(term, { previous: e.shiftKey });
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
          }
        }}
      />
      <span className={`terminal-search-status ${hasResult === false ? 'terminal-search-status--empty' : ''}`} aria-live="polite">
        {hasResult === false ? 'No results' : ''}
      </span>
      <button type="button" className="terminal-search-toggle" aria-pressed={caseSensitive} title="Match case" onClick={() => setCaseSensitive(v => !v)}>
        Aa
      </button>
      <button type="button" className="terminal-search-toggle" aria-pressed={wholeWord} title="Whole word" onClick={() => setWholeWord(v => !v)}>
        W
      </button>
      <button type="button" className="terminal-search-button" title="Previous match" aria-label="Previous match" onClick={() => runSearch(term, { previous: true })}>
        Prev
      </button>
      <button type="button" className="terminal-search-button" title="Next match" aria-label="Next match" onClick={() => runSearch(term)}>
        Next
      </button>
      <button type="button" className="terminal-search-button" title="Close terminal search" aria-label="Close terminal search" onClick={onClose}>
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}
