import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

// Connect to Chromium's loopback CDP endpoint, rather than Electron's Node
// inspector: the packaged RunAsNode/Node-inspect security fuses stay disabled.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable = path.join(root, 'out', 'Tether-win32-x64', 'Tether.exe');
const diagnostics = path.join(root, 'out', 'smoke-windows');
const label = 'Packaged smoke';
const timeout = 30_000;
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'tether-smoke-'));
const userData = path.join(scratch, 'user-data');
const isolatedHome = path.join(scratch, 'home');
let running;
let page;
let browser;
let appOutput = '';
let taskkillExecutable;
const errors = [];

async function waitFor(check, description) {
  const deadline = Date.now() + timeout;
  async function poll() {
    if (await check()) return;
    if (Date.now() >= deadline) throw new Error(`Timed out: ${description}`);
    await new Promise(resolve => setTimeout(resolve, 100));
    return poll();
  }
  return poll();
}

async function launch() {
  const childEnv = {
    ...process.env,
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    CODEX_HOME: path.join(isolatedHome, '.codex'),
    CLAUDE_CONFIG_DIR: path.join(isolatedHome, '.claude'),
    XDG_DATA_HOME: path.join(isolatedHome, '.local', 'share'),
    LOCALAPPDATA: path.join(isolatedHome, 'AppData', 'Local'),
    CRUSH_GLOBAL_DATA: path.join(isolatedHome, 'crush'),
  };
  // Prevent host CLI configuration or Electron's CLI mode leaking into this run.
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']) delete childEnv[key];
  running = spawn(executable, [
    `--user-data-dir=${userData}`,
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
  ], { cwd: scratch, env: childEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  appOutput = '';
  running.on('error', error => { errors.push(error.message); });
  for (const stream of [running.stdout, running.stderr]) {
    stream.on('data', data => { appOutput = (appOutput + data.toString()).slice(-100_000); });
  }
  await waitFor(() => {
    if (errors.length) throw new Error(errors.join('\n'));
    if (running.exitCode !== null) throw new Error(`App exited during startup (${running.exitCode}): ${appOutput}`);
    return appOutput.includes('DevTools listening on ws://');
  }, 'packaged app CDP startup');
  const endpoint = /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/.exec(appOutput)?.[1];
  assert.ok(endpoint, 'CDP must listen on loopback');
  browser = await chromium.connectOverCDP(endpoint);
  await waitFor(() => browser.contexts()[0]?.pages().some(candidate => candidate.url().startsWith('file:')), 'main window');
  page = browser.contexts()[0].pages().find(candidate => candidate.url().startsWith('file:'));
  page.setDefaultTimeout(timeout);
  page.on('pageerror', error => { errors.push(error.message); });
  await page.getByRole('button', { name: 'Settings', exact: true }).waitFor({ state: 'attached' });
  // Fail before interacting if Electron ignored our disposable user-data path.
  await fs.access(path.join(userData, 'data.json'));
  return () => appOutput;
}

async function closeCleanly() {
  const exited = once(running, 'exit');
  await page.getByRole('button', { name: 'File', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Exit/ }).click();
  const result = await Promise.race([
    exited,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('App did not shut down cleanly')), timeout);
      timer.unref();
    }),
  ]);
  assert.equal(result[0], 0, 'packaged app exit code');
  await browser.close();
  browser = undefined;
  running = undefined;
}

try {
  assert.equal(process.platform, 'win32', 'This smoke targets the shipped Windows package');
  assert.ok(process.env.SystemRoot && path.isAbsolute(process.env.SystemRoot), 'Windows system directory is available');
  taskkillExecutable = path.join(process.env.SystemRoot, 'System32', 'taskkill.exe');
  await fs.access(executable);
  await fs.mkdir(diagnostics, { recursive: true });
  await Promise.all(['failure.txt', 'failure.png', 'app-output.log', 'terminal-output.log', 'first-launch.log']
    .map(filename => fs.rm(path.join(diagnostics, filename), { force: true })));
  await fs.mkdir(isolatedHome, { recursive: true });
  await fs.copyFile(path.join(root, 'scripts', 'fixtures', 'terminal-smoke.cjs'), path.join(scratch, 'terminal-smoke.cjs'));
  const output = await launch();
  await page.getByRole('dialog', { name: 'Setup wizard', exact: true }).getByRole('button', { name: 'Skip Setup', exact: true }).click();

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.getByRole('tab', { name: 'Appearance', exact: true }).click();
  await settings.getByRole('button', { name: 'Nord', exact: true }).click();
  await settings.getByRole('button', { name: 'Save', exact: true }).click();
  await settings.waitFor({ state: 'hidden' });
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'nord');

  // Observe the real preload/IPC output alongside xterm; do not replace or mock it.
  await page.evaluate(() => {
    globalThis.smokeOutput = '';
    window.electronAPI.session.onData((_id, data) => {
      globalThis.smokeOutput = (globalThis.smokeOutput + data).slice(-100_000);
    });
  });
  await page.getByRole('button', { name: 'New session', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New session', exact: true });
  await dialog.getByLabel('CLI tool', { exact: true }).selectOption('custom');
  await dialog.getByLabel('Binary Name', { exact: true }).fill(process.execPath);
  await dialog.getByLabel('Directory', { exact: true }).fill(scratch);
  await dialog.getByLabel('Label (optional)', { exact: true }).fill(label);
  await dialog.locator('summary').filter({ hasText: 'CLI flags' }).click();
  const flag = dialog.getByRole('textbox', { name: 'Additional CLI flag', exact: true });
  await flag.fill('terminal-smoke.cjs');
  await flag.press('Enter');
  await dialog.getByRole('button', { name: 'Create session', exact: true }).click();
  await page.waitForFunction(() => globalThis.smokeOutput.includes('TETHER_SMOKE_READY'), null, { timeout });
  await page.locator('.xterm-screen').waitFor({ state: 'visible' });
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type('ordinary typing 123');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => globalThis.smokeOutput.includes('TETHER_SMOKE_ECHO:ordinary typing 123'), null, { timeout });

  await page.setViewportSize({ width: 1000, height: 720 });
  await page.waitForFunction(() => globalThis.smokeOutput.includes('TETHER_SMOKE_SIZE:'), null, { timeout });
  await page.locator('.session-item').filter({ hasText: label }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Stop', exact: true }).click();
  await page.waitForFunction(async () => (await window.electronAPI.session.list()).some(session => session.label === 'Packaged smoke' && session.state === 'stopped'), null, { timeout });
  assert.deepEqual(errors, [], 'renderer errors');
  await fs.writeFile(path.join(diagnostics, 'first-launch.log'), output());
  await closeCleanly();

  await launch();
  assert.equal(await page.getByRole('dialog', { name: 'Setup wizard', exact: true }).count(), 0, 'setup completion survives restart');
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'nord', null, { timeout });
  const saved = JSON.parse(await fs.readFile(path.join(userData, 'data.json'), 'utf8'));
  assert.equal(saved.config.theme, 'nord', 'saved theme survives restart');
  assert.equal(saved.config.setupComplete, 'true', 'saved setup completion');
  assert.deepEqual(errors, [], 'renderer errors after restart');
  await closeCleanly();
  console.log('Windows packaged smoke passed: fresh setup, saved theme, local PTY, ordinary typing, resize, Stop, clean exit, restart.');
} catch (error) {
  await fs.mkdir(diagnostics, { recursive: true });
  await fs.writeFile(path.join(diagnostics, 'failure.txt'), `${error.stack}\n${errors.join('\n')}`);
  await fs.writeFile(path.join(diagnostics, 'app-output.log'), appOutput);
  if (page && !page.isClosed()) {
    const terminalOutput = await page.evaluate(() => globalThis.smokeOutput || '').catch(() => '');
    await fs.writeFile(path.join(diagnostics, 'terminal-output.log'), terminalOutput);
  }
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(diagnostics, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (running?.pid && running.exitCode === null) {
    // Kill only the child tree launched by this harness after a failed smoke.
    spawnSync(taskkillExecutable, ['/pid', String(running.pid), '/T', '/F'], { windowsHide: true });
  }
  // Keep only the bounded diagnostics above; never upload a user-data directory.
  assert.equal(path.dirname(path.resolve(scratch)), path.resolve(os.tmpdir()), 'cleanup stays inside the temp directory');
  assert.ok(path.basename(scratch).startsWith('tether-smoke-'), 'cleanup targets this harness');
  await fs.rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
