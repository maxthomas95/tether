import type { LayoutNode } from '../../shared/layout-types';
import type { EnvironmentInfo, SessionInfo } from '../../shared/types';
import type { TerminalManagerAPI } from '../hooks/useTerminalManager';
import type { LayoutAction } from '../hooks/useLayoutState';
import { TerminalPane } from './TerminalPane';

interface SplitLayoutProps {
  node: LayoutNode;
  layoutDispatch: React.Dispatch<LayoutAction>;
  termManager: TerminalManagerAPI;
  sessions: SessionInfo[];
  environments: EnvironmentInfo[];
  onChooseSession: (paneId: string) => void;
  isDragging: boolean;
  draggingPaneId: string | null;
  onDragStateChange: (dragging: boolean, sourcePaneId?: string) => void;
  focusedPaneId: string | null;
  maximizedPaneId: string | null;
  enablePaneSplitting: boolean;
  currentLeafCount: number;
  maxPanes: number;
  defaultFontSize: number;
  onFontSizeDelta: (sessionId: string, delta: number) => void;
  broadcastPaneIds: ReadonlySet<string>;
  broadcastActive: boolean;
  onToggleBroadcastTarget: (paneId: string) => void;
  searchPaneId: string | null;
  searchFocusRequest: number;
  onOpenTerminalSearch: (paneId: string) => void;
  onCloseTerminalSearch: (paneId: string) => void;
  onRestartInPane?: (paneId: string, sessionId: string) => void;
}

export function SplitLayout({
  node,
  layoutDispatch,
  termManager,
  sessions,
  environments,
  onChooseSession,
  isDragging,
  draggingPaneId,
  onDragStateChange,
  focusedPaneId,
  maximizedPaneId,
  enablePaneSplitting,
  currentLeafCount,
  maxPanes,
  defaultFontSize,
  onFontSizeDelta,
  broadcastPaneIds,
  broadcastActive,
  onToggleBroadcastTarget,
  searchPaneId,
  searchFocusRequest,
  onOpenTerminalSearch,
  onCloseTerminalSearch,
  onRestartInPane,
}: SplitLayoutProps) {
  if (node.type === 'leaf') {
    const session = node.sessionId ? sessions.find(s => s.id === node.sessionId) : undefined;
    return (
      <TerminalPane
        paneId={node.id}
        sessionId={node.sessionId}
        session={session}
        environment={environments.find(e => e.id === session?.environmentId) ?? (!session?.environmentId ? environments.find(e => e.type === 'local') : undefined)}
        isMaximized={maximizedPaneId === node.id}
        onChooseSession={() => onChooseSession(node.id)}
        isFocused={focusedPaneId === node.id}
        isDragging={isDragging}
        draggingPaneId={draggingPaneId}
        onDragStateChange={onDragStateChange}
        layoutDispatch={layoutDispatch}
        termManager={termManager}
        enablePaneSplitting={enablePaneSplitting}
        currentLeafCount={currentLeafCount}
        maxPanes={maxPanes}
        defaultFontSize={defaultFontSize}
        onFontSizeDelta={onFontSizeDelta}
        isBroadcastTarget={broadcastPaneIds.has(node.id)}
        isBroadcastActive={broadcastActive}
        onToggleBroadcastTarget={onToggleBroadcastTarget}
        isSearchOpen={searchPaneId === node.id}
        searchFocusRequest={searchPaneId === node.id ? searchFocusRequest : 0}
        onOpenSearch={onOpenTerminalSearch}
        onCloseSearch={onCloseTerminalSearch}
        onRestartInPane={onRestartInPane}
      />
    );
  }

  return (
    <SplitContainer
      node={node}
      layoutDispatch={layoutDispatch}
      termManager={termManager}
      sessions={sessions}
      environments={environments}
      onChooseSession={onChooseSession}
      isDragging={isDragging}
      draggingPaneId={draggingPaneId}
      onDragStateChange={onDragStateChange}
      focusedPaneId={focusedPaneId}
      maximizedPaneId={maximizedPaneId}
      enablePaneSplitting={enablePaneSplitting}
      currentLeafCount={currentLeafCount}
      maxPanes={maxPanes}
      defaultFontSize={defaultFontSize}
      onFontSizeDelta={onFontSizeDelta}
      broadcastPaneIds={broadcastPaneIds}
      broadcastActive={broadcastActive}
      onToggleBroadcastTarget={onToggleBroadcastTarget}
      searchPaneId={searchPaneId}
      searchFocusRequest={searchFocusRequest}
      onOpenTerminalSearch={onOpenTerminalSearch}
      onCloseTerminalSearch={onCloseTerminalSearch}
      onRestartInPane={onRestartInPane}
    />
  );
}

interface SplitContainerProps {
  node: LayoutNode & { type: 'split' };
  layoutDispatch: React.Dispatch<LayoutAction>;
  termManager: TerminalManagerAPI;
  sessions: SessionInfo[];
  environments: EnvironmentInfo[];
  onChooseSession: (paneId: string) => void;
  isDragging: boolean;
  draggingPaneId: string | null;
  onDragStateChange: (dragging: boolean, sourcePaneId?: string) => void;
  focusedPaneId: string | null;
  maximizedPaneId: string | null;
  enablePaneSplitting: boolean;
  currentLeafCount: number;
  maxPanes: number;
  defaultFontSize: number;
  onFontSizeDelta: (sessionId: string, delta: number) => void;
  broadcastPaneIds: ReadonlySet<string>;
  broadcastActive: boolean;
  onToggleBroadcastTarget: (paneId: string) => void;
  searchPaneId: string | null;
  searchFocusRequest: number;
  onOpenTerminalSearch: (paneId: string) => void;
  onCloseTerminalSearch: (paneId: string) => void;
  onRestartInPane?: (paneId: string, sessionId: string) => void;
}

function SplitContainer({
  node,
  layoutDispatch,
  termManager,
  sessions,
  environments,
  onChooseSession,
  isDragging,
  draggingPaneId,
  onDragStateChange,
  focusedPaneId,
  maximizedPaneId,
  enablePaneSplitting,
  currentLeafCount,
  maxPanes,
  defaultFontSize,
  onFontSizeDelta,
  broadcastPaneIds,
  broadcastActive,
  onToggleBroadcastTarget,
  searchPaneId,
  searchFocusRequest,
  onOpenTerminalSearch,
  onCloseTerminalSearch,
  onRestartInPane,
}: SplitContainerProps) {
  const [first, second] = node.children;

  return (
    <div
      className={`split-container split-container--${node.direction}`}
    >
      <div
        className="split-child"
        style={{ flex: 0.5 }}
      >
        <SplitLayout
          node={first}
          layoutDispatch={layoutDispatch}
          termManager={termManager}
          sessions={sessions}
          environments={environments}
          onChooseSession={onChooseSession}
          isDragging={isDragging}
          draggingPaneId={draggingPaneId}
          onDragStateChange={onDragStateChange}
          focusedPaneId={focusedPaneId}
          maximizedPaneId={maximizedPaneId}
          enablePaneSplitting={enablePaneSplitting}
          currentLeafCount={currentLeafCount}
          maxPanes={maxPanes}
          defaultFontSize={defaultFontSize}
          onFontSizeDelta={onFontSizeDelta}
          broadcastPaneIds={broadcastPaneIds}
          broadcastActive={broadcastActive}
          onToggleBroadcastTarget={onToggleBroadcastTarget}
          searchPaneId={searchPaneId}
          searchFocusRequest={searchFocusRequest}
          onOpenTerminalSearch={onOpenTerminalSearch}
          onCloseTerminalSearch={onCloseTerminalSearch}
          onRestartInPane={onRestartInPane}
        />
      </div>
      <div className={`split-separator split-separator--${node.direction}`} />
      <div
        className="split-child"
        style={{ flex: 0.5 }}
      >
        <SplitLayout
          node={second}
          layoutDispatch={layoutDispatch}
          termManager={termManager}
          sessions={sessions}
          environments={environments}
          onChooseSession={onChooseSession}
          isDragging={isDragging}
          draggingPaneId={draggingPaneId}
          onDragStateChange={onDragStateChange}
          focusedPaneId={focusedPaneId}
          maximizedPaneId={maximizedPaneId}
          enablePaneSplitting={enablePaneSplitting}
          currentLeafCount={currentLeafCount}
          maxPanes={maxPanes}
          defaultFontSize={defaultFontSize}
          onFontSizeDelta={onFontSizeDelta}
          broadcastPaneIds={broadcastPaneIds}
          broadcastActive={broadcastActive}
          onToggleBroadcastTarget={onToggleBroadcastTarget}
          searchPaneId={searchPaneId}
          searchFocusRequest={searchFocusRequest}
          onOpenTerminalSearch={onOpenTerminalSearch}
          onCloseTerminalSearch={onCloseTerminalSearch}
          onRestartInPane={onRestartInPane}
        />
      </div>
    </div>
  );
}
