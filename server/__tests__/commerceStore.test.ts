import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CommerceStore } from '../src/commerce/commerceStore.js';

describe('CommerceStore persistence', () => {
  let root: string;
  let workspace: string;
  let storageDir: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-agents-commerce-store-'));
    workspace = path.join(root, 'workspace');
    storageDir = path.join(root, 'commerce-state');
    fs.mkdirSync(workspace, { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function seedCommerce(store: CommerceStore) {
    const product = store.createProduct({
      sku: 'SKU-1',
      name: 'Test ürünü',
      description: 'Satış ürünü',
      price: { amountMinor: 149_900, currency: 'TRY' },
      stockQuantity: 20,
      active: true,
    });
    const customer = store.createCustomer({
      instagramUserId: 'ig-user-1',
      username: 'musteri',
    });
    const conversation = store.createConversation({
      customerId: customer.id,
      status: 'open',
    });
    const message = store.createMessage({
      conversationId: conversation.id,
      direction: 'inbound',
      author: 'customer',
      text: '2 tane almak istiyorum',
      instagramMessageId: 'ig-message-1',
    });
    const lead = store.createLead({
      customerId: customer.id,
      conversationId: conversation.id,
      productId: product.id,
      stage: 'ready_to_buy',
      quantity: 2,
      objections: [],
    });
    const order = store.createOrder({
      customerId: customer.id,
      leadId: lead.id,
      items: [
        {
          productId: product.id,
          quantity: 2,
          unitPrice: { amountMinor: 149_900, currency: 'TRY' },
        },
      ],
      subtotal: { amountMinor: 299_800, currency: 'TRY' },
      shipping: { amountMinor: 0, currency: 'TRY' },
      total: { amountMinor: 299_800, currency: 'TRY' },
      status: 'awaiting_payment',
    });
    const payment = store.createPayment({
      orderId: order.id,
      provider: 'test',
      status: 'pending',
      amount: { amountMinor: 299_800, currency: 'TRY' },
      checkoutUrl: 'https://example.test/pay',
    });
    const followUp = store.createFollowUp({
      customerId: customer.id,
      conversationId: conversation.id,
      leadId: lead.id,
      scheduledAt: 123_456,
      reason: 'Ödeme hatırlatma',
      status: 'scheduled',
    });

    return { product, customer, conversation, message, lead, order, payment, followUp };
  }

  it('persists the full commerce graph and restores it after restart', () => {
    const firstStore = new CommerceStore({ workspaceRoot: workspace, storageDir });
    const seeded = seedCommerce(firstStore);

    expect(fs.readdirSync(storageDir).filter((name) => name.endsWith('.json'))).toHaveLength(1);
    expect(fs.readdirSync(storageDir).some((name) => name.endsWith('.tmp'))).toBe(false);

    const restored = new CommerceStore({ workspaceRoot: workspace, storageDir });

    expect(restored.listProducts()).toEqual([seeded.product]);
    expect(restored.listCustomers()).toEqual([seeded.customer]);
    expect(restored.listConversations()).toEqual([
      expect.objectContaining({
        id: seeded.conversation.id,
        customerId: seeded.customer.id,
        activeLeadId: seeded.lead.id,
        activeOrderId: seeded.order.id,
      }),
    ]);
    expect(restored.listMessages()).toEqual([seeded.message]);
    expect(restored.listLeads()).toEqual([seeded.lead]);
    expect(restored.listOrders()).toEqual([seeded.order]);
    expect(restored.listPayments()).toEqual([seeded.payment]);
    expect(restored.listFollowUps()).toEqual([seeded.followUp]);
  });

  it('continues every entity id sequence after restart', () => {
    const firstStore = new CommerceStore({ workspaceRoot: workspace, storageDir });
    seedCommerce(firstStore);

    const restored = new CommerceStore({ workspaceRoot: workspace, storageDir });

    expect(
      restored.createProduct({
        sku: 'SKU-2',
        name: 'İkinci ürün',
        description: 'İkinci ürün',
        price: { amountMinor: 100, currency: 'TRY' },
        stockQuantity: 1,
        active: true,
      }).id,
    ).toBe('product-2');
    expect(
      restored.createCustomer({
        instagramUserId: 'ig-user-2',
      }).id,
    ).toBe('customer-2');
  });

  it('keeps different workspaces in separate state files', () => {
    const otherWorkspace = path.join(root, 'other-workspace');
    fs.mkdirSync(otherWorkspace, { recursive: true });

    const first = new CommerceStore({ workspaceRoot: workspace, storageDir });
    first.createProduct({
      sku: 'A',
      name: 'Workspace A',
      description: 'A',
      price: { amountMinor: 100, currency: 'TRY' },
      stockQuantity: 1,
      active: true,
    });

    const second = new CommerceStore({ workspaceRoot: otherWorkspace, storageDir });
    second.createProduct({
      sku: 'B',
      name: 'Workspace B',
      description: 'B',
      price: { amountMinor: 200, currency: 'TRY' },
      stockQuantity: 2,
      active: true,
    });

    expect(fs.readdirSync(storageDir).filter((name) => name.endsWith('.json'))).toHaveLength(2);
    expect(new CommerceStore({ workspaceRoot: workspace, storageDir }).listProducts()[0]?.sku).toBe(
      'A',
    );
    expect(
      new CommerceStore({ workspaceRoot: otherWorkspace, storageDir }).listProducts()[0]?.sku,
    ).toBe('B');
  });

  it('rejects broken commerce relationships before persisting them', () => {
    const store = new CommerceStore({ workspaceRoot: workspace, storageDir });
    const product = store.createProduct({
      sku: 'SKU-1',
      name: 'Ürün',
      description: 'Ürün',
      price: { amountMinor: 100, currency: 'TRY' },
      stockQuantity: 1,
      active: true,
    });
    const customerA = store.createCustomer({ instagramUserId: 'ig-a' });
    const customerB = store.createCustomer({ instagramUserId: 'ig-b' });
    const conversation = store.createConversation({
      customerId: customerA.id,
      status: 'open',
    });

    expect(() =>
      store.createLead({
        customerId: customerB.id,
        conversationId: conversation.id,
        productId: product.id,
        stage: 'new_lead',
        objections: [],
      }),
    ).toThrow('Lead customer does not match conversation customer.');

    expect(store.listLeads()).toEqual([]);
  });

  it('routes lead stage updates through the sales state machine and persists conversation status', () => {
    const store = new CommerceStore({ workspaceRoot: workspace, storageDir });
    const { lead, conversation } = seedCommerce(store);

    const handoff = store.transitionLead(lead.id, 'human_handoff', { now: 500 });
    expect(handoff.stage).toBe('human_handoff');
    expect(store.getConversation(conversation.id)?.status).toBe('handoff');

    expect(() => store.transitionLead(lead.id, 'sold')).toThrow(
      'Cannot mark a lead as sold without confirmed payment.',
    );

    const sold = store.transitionLead(lead.id, 'sold', {
      now: 600,
      paymentConfirmed: true,
    });
    expect(sold.stage).toBe('sold');
    expect(store.getConversation(conversation.id)?.status).toBe('closed');

    const restored = new CommerceStore({ workspaceRoot: workspace, storageDir });
    expect(restored.getLead(lead.id)?.stage).toBe('sold');
    expect(restored.getConversation(conversation.id)?.status).toBe('closed');
  });

  it('enforces unique Instagram identities, message ids, and product SKUs', () => {
    const store = new CommerceStore({ workspaceRoot: workspace, storageDir });
    const seeded = seedCommerce(store);

    expect(() =>
      store.createCustomer({
        instagramUserId: seeded.customer.instagramUserId,
      }),
    ).toThrow('Instagram customer already exists');

    expect(() =>
      store.createProduct({
        sku: seeded.product.sku,
        name: 'Duplicate',
        description: 'Duplicate',
        price: { amountMinor: 100, currency: 'TRY' },
        stockQuantity: 1,
        active: true,
      }),
    ).toThrow('Product SKU already exists');

    expect(() =>
      store.createMessage({
        conversationId: seeded.conversation.id,
        direction: 'inbound',
        author: 'customer',
        text: 'duplicate',
        instagramMessageId: seeded.message.instagramMessageId,
      }),
    ).toThrow('Instagram message already exists');
  });

  it('falls back to an empty store when persisted JSON is corrupt', () => {
    const firstStore = new CommerceStore({ workspaceRoot: workspace, storageDir });
    firstStore.createCustomer({ instagramUserId: 'ig-user-1' });

    const [stateFile] = fs.readdirSync(storageDir).filter((name) => name.endsWith('.json'));
    expect(stateFile).toBeTruthy();
    fs.writeFileSync(path.join(storageDir, stateFile!), '{broken-json', 'utf8');

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const restored = new CommerceStore({ workspaceRoot: workspace, storageDir });

    expect(restored.listProducts()).toEqual([]);
    expect(restored.listCustomers()).toEqual([]);
    expect(restored.listConversations()).toEqual([]);
    expect(restored.listMessages()).toEqual([]);
    expect(restored.listLeads()).toEqual([]);
    expect(restored.listOrders()).toEqual([]);
    expect(restored.listPayments()).toEqual([]);
    expect(restored.listFollowUps()).toEqual([]);
    expect(errorSpy).toHaveBeenCalled();

    expect(restored.createCustomer({ instagramUserId: 'ig-new' }).id).toBe('customer-1');
  });
});
