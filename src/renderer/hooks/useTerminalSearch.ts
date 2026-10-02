import { useCallback, useEffect, useState } from 'react';

export interface UseTerminalSearchOptions {
  focusedPaneId: string | null;
  modalOpen: boolean;
  visiblePaneIds: ReadonlySet<string>;
  clearFindInPane: (paneId: string) => void;
  focusPaneForSearch: (paneId: string) => void;
}

export interface TerminalSearchState {
  searchPaneId: string | null;
  searchFocusRequest: number;
  openSearch: (paneId?: string) => void;
  closeSearch: (paneId: string) => void;
}

export function useTerminalSearch({
  focusedPaneId,
  modalOpen,
  visiblePaneIds,
  clearFindInPane,
  focusPaneForSearch,
}: UseTerminalSearchOptions): TerminalSearchState {
  const [searchPaneId, setSearchPaneId] = useState<string | null>(null);
  const [searchFocusRequest, setSearchFocusRequest] = useState(0);

  const openSearch = useCallback((paneId?: string) => {
    if (modalOpen) return;
    const nextPaneId = paneId ?? focusedPaneId;
    if (!nextPaneId) return;
    focusPaneForSearch(nextPaneId);
    setSearchPaneId(prev => {
      if (prev && prev !== nextPaneId) clearFindInPane(prev);
      return nextPaneId;
    });
    setSearchFocusRequest(value => value + 1);
  }, [clearFindInPane, focusPaneForSearch, focusedPaneId, modalOpen]);

  const closeSearch = useCallback((paneId: string) => {
    setSearchPaneId(prev => prev === paneId ? null : prev);
  }, []);

  useEffect(() => {
    if (!searchPaneId || visiblePaneIds.has(searchPaneId)) return;
    clearFindInPane(searchPaneId);
    setSearchPaneId(null);
  }, [clearFindInPane, searchPaneId, visiblePaneIds]);

  return { searchPaneId, searchFocusRequest, openSearch, closeSearch };
}
