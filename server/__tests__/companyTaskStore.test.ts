import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CompanyTaskStore } from '../src/company/companyTaskStore.js';

describe('CompanyTaskStore persistence', () => {
  let root: string;
  let workspace: string;
  let storageDir: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-agents-company-store-'));
    workspace = path.join(root, 'workspace');
    storageDir = path.join(root, 'company-state');
    fs.mkdirSync(workspace, { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('persists tasks, restores them, and continues task ids after restart', () => {
    const firstStore = new CompanyTaskStore({ workspaceRoot: workspace, storageDir });
    const first = firstStore.create({
      title: 'İlk görev',
      description: 'Kalıcı görev testi',
      assignee: 'Developer',
    });
    firstStore.update(first.id, {
      status: 'completed',
      result: 'Tamamlandı',
    });

    expect(first.id).toBe('task-1');
    expect(fs.readdirSync(storageDir)).toHaveLength(1);
    expect(fs.readdirSync(storageDir).some((name) => name.endsWith('.tmp'))).toBe(false);

    const restoredStore = new CompanyTaskStore({ workspaceRoot: workspace, storageDir });
    expect(restoredStore.list()).toEqual([
      expect.objectContaining({
        id: 'task-1',
        assignee: 'developer',
        status: 'completed',
        result: 'Tamamlandı',
      }),
    ]);

    const second = restoredStore.create({
      title: 'İkinci görev',
      description: 'ID devamlılığı',
      assignee: 'tester',
    });
    expect(second.id).toBe('task-2');
  });

  it('marks running tasks as failed when the process restarts', () => {
    const firstStore = new CompanyTaskStore({ workspaceRoot: workspace, storageDir });
    const task = firstStore.create({
      title: 'Yarım kalan görev',
      description: 'Restart recovery',
      assignee: 'developer',
    });
    firstStore.update(task.id, { status: 'running' });

    const restoredStore = new CompanyTaskStore({ workspaceRoot: workspace, storageDir });
    const restored = restoredStore.list()[0];

    expect(restored).toEqual(
      expect.objectContaining({
        id: 'task-1',
        status: 'failed',
        error: 'Process restarted before task completed.',
      }),
    );

    const reloadedAgain = new CompanyTaskStore({ workspaceRoot: workspace, storageDir });
    expect(reloadedAgain.list()[0]?.status).toBe('failed');
  });

  it('falls back to an empty store when persisted JSON is corrupt', () => {
    const firstStore = new CompanyTaskStore({ workspaceRoot: workspace, storageDir });
    firstStore.create({
      title: 'Bozulacak görev',
      description: 'Corrupt state fallback',
      assignee: 'reviewer',
    });

    const [stateFile] = fs.readdirSync(storageDir);
    expect(stateFile).toBeTruthy();
    fs.writeFileSync(path.join(storageDir, stateFile!), '{not-json', 'utf8');

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const restoredStore = new CompanyTaskStore({ workspaceRoot: workspace, storageDir });

    expect(restoredStore.list()).toEqual([]);
    expect(errorSpy).toHaveBeenCalled();

    const next = restoredStore.create({
      title: 'Yeni görev',
      description: 'Fallback sonrası',
      assignee: 'developer',
    });
    expect(next.id).toBe('task-1');
  });

  it('keeps different workspaces in separate persisted state files', () => {
    const otherWorkspace = path.join(root, 'other-workspace');
    fs.mkdirSync(otherWorkspace, { recursive: true });

    const firstStore = new CompanyTaskStore({ workspaceRoot: workspace, storageDir });
    firstStore.create({
      title: 'Workspace A',
      description: 'A görevi',
      assignee: 'developer',
    });

    const secondStore = new CompanyTaskStore({
      workspaceRoot: otherWorkspace,
      storageDir,
    });
    secondStore.create({
      title: 'Workspace B',
      description: 'B görevi',
      assignee: 'tester',
    });

    expect(fs.readdirSync(storageDir).filter((name) => name.endsWith('.json'))).toHaveLength(2);
    expect(new CompanyTaskStore({ workspaceRoot: workspace, storageDir }).list()[0]?.title).toBe(
      'Workspace A',
    );
    expect(
      new CompanyTaskStore({ workspaceRoot: otherWorkspace, storageDir }).list()[0]?.title,
    ).toBe('Workspace B');
  });
});
