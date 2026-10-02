import { useCallback, useEffect, useRef, useState } from 'react';
import type { ISearchResultChangeEvent } from '@xterm/addon-search';
import { Icon } from './Icon';

interface TerminalSearchBarProps {
  paneId: string;
  focusRequest: number;
  onSearch: (paneId: string, term: string, options?: { caseSensitive?: boolean; wholeWord?: boolean; previous?: boolean; incremental?: boolean }) => boolean;
  onResults: (paneId: string, listener: (event: ISearchResultChangeEvent) => void) => () => void;
  onClose: () => void;
}

export function TerminalSearchBar({ paneId, focusRequest, onSearch, onResults, onClose }: TerminalSearchBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [term, setTerm] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [hasResult, setHasResult] = useState<boolean | null>(null);
  const [result, setResult] = useState<ISearchResultChangeEvent | null>(null);

  const runSearch = useCallback((nextTerm: string, options?: { previous?: boolean; incremental?: boolean }) => {
    if (!nextTerm) {
      setHasResult(null);
      setResult(null);
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
  }, [focusRequest, paneId]);

  useEffect(() => {
    runSearch(term, { incremental: true });
  }, [caseSensitive, runSearch, term, wholeWord]);

  useEffect(() => onResults(paneId, setResult), [onResults, paneId]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      runSearch(term, { previous: e.shiftKey });
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }, [onClose, runSearch, term]);

  const status = result && result.resultCount > 0 && result.resultIndex >= 0
    ? `${result.resultIndex + 1}/${result.resultCount}`
    : result && result.resultCount > 0 ? `${result.resultCount} matches`
    : hasResult === false ? 'No results' : '';

  return (
    <div className="terminal-search-bar" role="search" aria-label="Find in terminal" onMouseDown={e => e.stopPropagation()} onKeyDown={handleKeyDown}>
      <Icon name="search" size={14} />
      <input
        ref={inputRef}
        className="terminal-search-input"
        value={term}
        placeholder="Find in terminal"
        aria-label="Find in terminal"
        onChange={e => setTerm(e.target.value)}
      />
      <span className={`terminal-search-status ${hasResult === false ? 'terminal-search-status--empty' : ''}`} aria-live="polite">
        {status}
      </span>
      <button type="button" className="terminal-search-toggle" aria-label="Match case" aria-pressed={caseSensitive} title="Match case" onClick={() => setCaseSensitive(v => !v)}>
        Aa
      </button>
      <button type="button" className="terminal-search-toggle" aria-label="Match whole word" aria-pressed={wholeWord} title="Whole word" onClick={() => setWholeWord(v => !v)}>
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
