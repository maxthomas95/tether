import { app } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { getDb } from '../db/database';
import { createLogger } from '../logger';
import { scrubDbData, scrubLogText } from './scrub';

const log = createLogger('diagnostics');

export interface DiagnosticsExportResult {
  ok: boolean;
  path?: string;
  bytes?: number;
  files?: string[];
  error?: string;
}

interface Manifest {
  generatedAt: string;
  appVersion: string;
  electronVersion: string;
  nodeVersion: string;
  chromeVersion: string;
  platform: string;
  osRelease: string;
  arch: string;
  files: Array<{ name: string; bytes: number; scrubbed: boolean }>;
  scrubbingNotes: string[];
}

const SCRUBBING_NOTES = [
  'data.json: SSH passwords, plaintext git tokens, sensitive env-var values, and the cached vault token are replaced with [REDACTED]. Vault references (vault://...) are kept intact.',
  'tether.log files: well-known API key prefixes (sk-ant-, sk-, ghp_, github_pat_, glpat-, xoxb-, AIza, hvs.) are replaced with [REDACTED-API-KEY]. The logger does not deliberately record secret values, but the scrub is a defence in depth.',
  'Open data.json before sharing if you want to verify what is in the bundle.',
];

/**
 * Build a diagnostics zip at `destPath`. Bundles the scrubbed `data.json`,
 * the rotated log files (light scrubbing for known API key prefixes), and a
 * `manifest.json` describing the contents.
 */
export async function exportDiagnostics(destPath: string): Promise<DiagnosticsExportResult> {
  try {
    const zip = new AdmZip();
    const files: Manifest['files'] = [];

    // 1. Scrubbed data.json
    const scrubbed = scrubDbData(getDb());
    const dataJson = JSON.stringify(scrubbed, null, 2);
    const dataBuf = Buffer.from(dataJson, 'utf-8');
    zip.addFile('data.json', dataBuf);
    files.push({ name: 'data.json', bytes: dataBuf.byteLength, scrubbed: true });

    // 2. Log files (current + rotated)
    const logsDir = path.join(app.getPath('userData'), 'logs');
    const candidateLogs = ['tether.log', 'tether.1.log', 'tether.2.log'];
    for (const name of candidateLogs) {
      const logPath = path.join(logsDir, name);
      let raw: string;
      try {
        raw = fs.readFileSync(logPath, 'utf-8');
      } catch {
        continue; // file doesn't exist (no rotation yet, etc.)
      }
      const cleaned = scrubLogText(raw);
      const buf = Buffer.from(cleaned, 'utf-8');
      zip.addFile(name, buf);
      files.push({ name, bytes: buf.byteLength, scrubbed: true });
    }

    // 3. Manifest
    const manifest: Manifest = {
      generatedAt: new Date().toISOString(),
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron,
      nodeVersion: process.versions.node,
      chromeVersion: process.versions.chrome,
      platform: process.platform,
      osRelease: os.release(),
      arch: process.arch,
      files,
      scrubbingNotes: SCRUBBING_NOTES,
    };
    const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 2), 'utf-8');
    zip.addFile('manifest.json', manifestBuf);

    zip.writeZip(destPath);
    const stat = fs.statSync(destPath);
    log.info('Diagnostics export written', { destPath, bytes: stat.size, fileCount: files.length });
    return {
      ok: true,
      path: destPath,
      bytes: stat.size,
      files: files.map(f => f.name).concat('manifest.json'),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Diagnostics export failed', { destPath, error: message });
    return { ok: false, error: message };
  }
}

/** Default save-dialog filename: `tether-diagnostics-2026-05-09T17-30-00.zip`. */
export function defaultExportFilename(now: Date = new Date()): string {
  // ISO format is `YYYY-MM-DDTHH:mm:ss.sssZ`; we want the seconds part with
  // colons swapped for dashes (filename-safe). Avoid `/\..+$/` to dodge
  // Sonar S5852's super-linear-backtracking heuristic on `.+$`.
  const iso = now.toISOString();
  const dotIdx = iso.indexOf('.');
  const trimmed = dotIdx >= 0 ? iso.slice(0, dotIdx) : iso;
  const stamp = trimmed.replaceAll(':', '-');
  return `tether-diagnostics-${stamp}.zip`;
}
