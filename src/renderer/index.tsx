import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

// Self-hosted fonts (Phase 1 UX refresh). JetBrains Mono is a variable font;
// IBM Plex Sans ships per-weight CSS subpaths. Load before any styles so
// @font-face declarations are registered before the first paint.
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-sans/700.css';
import '@fontsource-variable/jetbrains-mono';
// Terminal alternatives are bundled so local and remote sessions use the
// same font without requiring an OS install or fetching from a CDN.
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/400-italic.css';
import '@fontsource/ibm-plex-mono/700.css';
import '@fontsource/ibm-plex-mono/700-italic.css';
import './styles/terminal-fonts.css';
// Optional UI font alternates exposed via Settings → Sessions.
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/atkinson-hyperlegible/400.css';
import '@fontsource/atkinson-hyperlegible/700.css';

import './styles/tokens.css';
import './styles/global.css';
import './styles/terminal-search.css';

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
