import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect } from 'vitest';

export function createView() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  return {
    container,
    render: async (element: React.ReactNode) => { await act(async () => root.render(element)); },
    dispose: async () => { await act(async () => root.unmount()); container.remove(); },
  };
}

export function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find(item => item.textContent === label);
  expect(found, `button ${label}`).toBeDefined();
  return found!;
}

export async function click(element: HTMLElement) {
  await act(async () => element.click());
}

export async function change(element: HTMLInputElement | HTMLSelectElement, value: string) {
  await act(async () => {
    const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLSelectElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
