// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getTheme, themeList } from '../renderer/styles/themes';

type Target = { page?: string; anchor?: string };
let navigate: (target: Target) => void;
let changeTheme: (theme: string) => void;
const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  document.body.innerHTML = '<div id="docs-root"></div>';
  document.documentElement.removeAttribute('style');
  window.history.replaceState({}, '', '/');
  vi.stubGlobal('docsAPI', {
    onNavigate: (callback: typeof navigate) => { navigate = callback; },
    onThemeChanged: (callback: typeof changeTheme) => { changeTheme = callback; },
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalScrollIntoView) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScrollIntoView);
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('style');
  window.history.replaceState({}, '', '/');
});

it.each(themeList)('opens documentation with the $label app palette', async theme => {
  window.history.replaceState({}, '', `/?theme=${theme.name}`);
  await import('./index');

  for (const [property, value] of Object.entries(theme.css)) {
    expect(document.documentElement.style.getPropertyValue(property), property).toBe(value);
  }
});

it('updates the entire palette when the saved theme changes', async () => {
  await import('./index');
  for (const theme of [...themeList, getTheme('unknown')]) {
    changeTheme(theme.name);
    for (const [property, value] of Object.entries(theme.css)) {
      expect(document.documentElement.style.getPropertyValue(property), property).toBe(value);
    }
  }
});

it('opens and navigates settings help anchors in the rendered docs', async () => {
  window.history.replaceState({}, '', '/?page=settings&anchor=appearance');
  await import('./index');
  expect(document.getElementById('appearance')?.classList.contains('docs-anchor-flash')).toBe(true);

  for (const anchor of ['general', 'appearance', 'terminal', 'sessions', 'notifications', 'shortcuts', 'integrations', 'usage']) {
    navigate({ page: 'settings', anchor });
    expect(document.getElementById(anchor)?.classList.contains('docs-anchor-flash'), anchor).toBe(true);
  }
});

it('every internal article link uses a Markdown path and opens an existing page and heading', async () => {
  await import('./index');
  const pages = Array.from(document.querySelectorAll<HTMLElement>('.docs-nav-item'), el => el.dataset.page!);
  let checked = 0;

  for (const page of pages) {
    navigate({ page });
    const links = Array.from(document.querySelectorAll<HTMLAnchorElement>('.docs-article a'), el => el.getAttribute('href')!)
      .filter(href => !/^https?:/.test(href));
    for (const href of links) {
      navigate({ page });
      const link = Array.from(document.querySelectorAll<HTMLAnchorElement>('.docs-article a'))
        .find(el => el.getAttribute('href') === href)!;
      link.click();
      const [targetPage, anchor] = href.split('#');
      const active = document.querySelector<HTMLElement>('.docs-nav-item--active');
      if (targetPage) expect(targetPage.endsWith('.md'), `${page} → ${href}`).toBe(true);
      expect(active?.dataset.page, `${page} → ${href}`).toBe(targetPage ? targetPage.slice(0, -3) : page);
      if (anchor) {
        expect(document.getElementById(anchor)?.classList.contains('docs-anchor-flash'), `${page} → ${href}`).toBe(true);
      }
      checked++;
    }
  }
  expect(checked).toBeGreaterThan(0);
});
