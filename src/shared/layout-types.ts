export type PaneId = string;

export interface LayoutLeaf {
  type: 'leaf';
  id: PaneId;
  sessionId: string | null;
}

export interface LayoutSplit {
  type: 'split';
  id: PaneId;
  direction: 'horizontal' | 'vertical'; // horizontal = side-by-side, vertical = stacked
  ratio: number; // 0-1, first child's share
  children: [LayoutNode, LayoutNode];
}

export type LayoutNode = LayoutLeaf | LayoutSplit;

export interface LayoutState {
  root: LayoutNode | null;
  focusedPaneId: PaneId | null;
  maximizedPaneId: PaneId | null;
  maxPanes: number;
}

export type DropZone =
  | 'left'
  | 'right'
  | 'top'
  | 'bottom'
  | 'center'
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right';
