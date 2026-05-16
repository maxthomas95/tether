import React from 'react';

interface HelpAnchorProps {
  /** Docs page id (e.g. "settings", "sessions", "vault"). */
  page: string;
  /** Optional anchor id within the page (heading slug). */
  anchor?: string;
  /** Plain-language label shown in the title attribute. */
  label?: string;
  /** Optional className for layout overrides. */
  className?: string;
}

/**
 * Small `(?)` icon that opens the docs window scrolled to the given page/anchor.
 * Used in dialog section headers and sidebar blocks for in-context help.
 */
export function HelpAnchor({ page, anchor, label, className }: Readonly<HelpAnchorProps>) {
  const title = label
    ? `Open docs: ${label}`
    : `Open documentation for ${page}${anchor ? ` (${anchor})` : ''}`;

  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    void window.electronAPI.docs.open({ page, anchor });
  };

  return (
    <button
      type="button"
      className={`help-anchor${className ? ` ${className}` : ''}`}
      onClick={handleClick}
      title={title}
      aria-label={title}
    >
      ?
    </button>
  );
}
