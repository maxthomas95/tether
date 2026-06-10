import type { DetailedHTMLProps, HTMLAttributes } from 'react';

/**
 * JSX typing for Electron's <webview> tag, used by the J.O.B.S. Office pane.
 * Only the attributes we actually pass are declared.
 */
declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      webview: DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & {
        src?: string;
        partition?: string;
      };
    }
  }
}
