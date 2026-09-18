import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WorkspaceFileTools } from '../src/tools/workspaceFileTools.js';

describe('WorkspaceFileTools', () => {
  let root: string;
  let tools: WorkspaceFileTools;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-agents-tools-'));
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'existing.ts'), 'export const value = 1;\n');
    tools = new WorkspaceFileTools(root);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('lists, reads, and writes files inside the workspace', () => {
    const entries = tools.list('src');
    expect(entries.map((entry) => entry.name)).toContain('existing.ts');

    expect(tools.read('src/existing.ts').content).toContain('value = 1');

    const written = tools.write('src/generated.ts', 'export const generated = true;\n');
    expect(written.created).toBe(true);
    expect(tools.read('src/generated.ts').content).toContain('generated = true');
  });

  it('blocks traversal outside the workspace', () => {
    expect(() => tools.read('../outside.txt')).toThrow('Path escapes the workspace');
    expect(() => tools.write('../outside.txt', 'nope')).toThrow('Path escapes the workspace');
  });

  it('blocks sensitive workspace files', () => {
    fs.writeFileSync(path.join(root, '.env'), 'SECRET=value\n');

    expect(() => tools.read('.env')).toThrow('blocked by workspace safety rules');
    expect(() => tools.write('.env.local', 'SECRET=value\n')).toThrow(
      'blocked by workspace safety rules',
    );
  });

  it('allows non-secret environment templates', () => {
    const result = tools.write('.env.example', 'NVIDIA_API_KEY=\n');
    expect(result.path).toBe('.env.example');
  });
});
