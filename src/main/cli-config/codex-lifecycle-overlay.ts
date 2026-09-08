import path from 'node:path';
import { getCodexHome } from '../codex/transcripts';
import { createLogger } from '../logger';
import { quoteShellArg } from '../../shared/shell-quote';
import {
  SENTINEL_TOKEN,
  createOverlayMutex,
  localConfigFileStore,
  type ConfigFileStore,
} from './overlay-common';

const log = createLogger('codex-lifecycle-overlay');
const withMutex = createOverlayMutex();

export interface CodexLifecycleOverlayContext {
  helperPath: string;
  hooksPath?: string;
  store?: ConfigFileStore;
}

const EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PermissionRequest',
  'PostToolUse',
  'PreCompact',
  'PostCompact',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'Interrupt',
  'SessionEnd',
] as const;

function resolveHooksPath(ctx: CodexLifecycleOverlayContext): string {
  return ctx.hooksPath || path.join(getCodexHome(), 'hooks.json');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function buildCommand(helperPath: string): string {
  return ['node', helperPath, '--codex-hook'].map((part) => quoteShellArg(part)).join(' ');
}

function isTetherCodexLifecycleHook(value: unknown): boolean {
  return isObject(value) &&
    value.type === 'command' &&
    typeof value.command === 'string' &&
    value.command.includes(SENTINEL_TOKEN) &&
    value.command.includes('--codex-hook');
}

function scrubGroup(group: unknown): { group: unknown; changed: boolean } | null | false {
  if (!isObject(group)) return false;
  if ('hooks' in group && !Array.isArray(group.hooks)) return false;
  const hooks = Array.isArray(group.hooks) ? group.hooks : null;
  if (!hooks) return { group, changed: false };
  const nextHooks = hooks.filter((hook) => !isTetherCodexLifecycleHook(hook));
  if (nextHooks.length === hooks.length) return { group, changed: false };
  if (nextHooks.length === 0) return null;
  return { group: { ...group, hooks: nextHooks }, changed: true };
}

function scrubEventGroups(groups: unknown): { groups: unknown[]; changed: boolean; valid: boolean } {
  if (!Array.isArray(groups)) return { groups: [], changed: false, valid: false };
  const next: unknown[] = [];
  let changed = false;
  for (const group of groups) {
    const scrubbed = scrubGroup(group);
    if (scrubbed === false) return { groups, changed: false, valid: false };
    if (scrubbed === null) {
      changed = true;
      continue;
    }
    changed ||= scrubbed.changed;
    next.push(scrubbed.group);
  }
  return { groups: next, changed, valid: true };
}

function lifecycleHook(helperPath: string, event: string): Record<string, unknown> {
  const timeout = event === 'SessionEnd' || event === 'Interrupt' ? 1 : 2;
  return {
    type: 'command',
    command: buildCommand(helperPath),
    async: true,
    timeout,
  };
}

function lifecycleGroup(helperPath: string, event: string): Record<string, unknown> {
  return {
    hooks: [lifecycleHook(helperPath, event)],
  };
}

export function mergeCodexLifecycleHooks(
  text: string | null,
  helperPath: string,
): { text: string; changed: boolean; valid: boolean } {
  const originalText = text ?? '';
  let root: Record<string, unknown>;
  if (!text) {
    root = {};
  } else {
    try {
      const parsed = JSON.parse(text);
      if (!isObject(parsed)) return { text, changed: false, valid: false };
      root = parsed;
    } catch {
      return { text, changed: false, valid: false };
    }
  }

  if ('hooks' in root && !isObject(root.hooks)) return { text: originalText, changed: false, valid: false };
  const hooksRoot = isObject(root.hooks) ? { ...root.hooks } : {};
  for (const event of EVENTS) {
    const scrubbed = event in hooksRoot ? scrubEventGroups(hooksRoot[event]) : { groups: [], changed: false, valid: true };
    if (!scrubbed.valid) return { text: originalText, changed: false, valid: false };
    hooksRoot[event] = [...scrubbed.groups, lifecycleGroup(helperPath, event)];
  }

  const next = { ...root, hooks: hooksRoot };
  const nextText = JSON.stringify(next, null, 2) + '\n';
  return { text: nextText, changed: nextText !== originalText, valid: true };
}

export function scrubCodexLifecycleHooks(
  text: string | null,
): { text: string; changed: boolean; valid: boolean } {
  if (!text) return { text: '', changed: false, valid: true };
  let root: Record<string, unknown>;
  try {
    const parsed = JSON.parse(text);
    if (!isObject(parsed)) return { text, changed: false, valid: false };
    root = parsed;
  } catch {
    return { text, changed: false, valid: false };
  }

  if ('hooks' in root && !isObject(root.hooks)) return { text, changed: false, valid: false };
  if (!isObject(root.hooks)) return { text, changed: false, valid: true };
  const hooksRoot = { ...root.hooks };
  let changed = false;
  for (const event of EVENTS) {
    if (!(event in hooksRoot)) continue;
    const scrubbed = scrubEventGroups(hooksRoot[event]);
    if (!scrubbed.valid) return { text, changed: false, valid: false };
    changed ||= scrubbed.changed;
    if (scrubbed.groups.length > 0) hooksRoot[event] = scrubbed.groups;
    else if (event in hooksRoot && scrubbed.changed) delete hooksRoot[event];
  }
  if (!changed) return { text, changed: false, valid: true };
  const next = { ...root, hooks: hooksRoot };
  return { text: JSON.stringify(next, null, 2) + '\n', changed: true, valid: true };
}

function readExisting(store: ConfigFileStore, filePath: string): string | null {
  return store.read(filePath);
}

export async function installCodexLifecycleHooks(ctx: CodexLifecycleOverlayContext): Promise<void> {
  await withMutex(async () => {
    const store = ctx.store ?? localConfigFileStore;
    const filePath = resolveHooksPath(ctx);
    const merged = mergeCodexLifecycleHooks(readExisting(store, filePath), ctx.helperPath);
    if (!merged.valid) {
      log.warn('Codex hooks.json is malformed or non-object; lifecycle hooks not installed', { filePath });
      return;
    }
    if (!merged.changed) return;
    store.writeAtomic(filePath, merged.text);
    log.info('Codex lifecycle hooks installed', { filePath });
  });
}

export async function uninstallCodexLifecycleHooks(ctx: CodexLifecycleOverlayContext): Promise<void> {
  await withMutex(async () => {
    const store = ctx.store ?? localConfigFileStore;
    const filePath = resolveHooksPath(ctx);
    if (!store.exists(filePath)) return;
    const scrubbed = scrubCodexLifecycleHooks(readExisting(store, filePath));
    if (!scrubbed.valid) {
      log.warn('Codex hooks.json is malformed or non-object; lifecycle scrub skipped', { filePath });
      return;
    }
    if (!scrubbed.changed) return;
    store.writeAtomic(filePath, scrubbed.text);
    log.info('Codex lifecycle hooks removed', { filePath });
  });
}
