import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function readCsp(file: string): string {
  const html = readProjectFile(file);
  const match = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/);
  if (!match) throw new Error(`Missing CSP meta tag in ${file}`);
  return match[1];
}

function readProjectFile(file: string): string {
  return readFileSync(resolve(process.cwd(), file), 'utf8');
}

function readSonarProperties(): string {
  return readProjectFile('.sonarcloud.properties');
}

function directive(csp: string, name: string): string[] {
  const value = csp
    .split(';')
    .map(part => part.trim())
    .find(part => part.startsWith(`${name} `));
  return value ? value.split(/\s+/).slice(1) : [];
}

describe('renderer CSP style directives', () => {
  it('allows runtime renderer styles without broad style-src unsafe-inline', () => {
    const csp = readCsp('index.html');

    expect(directive(csp, 'style-src')).toContain("'sha256-OX2MoKPidt/DOFBxkvnq7fypbIIqDizDpa3tZR2VoAs='");
    expect(directive(csp, 'style-src')).not.toContain("'unsafe-inline'");
    expect(directive(csp, 'style-src-elem')).toEqual(expect.arrayContaining(["'self'", "'unsafe-inline'"]));
    expect(directive(csp, 'style-src-attr')).toContain("'unsafe-inline'");
  });

  it('keeps the docs boot style hash while allowing runtime docs styles', () => {
    const csp = readCsp('docs-window.html');

    expect(directive(csp, 'style-src')).toContain("'sha256-LDJwO9RJByaWNw/jyli+okv9VPbA47ii+LRt8wqnXyQ='");
    expect(directive(csp, 'style-src')).not.toContain("'unsafe-inline'");
    expect(directive(csp, 'style-src-elem')).toEqual(expect.arrayContaining(["'self'", "'unsafe-inline'"]));
    expect(directive(csp, 'style-src-attr')).toContain("'unsafe-inline'");
  });

  it('keeps static Electron shell CSP out of Sonar source analysis', () => {
    const sonarProperties = readSonarProperties();

    expect(sonarProperties).toContain('sonar.exclusions=index.html,docs-window.html');
  });

  it('does not rely on inline Sonar suppression comments in root HTML', () => {
    expect(readProjectFile('index.html')).not.toMatch(/NOSONAR/i);
    expect(readProjectFile('docs-window.html')).not.toMatch(/NOSONAR/i);
  });
});
