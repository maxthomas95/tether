import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// Electron 20+ sandboxes renderers by default, and a sandboxed preload's
// require('electron') exposes only these modules. Anything else (clipboard,
// shell, ...) is undefined at runtime and throws on first use.
const SANDBOXED_PRELOAD_ELECTRON_MODULES = new Set([
  'contextBridge',
  'crashReporter',
  'ipcRenderer',
  'nativeImage',
  'sharedTexture',
  'webFrame',
  'webUtils',
]);

const preloadDir = __dirname;
const preloadFiles = readdirSync(preloadDir)
  .filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts'));

/** Runtime electron imports that are not in the sandboxed-preload allowlist. */
function disallowedElectronImports(source: string, fileName: string): string[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const bad: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text === 'electron') {
      const clause = node.importClause;
      if (clause && !clause.isTypeOnly) {
        if (clause.name) bad.push(`default import ${clause.name.text}`);
        const bindings = clause.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) bad.push(`namespace import ${bindings.name.text}`);
        if (bindings && ts.isNamedImports(bindings)) {
          for (const el of bindings.elements) {
            const imported = (el.propertyName ?? el.name).text;
            if (!el.isTypeOnly && !SANDBOXED_PRELOAD_ELECTRON_MODULES.has(imported)) bad.push(imported);
          }
        }
      }
    }
    if (ts.isCallExpression(node) && node.expression.getText(file) === 'require' &&
        node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === 'electron') {
      bad.push('require(\'electron\')');
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return bad;
}

describe('sandboxed preload electron imports', () => {
  it('finds the preload entry points', () => {
    expect(preloadFiles).toEqual(expect.arrayContaining(['preload.ts', 'docs-preload.ts']));
  });

  it.each(preloadFiles)('%s imports only modules a sandboxed preload can reach', (name) => {
    const source = readFileSync(path.join(preloadDir, name), 'utf8');
    expect(disallowedElectronImports(source, name)).toEqual([]);
  });

  it('flags modules outside the sandbox allowlist, and ignores type-only imports', () => {
    expect(disallowedElectronImports(
      "import { contextBridge, clipboard, shell as s, type IpcRendererEvent } from 'electron';\n" +
      "import type { WebFrame } from 'electron';\n" +
      "import * as electron from 'electron';\n" +
      "const e = require('electron');\n",
      'fixture.ts',
    )).toEqual(['clipboard', 'shell', 'namespace import electron', 'require(\'electron\')']);
  });
});
