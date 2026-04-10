import { marked } from 'marked';
import { LOADER_THEMES, type LoaderTheme } from '../shared/loader-themes';

import gettingStartedMd from '../docs/getting-started.md?raw';
import sessionsMd from '../docs/sessions.md?raw';
import environmentsMd from '../docs/environments.md?raw';
import keyboardShortcutsMd from '../docs/keyboard-shortcuts.md?raw';
import settingsMd from '../docs/settings.md?raw';

import './docs.css';

// Extended theme map for CSS variables beyond the loader-theme subset.
// Mirrors src/renderer/styles/themes.ts values.
const EXTENDED_THEMES: Record<string, {
  hover: string; active: string; header: string; textSecondary: string;
}> = {
  mocha:          { hover: '#45475a', active: '#585b70', header: '#313244', textSecondary: '#bac2de' },
  macchiato:      { hover: '#494d64', active: '#5b6078', header: '#363a4f', textSecondary: '#b8c0e0' },
  frappe:         { hover: '#51576d', active: '#626880', header: '#414559', textSecondary: '#b5bfe2' },
  latte:          { hover: '#bcc0cc', active: '#acb0be', header: '#ccd0da', textSecondary: '#5c5f77' },
  'default-dark': { hover: '#2a2d2e', active: '#37373d', header: '#3c3c3c', textSecondary: '#999999' },
};

interface DocPage {
  id: string;
  title: string;
  html: string;
}

const pages: DocPage[] = [
  { id: 'getting-started', title: 'Getting Started', html: marked.parse(gettingStartedMd) as string },
  { id: 'sessions',        title: 'Sessions',        html: marked.parse(sessionsMd) as string },
  { id: 'environments',    title: 'Environments',    html: marked.parse(environmentsMd) as string },
  { id: 'keyboard-shortcuts', title: 'Keyboard Shortcuts', html: marked.parse(keyboardShortcutsMd) as string },
  { id: 'settings',        title: 'Settings',        html: marked.parse(settingsMd) as string },
];

let currentPage = pages[0];

function applyTheme(themeName: string): void {
  const loader: LoaderTheme = LOADER_THEMES[themeName] || LOADER_THEMES.mocha;
  const ext = EXTENDED_THEMES[themeName] || EXTENDED_THEMES.mocha;
  const s = document.documentElement.style;

  s.setProperty('--bg-primary', loader.bg);
  s.setProperty('--bg-sidebar', loader.sidebar);
  s.setProperty('--text-primary', loader.text);
  s.setProperty('--text-muted', loader.muted);
  s.setProperty('--accent', loader.accent);
  s.setProperty('--border-color', loader.border);
  s.setProperty('--bg-hover', ext.hover);
  s.setProperty('--bg-active', ext.active);
  s.setProperty('--bg-header', ext.header);
  s.setProperty('--text-secondary', ext.textSecondary);
}

function navigateTo(pageId: string): void {
  const page = pages.find(p => p.id === pageId);
  if (page) {
    currentPage = page;
    render();
  }
}

function render(): void {
  const root = document.getElementById('docs-root')!;

  root.innerHTML = `
    <nav class="docs-nav">
      <div class="docs-nav-header">Documentation</div>
      ${pages.map(p => `
        <a href="#" class="docs-nav-item${p.id === currentPage.id ? ' docs-nav-item--active' : ''}"
           data-page="${p.id}">${p.title}</a>
      `).join('')}
      <div class="docs-nav-footer">
        <span class="docs-nav-footer-text">Tether Docs</span>
      </div>
    </nav>
    <main class="docs-main">
      <article class="docs-article">${currentPage.html}</article>
    </main>
  `;

  // Attach navigation click handlers
  root.querySelectorAll<HTMLAnchorElement>('.docs-nav-item').forEach(el => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      const id = el.dataset.page;
      if (id) navigateTo(id);
    });
  });

  // Handle internal doc links (e.g., [Sessions](sessions))
  root.querySelectorAll<HTMLAnchorElement>('.docs-article a').forEach(el => {
    const href = el.getAttribute('href');
    if (href && !href.startsWith('http') && !href.startsWith('#')) {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        navigateTo(href);
      });
    }
  });

  // Scroll content to top on page change
  const main = root.querySelector('.docs-main');
  if (main) main.scrollTop = 0;
}

// Initial render
render();

// Theme sync: listen for changes from the main window
if (window.docsAPI) {
  window.docsAPI.onThemeChanged((themeName: string) => {
    applyTheme(themeName);
  });
}
