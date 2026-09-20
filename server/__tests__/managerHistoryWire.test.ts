import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import {
  type ClientMessageContext,
  handleClientMessage,
} from '../src/clientMessageHandler.js';
import { CompanyTaskStore } from '../src/company/companyTaskStore.js';
import { buildManagerHistory } from '../src/company/managerHistory.js';

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

describe('Manager history snapshot', () => {
  it('groups sessions, tasks, and runs without exposing worker input', () => {
    const store = new CompanyTaskStore();
    const session = store.createSession('Kullanıcı isteği');
    const task = store.create(
      {
        title: 'Görev',
        description: 'Açıklama',
        assignee: 'Developer',
      },
      session.id,
    );
    const run = store.startRun(task.id, 'SECRET_WORKER_INPUT');
    store.updateRun(run.id, {
      status: 'completed',
      result: 'Tamamlandı',
    });
    store.updateSession(session.id, {
      status: 'completed',
      finalResponse: 'Final cevap',
    });

    const history = buildManagerHistory(store);

    expect(history).toEqual([
      expect.objectContaining({
        id: 'session-1',
        userRequest: 'Kullanıcı isteği',
        status: 'completed',
        finalResponse: 'Final cevap',
        tasks: [
          expect.objectContaining({
            id: 'task-1',
            assignee: 'developer',
            status: 'completed',
            runs: [
              expect.objectContaining({
                id: 'run-1',
                attempt: 1,
                status: 'completed',
                result: 'Tamamlandı',
              }),
            ],
          }),
        ],
      }),
    ]);
    expect(JSON.stringify(history)).not.toContain('SECRET_WORKER_INPUT');
    expect(JSON.stringify(history)).not.toContain('Açıklama');
  });
});

describe('Manager history WebSocket wire', () => {
  let tempHome: string;
  let originalHome: string | undefined;
  let agentStore: AgentStateStore;
  let sent: Array<Record<string, unknown>>;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-manager-history-'));
    originalHome = process.env.HOME;
    process.env.HOME = tempHome;
    agentStore = new AgentStateStore();
    sent = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    agentStore.dispose();
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  function baseContext(overrides: Partial<ClientMessageContext> = {}): ClientMessageContext {
    return {
      store: agentStore,
      cache: null,
      ...overrides,
    };
  }

  const history = [
    {
      id: 'session-1',
      userRequest: 'Bir görev yap',
      status: 'failed',
      createdAt: 1,
      tasks: [
        {
          id: 'task-1',
          title: 'Görev',
          assignee: 'developer',
          status: 'failed',
          error: 'İlk deneme çöktü',
          runs: [
            {
              id: 'run-1',
              attempt: 1,
              status: 'failed',
              error: 'İlk deneme çöktü',
              createdAt: 2,
            },
          ],
        },
      ],
    },
  ];

  it('sends Manager history on webviewReady only to a privileged client', () => {
    const getManagerHistory = vi.fn(() => history);

    handleClientMessage(
      { type: 'webviewReady' },
      (message) => sent.push(message),
      baseContext({ privileged: true, getManagerHistory }),
    );

    expect(sent.find((message) => message.type === 'managerHistory')).toEqual({
      type: 'managerHistory',
      sessions: history,
    });
    expect(getManagerHistory).toHaveBeenCalledTimes(1);

    sent = [];
    getManagerHistory.mockClear();

    handleClientMessage(
      { type: 'webviewReady' },
      (message) => sent.push(message),
      baseContext({ privileged: false, getManagerHistory }),
    );

    expect(sent.some((message) => message.type === 'managerHistory')).toBe(false);
    expect(getManagerHistory).not.toHaveBeenCalled();
  });

  it('sends refreshed history after a normal Manager task completes', async () => {
    const onRunManagerTask = vi.fn().mockResolvedValue('Manager tamamladı');
    const getManagerHistory = vi.fn(() => history);

    handleClientMessage(
      {
        type: 'managerTask',
        requestId: 'request-1',
        task: 'Bir görev yap',
      },
      (message) => sent.push(message),
      baseContext({
        privileged: true,
        onRunManagerTask,
        getManagerHistory,
      }),
    );

    await settle();

    expect(onRunManagerTask).toHaveBeenCalledWith('Bir görev yap');
    expect(sent).toContainEqual({
      type: 'managerTaskResult',
      requestId: 'request-1',
      ok: true,
      response: 'Manager tamamladı',
    });
    expect(sent).toContainEqual({
      type: 'managerHistory',
      sessions: history,
    });
  });

  it('retries a failed task and sends refreshed history to a privileged client', async () => {
    const onRetryManagerTask = vi.fn().mockResolvedValue('Retry tamamlandı');
    const getManagerHistory = vi.fn(() => history);

    handleClientMessage(
      {
        type: 'managerRetryTask',
        requestId: 'retry-1',
        taskId: 'task-1',
      },
      (message) => sent.push(message),
      baseContext({
        privileged: true,
        onRetryManagerTask,
        getManagerHistory,
      }),
    );

    await settle();

    expect(onRetryManagerTask).toHaveBeenCalledWith('task-1');
    expect(sent).toContainEqual({
      type: 'managerTaskResult',
      requestId: 'retry-1',
      ok: true,
      response: 'Retry tamamlandı',
    });
    expect(sent).toContainEqual({
      type: 'managerHistory',
      sessions: history,
    });
  });

  it('rejects retry from an unprivileged client without exposing history', async () => {
    const onRetryManagerTask = vi.fn().mockResolvedValue('olmamalı');
    const getManagerHistory = vi.fn(() => history);

    handleClientMessage(
      {
        type: 'managerRetryTask',
        requestId: 'retry-2',
        taskId: 'task-1',
      },
      (message) => sent.push(message),
      baseContext({
        privileged: false,
        onRetryManagerTask,
        getManagerHistory,
      }),
    );

    await settle();

    expect(onRetryManagerTask).not.toHaveBeenCalled();
    expect(getManagerHistory).not.toHaveBeenCalled();
    expect(sent).toEqual([
      {
        type: 'managerTaskResult',
        requestId: 'retry-2',
        ok: false,
        error: 'This Manager session requires the tokened local URL.',
      },
    ]);
  });
});
