import type { LayoutNode } from '../../shared/layout-types';
import type { SessionInfo } from '../../shared/types';
import type { TerminalManagerAPI } from '../hooks/useTerminalManager';
import type { LayoutAction } from '../hooks/useLayoutState';
import { TerminalPane } from './TerminalPane';

interface SplitLayoutProps {
  node: LayoutNode;
  layoutDispatch: React.Dispatch<LayoutAction>;
  termManager: TerminalManagerAPI;
  sessions: SessionInfo[];
  isDragging: boolean;
  draggingPaneId: string | null;
  onDragStateChange: (dragging: boolean, sourcePaneId?: string) => void;
  focusedPaneId: string | null;
  maximizedPaneId: string | null;
  enablePaneSplitting: boolean;
  currentLeafCount: number;
  maxPanes: number;
}

export function SplitLayout({
  node,
  layoutDispatch,
  termManager,
  sessions,
  isDragging,
  draggingPaneId,
  onDragStateChange,
  focusedPaneId,
  maximizedPaneId,
  enablePaneSplitting,
  currentLeafCount,
  maxPanes,
}: SplitLayoutProps) {
  if (node.type === 'leaf') {
    const session = node.sessionId ? sessions.find(s => s.id === node.sessionId) : undefined;
    return (
      <TerminalPane
        paneId={node.id}
        sessionId={node.sessionId}
        session={session}
        isFocused={focusedPaneId === node.id}
        isDragging={isDragging}
        draggingPaneId={draggingPaneId}
        onDragStateChange={onDragStateChange}
        layoutDispatch={layoutDispatch}
        termManager={termManager}
        enablePaneSplitting={enablePaneSplitting}
        currentLeafCount={currentLeafCount}
        maxPanes={maxPanes}
      />
    );
  }

  return (
    <SplitContainer
      node={node}
      layoutDispatch={layoutDispatch}
      termManager={termManager}
      sessions={sessions}
      isDragging={isDragging}
      draggingPaneId={draggingPaneId}
      onDragStateChange={onDragStateChange}
      focusedPaneId={focusedPaneId}
      maximizedPaneId={maximizedPaneId}
      enablePaneSplitting={enablePaneSplitting}
      currentLeafCount={currentLeafCount}
      maxPanes={maxPanes}
    />
  );
}

interface SplitContainerProps {
  node: LayoutNode & { type: 'split' };
  layoutDispatch: React.Dispatch<LayoutAction>;
  termManager: TerminalManagerAPI;
  sessions: SessionInfo[];
  isDragging: boolean;
  draggingPaneId: string | null;
  onDragStateChange: (dragging: boolean, sourcePaneId?: string) => void;
  focusedPaneId: string | null;
  maximizedPaneId: string | null;
  enablePaneSplitting: boolean;
  currentLeafCount: number;
  maxPanes: number;
}

function SplitContainer({
  node,
  layoutDispatch,
  termManager,
  sessions,
  isDragging,
  draggingPaneId,
  onDragStateChange,
  focusedPaneId,
  maximizedPaneId,
  enablePaneSplitting,
  currentLeafCount,
  maxPanes,
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
          isDragging={isDragging}
          draggingPaneId={draggingPaneId}
          onDragStateChange={onDragStateChange}
          focusedPaneId={focusedPaneId}
          maximizedPaneId={maximizedPaneId}
          enablePaneSplitting={enablePaneSplitting}
          currentLeafCount={currentLeafCount}
          maxPanes={maxPanes}
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
          isDragging={isDragging}
          draggingPaneId={draggingPaneId}
          onDragStateChange={onDragStateChange}
          focusedPaneId={focusedPaneId}
          maximizedPaneId={maximizedPaneId}
          enablePaneSplitting={enablePaneSplitting}
          currentLeafCount={currentLeafCount}
          maxPanes={maxPanes}
        />
      </div>
    </div>
  );
}
