import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import {
  type ClientMessageContext,
  handleClientMessage,
} from '../src/clientMessageHandler.js';

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

describe('Sales simulator WebSocket wire', () => {
  let tempHome: string;
  let originalHome: string | undefined;
  let agentStore: AgentStateStore;
  let sent: Array<Record<string, unknown>>;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-sales-simulator-wire-'));
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

  function context(overrides: Partial<ClientMessageContext> = {}): ClientMessageContext {
    return {
      store: agentStore,
      cache: null,
      ...overrides,
    };
  }

  it('routes a privileged sandbox DM and returns conversation state', async () => {
    const onRunSalesSimulator = vi.fn().mockResolvedValue({
      customerId: 'customer-1',
      conversationId: 'conversation-1',
      response: 'Merhaba, yardımcı olayım.',
      leadStage: 'interested',
      orderStatus: 'draft',
      paymentStatus: 'pending',
      messages: [
        {
          id: 'message-1',
          conversationId: 'conversation-1',
          direction: 'inbound',
          author: 'customer',
          text: 'Merhaba',
          createdAt: 1,
        },
        {
          id: 'message-2',
          conversationId: 'conversation-1',
          direction: 'outbound',
          author: 'sales_agent',
          text: 'Merhaba, yardımcı olayım.',
          createdAt: 2,
        },
      ],
    });

    handleClientMessage(
      {
        type: 'salesSimulatorMessage',
        requestId: 'request-1',
        instagramUserId: 'ig-user-1',
        username: 'musteri',
        message: 'Merhaba',
        messageId: 'local-msg-1',
      },
      (message) => sent.push(message),
      context({ privileged: true, onRunSalesSimulator }),
    );

    await settle();

    expect(onRunSalesSimulator).toHaveBeenCalledWith({
      instagramUserId: 'ig-user-1',
      username: 'musteri',
      message: 'Merhaba',
      messageId: 'local-msg-1',
    });
    expect(sent).toEqual([
      {
        type: 'salesSimulatorResult',
        requestId: 'request-1',
        ok: true,
        sandbox: true,
        response: 'Merhaba, yardımcı olayım.',
        customerId: 'customer-1',
        conversationId: 'conversation-1',
        leadStage: 'interested',
        orderStatus: 'draft',
        paymentStatus: 'pending',
        messages: [
          {
            id: 'message-1',
            direction: 'inbound',
            author: 'customer',
            text: 'Merhaba',
            createdAt: 1,
          },
          {
            id: 'message-2',
            direction: 'outbound',
            author: 'sales_agent',
            text: 'Merhaba, yardımcı olayım.',
            createdAt: 2,
          },
        ],
      },
    ]);
  });

  it('rejects simulator writes from an unprivileged client', async () => {
    const onRunSalesSimulator = vi.fn();

    handleClientMessage(
      {
        type: 'salesSimulatorMessage',
        requestId: 'request-2',
        instagramUserId: 'ig-user-1',
        message: 'Merhaba',
      },
      (message) => sent.push(message),
      context({ privileged: false, onRunSalesSimulator }),
    );

    await settle();

    expect(onRunSalesSimulator).not.toHaveBeenCalled();
    expect(sent).toEqual([
      {
        type: 'salesSimulatorResult',
        requestId: 'request-2',
        ok: false,
        sandbox: true,
        error: 'Sales simulator requires the tokened local URL.',
      },
    ]);
  });

  it('validates empty and oversized customer messages before invoking Sales Agent', () => {
    const onRunSalesSimulator = vi.fn();

    handleClientMessage(
      {
        type: 'salesSimulatorMessage',
        requestId: 'request-empty',
        instagramUserId: 'ig-user-1',
        message: '   ',
      },
      (message) => sent.push(message),
      context({ privileged: true, onRunSalesSimulator }),
    );

    handleClientMessage(
      {
        type: 'salesSimulatorMessage',
        requestId: 'request-long',
        instagramUserId: 'ig-user-1',
        message: 'x'.repeat(4_001),
      },
      (message) => sent.push(message),
      context({ privileged: true, onRunSalesSimulator }),
    );

    expect(onRunSalesSimulator).not.toHaveBeenCalled();
    expect(sent).toEqual([
      {
        type: 'salesSimulatorResult',
        requestId: 'request-empty',
        ok: false,
        sandbox: true,
        error: 'Message cannot be empty.',
      },
      {
        type: 'salesSimulatorResult',
        requestId: 'request-long',
        ok: false,
        sandbox: true,
        error: 'Message is too long. Maximum length is 4000 characters.',
      },
    ]);
  });
});
