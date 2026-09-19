import { describe, expect, it, vi } from 'vitest';

import { CompanyTaskStore } from '../src/company/companyTaskStore.js';
import { ManagerDispatcher } from '../src/company/managerDispatcher.js';
import { WorkerRegistry } from '../src/company/workerRegistry.js';
import type { ManagerWorker } from '../src/workers/managerWorker.js';

function response(content: string) {
  return {
    model: 'test-model',
    content,
  };
}

describe('ManagerDispatcher company history', () => {
  it('links one manager request to a session, tasks, and exact worker runs', async () => {
    const developerRun = vi.fn().mockResolvedValue(response('Kod tamamlandı'));
    const testerRun = vi.fn().mockResolvedValue(response('Testler geçti'));

    const manager = {
      plan: vi.fn().mockResolvedValue(
        response(
          JSON.stringify({
            tasks: [
              {
                title: 'Kodu düzelt',
                description: 'Gerekli kod değişikliğini yap',
                assignee: 'developer',
              },
              {
                title: 'Test et',
                description: 'Developer sonucunu doğrula',
                assignee: 'tester',
              },
            ],
          }),
        ),
      ),
      run: vi.fn(),
      summarize: vi.fn().mockResolvedValue(response('Şirket işi tamamladı')),
    } as unknown as ManagerWorker;

    const registry = new WorkerRegistry();
    registry.register({
      role: 'developer',
      displayName: 'Developer',
      agentId: 100_002,
      run: developerRun,
    });
    registry.register({
      role: 'tester',
      displayName: 'Tester',
      agentId: 100_003,
      run: testerRun,
    });

    const store = new CompanyTaskStore();
    const dispatcher = new ManagerDispatcher(manager, registry, store);
    const userRequest = 'Login hatasını düzelt ve test et';

    await expect(dispatcher.run(userRequest)).resolves.toBe('Şirket işi tamamladı');

    expect(store.listSessions()).toEqual([
      expect.objectContaining({
        id: 'session-1',
        userRequest,
        status: 'completed',
        finalResponse: 'Şirket işi tamamladı',
      }),
    ]);

    expect(store.list()).toEqual([
      expect.objectContaining({
        id: 'task-1',
        sessionId: 'session-1',
        assignee: 'developer',
        status: 'completed',
        result: 'Kod tamamlandı',
      }),
      expect.objectContaining({
        id: 'task-2',
        sessionId: 'session-1',
        assignee: 'tester',
        status: 'completed',
        result: 'Testler geçti',
      }),
    ]);

    const runs = store.listRuns();
    expect(runs).toHaveLength(2);
    expect(runs[0]).toEqual(
      expect.objectContaining({
        id: 'run-1',
        taskId: 'task-1',
        attempt: 1,
        status: 'completed',
        result: 'Kod tamamlandı',
      }),
    );
    expect(runs[0]?.input).toContain(`Original user request:\n${userRequest}`);
    expect(runs[1]).toEqual(
      expect.objectContaining({
        id: 'run-2',
        taskId: 'task-2',
        attempt: 1,
        status: 'completed',
        result: 'Testler geçti',
      }),
    );
    expect(runs[1]?.input).toContain('[developer] Kodu düzelt:\nKod tamamlandı');
    expect(developerRun).toHaveBeenCalledWith(runs[0]?.input);
    expect(testerRun).toHaveBeenCalledWith(runs[1]?.input);
  });

  it('persists a completed session even when the manager answers directly', async () => {
    const manager = {
      plan: vi.fn().mockResolvedValue(
        response(
          JSON.stringify({
            reply: 'Doğrudan cevap',
            tasks: [],
          }),
        ),
      ),
      run: vi.fn(),
      summarize: vi.fn(),
    } as unknown as ManagerWorker;

    const store = new CompanyTaskStore();
    const dispatcher = new ManagerDispatcher(manager, new WorkerRegistry(), store);

    await expect(dispatcher.run('Basit soru')).resolves.toBe('Doğrudan cevap');

    expect(store.list()).toEqual([]);
    expect(store.listRuns()).toEqual([]);
    expect(store.listSessions()).toEqual([
      expect.objectContaining({
        id: 'session-1',
        userRequest: 'Basit soru',
        status: 'completed',
        finalResponse: 'Doğrudan cevap',
      }),
    ]);
    expect(manager.run).not.toHaveBeenCalled();
  });

  it('keeps a failed worker run and marks the session failed after the manager reports it', async () => {
    const developerRun = vi.fn().mockRejectedValue(new Error('Worker çöktü'));
    const manager = {
      plan: vi.fn().mockResolvedValue(
        response(
          JSON.stringify({
            tasks: [
              {
                title: 'Kodu düzelt',
                description: 'Değişikliği yap',
                assignee: 'developer',
              },
            ],
          }),
        ),
      ),
      run: vi.fn(),
      summarize: vi.fn().mockResolvedValue(response('Developer görevi başarısız oldu')),
    } as unknown as ManagerWorker;

    const registry = new WorkerRegistry();
    registry.register({
      role: 'developer',
      displayName: 'Developer',
      agentId: 100_002,
      run: developerRun,
    });

    const store = new CompanyTaskStore();
    const dispatcher = new ManagerDispatcher(manager, registry, store);

    await expect(dispatcher.run('Bir değişiklik yap')).resolves.toBe(
      'Developer görevi başarısız oldu',
    );

    expect(store.listRuns()).toEqual([
      expect.objectContaining({
        taskId: 'task-1',
        attempt: 1,
        status: 'failed',
        error: 'Worker çöktü',
      }),
    ]);
    expect(store.list()[0]).toEqual(
      expect.objectContaining({
        sessionId: 'session-1',
        status: 'failed',
        error: 'Worker çöktü',
      }),
    );
    expect(store.listSessions()[0]).toEqual(
      expect.objectContaining({
        status: 'failed',
        finalResponse: 'Developer görevi başarısız oldu',
      }),
    );
  });
});
