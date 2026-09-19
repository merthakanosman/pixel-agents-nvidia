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
    expect(first.sessionId).toBeNull();
    expect(fs.readdirSync(storageDir)).toHaveLength(1);
    expect(fs.readdirSync(storageDir).some((name) => name.endsWith('.tmp'))).toBe(false);

    const restoredStore = new CompanyTaskStore({ workspaceRoot: workspace, storageDir });
    expect(restoredStore.list()).toEqual([
      expect.objectContaining({
        id: 'task-1',
        sessionId: null,
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

  it('marks running tasks and runs as failed when the process restarts', () => {
    const firstStore = new CompanyTaskStore({ workspaceRoot: workspace, storageDir });
    const task = firstStore.create({
      title: 'Yarım kalan görev',
      description: 'Restart recovery',
      assignee: 'developer',
    });
    firstStore.update(task.id, { status: 'running' });

    expect(firstStore.listRuns()).toEqual([
      expect.objectContaining({
        taskId: task.id,
        attempt: 1,
        status: 'running',
        input: null,
      }),
    ]);

    const restoredStore = new CompanyTaskStore({ workspaceRoot: workspace, storageDir });
    const restored = restoredStore.list()[0];

    expect(restored).toEqual(
      expect.objectContaining({
        id: 'task-1',
        status: 'failed',
        error: 'Process restarted before task completed.',
      }),
    );
    expect(restoredStore.listRuns()[0]).toEqual(
      expect.objectContaining({
        taskId: 'task-1',
        status: 'failed',
        error: 'Process restarted before task completed.',
      }),
    );

    const reloadedAgain = new CompanyTaskStore({ workspaceRoot: workspace, storageDir });
    expect(reloadedAgain.list()[0]?.status).toBe('failed');
    expect(reloadedAgain.listRuns()[0]?.status).toBe('failed');
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
    expect(restoredStore.listSessions()).toEqual([]);
    expect(restoredStore.listRuns()).toEqual([]);
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

  it('stores sessions and preserves every retry as a separate run', () => {
    const store = new CompanyTaskStore({ workspaceRoot: workspace, storageDir });
    const session = store.createSession('Login hatasını düzelt ve test et');
    const task = store.create(
      {
        title: 'Login hatasını düzelt',
        description: 'Login akışındaki hatayı gider',
        assignee: 'Developer',
      },
      session.id,
    );

    const firstRun = store.startRun(task.id, 'İlk worker promptu');
    store.updateRun(firstRun.id, {
      status: 'failed',
      error: 'İlk deneme başarısız',
    });

    const secondRun = store.startRun(task.id, 'İkinci worker promptu');
    store.updateRun(secondRun.id, {
      status: 'completed',
      result: 'Düzeltme tamamlandı',
    });
    store.updateSession(session.id, {
      status: 'completed',
      finalResponse: 'İş tamamlandı',
    });

    expect(store.listSessions()).toEqual([
      expect.objectContaining({
        id: 'session-1',
        userRequest: 'Login hatasını düzelt ve test et',
        status: 'completed',
        finalResponse: 'İş tamamlandı',
      }),
    ]);
    expect(store.list()[0]).toEqual(
      expect.objectContaining({
        sessionId: 'session-1',
        status: 'completed',
        result: 'Düzeltme tamamlandı',
      }),
    );
    expect(store.listRuns()).toEqual([
      expect.objectContaining({
        id: 'run-1',
        taskId: 'task-1',
        attempt: 1,
        status: 'failed',
        input: 'İlk worker promptu',
        error: 'İlk deneme başarısız',
      }),
      expect.objectContaining({
        id: 'run-2',
        taskId: 'task-1',
        attempt: 2,
        status: 'completed',
        input: 'İkinci worker promptu',
        result: 'Düzeltme tamamlandı',
      }),
    ]);

    const restored = new CompanyTaskStore({ workspaceRoot: workspace, storageDir });
    expect(restored.listSessions()[0]?.id).toBe('session-1');
    expect(restored.listRuns()).toHaveLength(2);
    expect(restored.createSession('Sonraki istek').id).toBe('session-2');
    expect(
      restored.create({
        title: 'Sonraki görev',
        description: 'Task id devamlılığı',
        assignee: 'tester',
      }).id,
    ).toBe('task-2');
  });

  it('migrates v1 task history into a legacy session without inventing user input', () => {
    const bootstrap = new CompanyTaskStore({ workspaceRoot: workspace, storageDir });
    bootstrap.create({
      title: 'Yer tutucu',
      description: 'State dosyasını oluştur',
      assignee: 'developer',
    });

    const [stateFile] = fs.readdirSync(storageDir).filter((name) => name.endsWith('.json'));
    expect(stateFile).toBeTruthy();

    fs.writeFileSync(
      path.join(storageDir, stateFile!),
      JSON.stringify(
        {
          version: 1,
          nextId: 8,
          tasks: [
            {
              id: 'task-7',
              title: 'Eski görev',
              description: 'v1 geçmişi',
              assignee: 'Developer',
              status: 'completed',
              result: 'Eski sonuç',
              createdAt: 100,
              updatedAt: 200,
            },
          ],
        },
        null,
        2,
      ),
      'utf8',
    );

    const migrated = new CompanyTaskStore({ workspaceRoot: workspace, storageDir });

    expect(migrated.listSessions()).toEqual([
      {
        id: 'session-legacy',
        userRequest: null,
        status: 'completed',
        createdAt: 100,
        updatedAt: 200,
      },
    ]);
    expect(migrated.list()).toEqual([
      expect.objectContaining({
        id: 'task-7',
        sessionId: 'session-legacy',
        status: 'completed',
        result: 'Eski sonuç',
      }),
    ]);
    expect(migrated.listRuns()).toEqual([
      expect.objectContaining({
        id: 'run-1',
        taskId: 'task-7',
        attempt: 1,
        input: null,
        status: 'completed',
        result: 'Eski sonuç',
      }),
    ]);

    const persisted = JSON.parse(fs.readFileSync(path.join(storageDir, stateFile!), 'utf8')) as {
      version: number;
      nextSessionId: number;
      nextTaskId: number;
      nextRunId: number;
    };
    expect(persisted).toEqual(
      expect.objectContaining({
        version: 2,
        nextSessionId: 1,
        nextTaskId: 8,
        nextRunId: 2,
      }),
    );

    expect(
      migrated.create({
        title: 'Yeni görev',
        description: 'Migration sonrası id',
        assignee: 'tester',
      }).id,
    ).toBe('task-8');
    expect(migrated.createSession('Yeni kullanıcı isteği').id).toBe('session-1');
  });
});
