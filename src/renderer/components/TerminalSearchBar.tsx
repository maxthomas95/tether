import { useCallback, useEffect, useRef, useState } from 'react';
import type { ISearchResultChangeEvent } from '@xterm/addon-search';
import { Icon } from './Icon';

interface TerminalSearchBarProps {
  paneId: string;
  focusRequest: number;
  onSearch: (paneId: string, term: string, options?: SearchOptions) => boolean;
  onResults: (paneId: string, listener: (event: ISearchResultChangeEvent) => void) => () => void;
  onClose: () => void;
}

type SearchOptions = { caseSensitive?: boolean; wholeWord?: boolean; previous?: boolean; incremental?: boolean };

interface SearchButtonProps {
  className: string;
  title: string;
  ariaLabel: string;
  onClick: () => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  children: React.ReactNode;
  pressed?: boolean;
}

function formatSearchStatus(result: ISearchResultChangeEvent | null, hasResult: boolean | null): string {
  if (result && result.resultCount > 0 && result.resultIndex >= 0) return `${result.resultIndex + 1}/${result.resultCount}`;
  if (result && result.resultCount > 0) return `${result.resultCount} matches`;
  return hasResult === false ? 'No results' : '';
}

function SearchButton({ className, title, ariaLabel, onClick, onKeyDown, children, pressed }: Readonly<SearchButtonProps>) {
  return (
    <button
      type="button"
      className={className}
      title={title}
      aria-label={ariaLabel}
      aria-pressed={pressed}
      onMouseDown={e => e.stopPropagation()}
      onKeyDown={onKeyDown}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function TerminalSearchBar({ paneId, focusRequest, onSearch, onResults, onClose }: Readonly<TerminalSearchBarProps>) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [term, setTerm] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [hasResult, setHasResult] = useState<boolean | null>(null);
  const [result, setResult] = useState<ISearchResultChangeEvent | null>(null);

  const runSearch = useCallback((nextTerm: string, options?: Pick<SearchOptions, 'previous' | 'incremental'>) => {
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

  const handleControlKeyDown = useCallback((e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      runSearch(term, { previous: e.shiftKey });
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }, [onClose, runSearch, term]);

  const status = formatSearchStatus(result, hasResult);

  return (
    <div className="terminal-search-bar" role="search" aria-label="Find in terminal">
      <Icon name="search" size={14} />
      <input
        ref={inputRef}
        className="terminal-search-input"
        value={term}
        placeholder="Find in terminal"
        aria-label="Find in terminal"
        onMouseDown={e => e.stopPropagation()}
        onKeyDown={handleControlKeyDown}
        onChange={e => setTerm(e.target.value)}
      />
      <span className={`terminal-search-status ${hasResult === false ? 'terminal-search-status--empty' : ''}`} aria-live="polite">
        {status}
      </span>
      <SearchButton className="terminal-search-toggle" ariaLabel="Match case" title="Match case" pressed={caseSensitive} onKeyDown={handleControlKeyDown} onClick={() => setCaseSensitive(v => !v)}>
        Aa
      </SearchButton>
      <SearchButton className="terminal-search-toggle" ariaLabel="Match whole word" title="Whole word" pressed={wholeWord} onKeyDown={handleControlKeyDown} onClick={() => setWholeWord(v => !v)}>
        W
      </SearchButton>
      <SearchButton className="terminal-search-button" ariaLabel="Previous match" title="Previous match" onKeyDown={handleControlKeyDown} onClick={() => runSearch(term, { previous: true })}>
        Prev
      </SearchButton>
      <SearchButton className="terminal-search-button" ariaLabel="Next match" title="Next match" onKeyDown={handleControlKeyDown} onClick={() => runSearch(term)}>
        Next
      </SearchButton>
      <SearchButton className="terminal-search-button" ariaLabel="Close terminal search" title="Close terminal search" onKeyDown={handleControlKeyDown} onClick={onClose}>
        <Icon name="close" size={14} />
      </SearchButton>
    </div>
  );
}
