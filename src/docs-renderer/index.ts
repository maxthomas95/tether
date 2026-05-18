import { marked } from 'marked';
import { LOADER_THEMES, type LoaderTheme } from '../shared/loader-themes';

import gettingStartedMd from '../docs/getting-started.md?raw';
import sessionsMd from '../docs/sessions.md?raw';
import environmentsMd from '../docs/environments.md?raw';
import keyboardShortcutsMd from '../docs/keyboard-shortcuts.md?raw';
import settingsMd from '../docs/settings.md?raw';
import vaultMd from '../docs/vault.md?raw';
import gitProvidersMd from '../docs/git-providers.md?raw';
import usageQuotaMd from '../docs/usage-quota.md?raw';
import helmMd from '../docs/helm.md?raw';

// Self-hosted fonts — same identity as the main renderer (Phase 1 UX refresh).
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-sans/700.css';
import '@fontsource-variable/jetbrains-mono';

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
  tether:         { hover: '#3a342d', active: '#4a4239', header: '#2c2723', textSecondary: '#c9bfae' },
  'default-dark': { hover: '#2a2d2e', active: '#37373d', header: '#3c3c3c', textSecondary: '#999999' },
  'tether-light':  { hover: '#e8e8e8', active: '#d6d6d6', header: '#ececec', textSecondary: '#616161' },
};

// Slugify heading text into a stable anchor id matching what dialog (?) icons
// pass to `tetherAPI.docs.open({ anchor })`. Mirrors GitHub-flavored anchors:
// lowercase, spaces → hyphens, then a character whitelist as the final pass.
// The whitelist is what makes this safe — any HTML or entity refs that survive
// upstream extraction are dropped before the slug is used as an id attribute.
function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9\-_]/g, '');
}

const headingRenderer = new marked.Renderer();
headingRenderer.heading = ({ tokens, depth }) => {
  const text = headingRenderer.parser.parseInline(tokens);
  const plain = tokens.map(t => ('text' in t ? t.text : '')).join('');
  const id = slugify(plain);
  return `<h${depth} id="${id}">${text}</h${depth}>\n`;
};

function renderMarkdown(src: string): string {
  return marked.parse(src, { renderer: headingRenderer }) as string;
}

interface DocPage {
  id: string;
  title: string;
  html: string;
}

const pages: DocPage[] = [
  { id: 'getting-started',    title: 'Getting Started',    html: renderMarkdown(gettingStartedMd) },
  { id: 'sessions',           title: 'Sessions',           html: renderMarkdown(sessionsMd) },
  { id: 'environments',       title: 'Environments',       html: renderMarkdown(environmentsMd) },
  { id: 'vault',              title: 'Vault',              html: renderMarkdown(vaultMd) },
  { id: 'git-providers',      title: 'Git Providers',      html: renderMarkdown(gitProvidersMd) },
  { id: 'usage-quota',        title: 'Usage & Quota',      html: renderMarkdown(usageQuotaMd) },
  { id: 'helm',               title: 'Helm',               html: renderMarkdown(helmMd) },
  { id: 'keyboard-shortcuts', title: 'Keyboard Shortcuts', html: renderMarkdown(keyboardShortcutsMd) },
  { id: 'settings',           title: 'Settings',           html: renderMarkdown(settingsMd) },
];

let currentPage = pages[0];
let pendingAnchor: string | null = null;

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

function navigateTo(pageId: string, anchor?: string): void {
  const page = pages.find(p => p.id === pageId);
  if (!page) return;
  currentPage = page;
  pendingAnchor = anchor ?? null;
  render();
}

function scrollToPendingAnchor(): void {
  const main = document.querySelector<HTMLElement>('.docs-main');
  if (!main) return;

  if (!pendingAnchor) {
    main.scrollTop = 0;
    return;
  }

  const target = document.getElementById(pendingAnchor);
  pendingAnchor = null;
  if (target) {
    target.scrollIntoView({ block: 'start', behavior: 'auto' });
    target.classList.add('docs-anchor-flash');
    setTimeout(() => target.classList.remove('docs-anchor-flash'), 1200);
  } else {
    main.scrollTop = 0;
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

  // Handle internal doc links (e.g., [Sessions](sessions), [Vault](vault#oidc))
  root.querySelectorAll<HTMLAnchorElement>('.docs-article a').forEach(el => {
    const href = el.getAttribute('href');
    if (!href || href.startsWith('http')) return;
    el.addEventListener('click', (e) => {
      e.preventDefault();
      if (href.startsWith('#')) {
        // Anchor within the current page
        pendingAnchor = href.slice(1);
        scrollToPendingAnchor();
        return;
      }
      const [page, anchor] = href.split('#');
      navigateTo(page, anchor);
    });
  });

  scrollToPendingAnchor();
}

// Parse the initial URL for a deep-link target
const initialParams = new URLSearchParams(window.location.search);
const initialPage = initialParams.get('page');
const initialAnchor = initialParams.get('anchor');
if (initialPage && pages.some(p => p.id === initialPage)) {
  currentPage = pages.find(p => p.id === initialPage)!;
}
if (initialAnchor) pendingAnchor = initialAnchor;

// Initial render
render();

// Theme sync + runtime navigate (when the docs window is already open
// and another (?) icon is clicked in the main window).
if (window.docsAPI) {
  window.docsAPI.onThemeChanged((themeName: string) => {
    applyTheme(themeName);
  });
  window.docsAPI.onNavigate((target) => {
    if (target.page) {
      navigateTo(target.page, target.anchor);
    } else if (target.anchor) {
      pendingAnchor = target.anchor;
      scrollToPendingAnchor();
    }
  });
}
