import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SafeGitInspector } from '../src/tools/safeGitInspector.js';

function git(root: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

describe('SafeGitInspector', () => {
  let root: string;
  let inspector: SafeGitInspector;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-agents-git-inspector-'));
    git(root, ['init']);
    git(root, ['config', 'user.email', 'tests@example.com']);
    git(root, ['config', 'user.name', 'Pixel Agents Tests']);

    fs.writeFileSync(path.join(root, 'source.ts'), 'export const value = 1;\n');
    fs.writeFileSync(path.join(root, '.env'), 'SECRET=original\n');
    fs.writeFileSync(path.join(root, 'private.pem'), 'PRIVATE_KEY=original\n');

    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'initial']);

    inspector = new SafeGitInspector(root);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reports safe workspace status while hiding sensitive paths', async () => {
    fs.writeFileSync(path.join(root, 'source.ts'), 'export const value = 2;\n');
    fs.writeFileSync(path.join(root, '.env'), 'SECRET=changed\n');
    fs.writeFileSync(path.join(root, 'safe.txt'), 'visible\n');
    fs.writeFileSync(path.join(root, 'secret.key'), 'hidden\n');

    const result = await inspector.status();

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toContain('source.ts');
    expect(result.stdout).toContain('safe.txt');
    expect(result.stdout).not.toContain('.env');
    expect(result.stdout).not.toContain('secret.key');
  });

  it('returns tracked diff from HEAD while excluding sensitive file contents', async () => {
    fs.writeFileSync(path.join(root, 'source.ts'), 'export const value = 3;\n');
    fs.writeFileSync(path.join(root, '.env'), 'SECRET=changed-again\n');
    fs.writeFileSync(path.join(root, 'private.pem'), 'PRIVATE_KEY=changed\n');
    git(root, ['add', 'source.ts']);

    const before = git(root, ['status', '--short']);
    const result = await inspector.diff();
    const after = git(root, ['status', '--short']);

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toContain('source.ts');
    expect(result.stdout).toContain('value = 3');
    expect(result.stdout).not.toContain('SECRET=changed-again');
    expect(result.stdout).not.toContain('PRIVATE_KEY=changed');
    expect(after).toBe(before);
  });

  it('does not expose mutation commands', () => {
    const methods = Object.getOwnPropertyNames(SafeGitInspector.prototype);

    expect(methods).toContain('status');
    expect(methods).toContain('diff');
    expect(methods).not.toContain('commit');
    expect(methods).not.toContain('checkout');
    expect(methods).not.toContain('reset');
    expect(methods).not.toContain('push');
  });
});
