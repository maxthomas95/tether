import { useRef, useCallback } from 'react';
import type { LayoutNode } from '../../shared/layout-types';
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
  onDragStateChange: (dragging: boolean) => void;
  focusedPaneId: string | null;
  maximizedPaneId: string | null;
}

export function SplitLayout({
  node,
  layoutDispatch,
  termManager,
  sessions,
  isDragging,
  onDragStateChange,
  focusedPaneId,
  maximizedPaneId,
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
        onDragStateChange={onDragStateChange}
        layoutDispatch={layoutDispatch}
        termManager={termManager}
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
      onDragStateChange={onDragStateChange}
      focusedPaneId={focusedPaneId}
      maximizedPaneId={maximizedPaneId}
    />
  );
}

interface SplitContainerProps {
  node: LayoutNode & { type: 'split' };
  layoutDispatch: React.Dispatch<LayoutAction>;
  termManager: TerminalManagerAPI;
  sessions: SessionInfo[];
  isDragging: boolean;
  onDragStateChange: (dragging: boolean) => void;
  focusedPaneId: string | null;
  maximizedPaneId: string | null;
}

function SplitContainer({
  node,
  layoutDispatch,
  termManager,
  sessions,
  isDragging,
  onDragStateChange,
  focusedPaneId,
  maximizedPaneId,
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
          onDragStateChange={onDragStateChange}
          focusedPaneId={focusedPaneId}
          maximizedPaneId={maximizedPaneId}
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
          onDragStateChange={onDragStateChange}
          focusedPaneId={focusedPaneId}
          maximizedPaneId={maximizedPaneId}
        />
      </div>
    </div>
  );
}
