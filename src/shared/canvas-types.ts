export interface CanvasRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Session indexes refer to the sessions saved in the same workspace write. */
export interface SavedCanvas {
  panels: Array<CanvasRect & { sessionIndex: number; z: number }>;
  viewport: { x: number; y: number };
  focusedSessionIndex: number | null;
}
