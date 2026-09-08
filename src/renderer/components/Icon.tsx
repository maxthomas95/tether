import type { CSSProperties } from 'react';

const paths = {
  plus: 'M12 5v14M5 12h14',
  search: 'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  settings: 'M4 7h16M4 17h16M9 4v6M15 14v6',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  close: 'M6 6l12 12M18 6 6 18',
  maximize: 'M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5',
  restore: 'M8 8h13v13H8zM3 16V3h13',
  broadcast: 'M3 7h16m-4-4 4 4-4 4M3 17h16m-4-4 4 4-4 4',
  folder: 'M3 7V5h6l2 2h10v13H3z',
  chevron: 'm9 5 7 7-7 7',
} as const;

/** Shared chrome icons; labels belong to the control, not the decorative SVG. */
export function Icon({ name, size = 16, style }: { name: keyof typeof paths; size?: number; style?: CSSProperties }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={name === 'more' ? 3 : 1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" style={style}>
      <path d={paths[name]} />
    </svg>
  );
}
