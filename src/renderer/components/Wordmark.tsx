/*
 * Tether wordmark.
 *
 * Inline SVG so the letters and the bridging braid pick up the parent
 * `color` cascade via `currentColor`. Keeps the asset and React in
 * sync (the source of truth is `src/renderer/assets/wordmark.svg` —
 * this component mirrors that markup so we can tint it without an
 * extra <object> or mask trick). The splash loader in `index.html`
 * inlines the same paths directly for the same reason.
 *
 * The mark is decorative; pass an `aria-label` on the wrapping element
 * (e.g. the menubar) when it carries semantic weight.
 */

import type { CSSProperties } from 'react';

interface WordmarkProps {
  /** Rendered height in px. Width scales to maintain the aspect ratio. */
  height?: number;
  /** Optional className — typically used to override color via CSS. */
  className?: string;
  /** Optional inline style passthrough. */
  style?: CSSProperties;
  /** When true, the SVG is exposed as an image with the given title.
   *  When false (default), it's marked aria-hidden and the surrounding
   *  element should carry the accessible name. */
  title?: string;
}

const VIEW_W = 144;
const VIEW_H = 40;

export function Wordmark({ height = 18, className, style, title }: WordmarkProps) {
  const width = (VIEW_W / VIEW_H) * height;
  const ariaProps = title
    ? { role: 'img' as const, 'aria-label': title }
    : { 'aria-hidden': true };

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      width={width}
      height={height}
      fill="currentColor"
      className={className}
      style={style}
      {...ariaProps}
    >
      {title && <title>{title}</title>}
      {/* Letter group: "te" + braid + "her". Fixed advance so the
          braid lands centered between the t and h. */}
      <g
        fontFamily="'JetBrains Mono Variable','JetBrains Mono','Cascadia Code','Fira Code',Consolas,monospace"
        fontWeight={600}
        fontSize={32}
        letterSpacing={1.5}
        textAnchor="start"
        dominantBaseline="alphabetic"
      >
        <text x={0} y={30}>te</text>
        <text x={68} y={30}>her</text>
      </g>

      {/* Braid bridging the th — two strands cross twice, mirroring
          the rope twist in logo.png. */}
      <g transform="translate(46 4)" strokeLinejoin="round">
        <path
          d="M3 4 C 3 10 17 10 17 16 C 17 22 3 22 3 28"
          fill="none"
          stroke="currentColor"
          strokeWidth={3.5}
          opacity={0.45}
        />
        <path
          d="M17 4 C 17 10 3 10 3 16 C 3 22 17 22 17 28"
          fill="none"
          stroke="currentColor"
          strokeWidth={3.5}
        />
        {/* Crossover pinches — sell the weave at small render sizes. */}
        <path d="M10 9 l2 1.5 l-2 1.5 l-2 -1.5 z" />
        <path d="M10 22 l2 1.5 l-2 1.5 l-2 -1.5 z" />
      </g>
    </svg>
  );
}
