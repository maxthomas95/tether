import { useRef, useCallback } from 'react';
import type { LayoutNode, LayoutLeaf } from '../../shared/layout-types';
import type { SessionInfo } from '../../shared/types';
import type { TerminalManagerAPI } from '../hooks/useTerminalManager';
import type { LayoutAction } from '../hooks/useLayoutState';
import { TerminalPane } from './TerminalPane';
import { SplitDivider } from './SplitDivider';

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
}: SplitLayoutProps) {
  if (node.type === 'leaf') {
    const session = sessions.find(s => s.id === node.sessionId);
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
}: SplitContainerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  const handleRatioChange = useCallback((splitId: string, ratio: number) => {
    layoutDispatch({ type: 'UPDATE_RATIO', splitId, ratio });
  }, [layoutDispatch]);

  const [first, second] = node.children;

  return (
    <div
      ref={containerRef}
      className={`split-container split-container--${node.direction}`}
    >
      <div
        className="split-child"
        style={{ flex: node.ratio }}
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
        />
      </div>
      <SplitDivider
        direction={node.direction}
        splitId={node.id}
        onRatioChange={handleRatioChange}
        parentRef={containerRef}
      />
      <div
        className="split-child"
        style={{ flex: 1 - node.ratio }}
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
        />
      </div>
    </div>
  );
}
