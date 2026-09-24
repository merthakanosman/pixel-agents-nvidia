import { describe, expect, it, vi } from 'vitest';

import { CommerceStore } from '../src/commerce/commerceStore.js';
import {
  CommerceTools,
  type CommercePaymentGateway,
  type CommerceShippingQuoteProvider,
} from '../src/commerce/commerceTools.js';

function createHarness() {
  const store = new CommerceStore();
  const product = store.createProduct({
    sku: 'SKU-1',
    name: 'Test ürünü',
    description: 'Satış ürünü',
    price: { amountMinor: 149_900, currency: 'TRY' },
    stockQuantity: 5,
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

  const shipping: CommerceShippingQuoteProvider = {
    quote: vi.fn().mockResolvedValue({ amountMinor: 10_000, currency: 'TRY' }),
  };
  const paymentGateway: CommercePaymentGateway = {
    createCheckout: vi.fn().mockResolvedValue({
      provider: 'test-gateway',
      externalReference: 'payment-ext-1',
      checkoutUrl: 'https://payments.example.test/checkout/1',
    }),
  };

  const tools = new CommerceTools(store, {
    shipping,
    paymentGateway,
    now: () => 1_000,
  });

  return { store, tools, product, customer, conversation, shipping, paymentGateway };
}

describe('CommerceTools', () => {
  it('reads product, stock, customer, and conversation context from the store', async () => {
    const { store, tools, product, customer, conversation } = createHarness();
    store.createMessage({
      conversationId: conversation.id,
      direction: 'inbound',
      author: 'customer',
      text: 'Fiyat nedir?',
      instagramMessageId: 'ig-message-1',
    });

    await expect(
      tools.execute({ action: 'get_product', sku: product.sku }),
    ).resolves.toEqual({
      ok: true,
      action: 'get_product',
      data: product,
    });

    await expect(
      tools.execute({ action: 'get_stock', productId: product.id }),
    ).resolves.toEqual({
      ok: true,
      action: 'get_stock',
      data: {
        productId: product.id,
        sku: product.sku,
        active: true,
        stockQuantity: 5,
      },
    });

    await expect(
      tools.execute({
        action: 'get_customer',
        instagramUserId: customer.instagramUserId,
      }),
    ).resolves.toEqual({
      ok: true,
      action: 'get_customer',
      data: customer,
    });

    const context = await tools.execute({
      action: 'get_conversation',
      conversationId: conversation.id,
    });
    expect(context).toEqual(
      expect.objectContaining({
        ok: true,
        action: 'get_conversation',
        data: expect.objectContaining({
          conversation: expect.objectContaining({ id: conversation.id }),
          customer: expect.objectContaining({ id: customer.id }),
          messages: [
            expect.objectContaining({
              text: 'Fiyat nedir?',
              author: 'customer',
            }),
          ],
        }),
      }),
    );
  });

  it('creates a lead and updates its sales state without allowing sold', async () => {
    const { store, tools, product, customer, conversation } = createHarness();

    const created = await tools.execute({
      action: 'create_lead',
      customerId: customer.id,
      conversationId: conversation.id,
      productId: product.id,
      quantity: 2,
    });
    expect(created).toEqual(
      expect.objectContaining({
        ok: true,
        data: expect.objectContaining({
          id: 'lead-1',
          stage: 'new_lead',
          quantity: 2,
        }),
      }),
    );

    await expect(
      tools.execute({
        action: 'update_lead',
        leadId: 'lead-1',
        stage: 'ready_to_buy',
        objections: [],
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        data: expect.objectContaining({
          id: 'lead-1',
          stage: 'ready_to_buy',
        }),
      }),
    );

    const sold = await tools.execute({
      action: 'update_lead',
      leadId: 'lead-1',
      stage: 'sold',
    });
    expect(sold).toEqual({
      ok: false,
      action: 'update_lead',
      error: 'Sales Agent cannot mark a lead sold; confirmed payment event is required.',
    });
    expect(store.getLead('lead-1')?.stage).toBe('ready_to_buy');
  });

  it('creates an order from stored prices and a deterministic shipping quote', async () => {
    const { store, tools, product, customer, conversation, shipping } = createHarness();
    const lead = store.createLead({
      customerId: customer.id,
      conversationId: conversation.id,
      productId: product.id,
      stage: 'ready_to_buy',
      quantity: 2,
      objections: [],
    });

    const result = await tools.execute({
      action: 'create_order',
      leadId: lead.id,
      items: [{ productId: product.id, quantity: 2 }],
    });

    expect(shipping.quote).toHaveBeenCalledTimes(1);
    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        action: 'create_order',
        data: expect.objectContaining({
          id: 'order-1',
          status: 'draft',
          subtotal: { amountMinor: 299_800, currency: 'TRY' },
          shipping: { amountMinor: 10_000, currency: 'TRY' },
          total: { amountMinor: 309_800, currency: 'TRY' },
        }),
      }),
    );
    expect(store.getLead(lead.id)?.stage).toBe('order_details');
  });

  it('rejects order quantity above real stock before creating an order', async () => {
    const { store, tools, product, customer, conversation } = createHarness();
    const lead = store.createLead({
      customerId: customer.id,
      conversationId: conversation.id,
      productId: product.id,
      stage: 'ready_to_buy',
      objections: [],
    });

    const result = await tools.execute({
      action: 'create_order',
      leadId: lead.id,
      items: [{ productId: product.id, quantity: 6 }],
    });

    expect(result).toEqual({
      ok: false,
      action: 'create_order',
      error: 'Insufficient stock for product-1: requested 6, available 5',
    });
    expect(store.listOrders()).toEqual([]);
    expect(store.getLead(lead.id)?.stage).toBe('ready_to_buy');

    const duplicateLines = await tools.execute({
      action: 'create_order',
      leadId: lead.id,
      items: [
        { productId: product.id, quantity: 3 },
        { productId: product.id, quantity: 3 },
      ],
    });
    expect(duplicateLines).toEqual({
      ok: false,
      action: 'create_order',
      error: 'Insufficient stock for product-1: requested 6, available 5',
    });
    expect(store.listOrders()).toEqual([]);
  });

  it('creates payment data only from the configured gateway and advances the funnel', async () => {
    const { store, tools, product, customer, conversation, paymentGateway } = createHarness();
    const lead = store.createLead({
      customerId: customer.id,
      conversationId: conversation.id,
      productId: product.id,
      stage: 'ready_to_buy',
      quantity: 1,
      objections: [],
    });

    const orderResult = await tools.execute({
      action: 'create_order',
      leadId: lead.id,
      items: [{ productId: product.id, quantity: 1 }],
    });
    expect(orderResult.ok).toBe(true);

    const paymentResult = await tools.execute({
      action: 'create_payment',
      orderId: 'order-1',
    });

    expect(paymentGateway.createCheckout).toHaveBeenCalledTimes(1);
    expect(paymentResult).toEqual(
      expect.objectContaining({
        ok: true,
        action: 'create_payment',
        data: expect.objectContaining({
          payment: expect.objectContaining({
            id: 'payment-1',
            provider: 'test-gateway',
            status: 'pending',
            amount: { amountMinor: 159_900, currency: 'TRY' },
            externalReference: 'payment-ext-1',
            checkoutUrl: 'https://payments.example.test/checkout/1',
          }),
          order: expect.objectContaining({
            id: 'order-1',
            status: 'awaiting_payment',
          }),
          lead: expect.objectContaining({
            id: lead.id,
            stage: 'payment_pending',
          }),
        }),
      }),
    );
  });

  it('rejects an unsafe payment checkout URL without persisting payment state', async () => {
    const { store, tools, product, customer, conversation, paymentGateway } = createHarness();
    vi.mocked(paymentGateway.createCheckout).mockResolvedValueOnce({
      provider: 'test-gateway',
      externalReference: 'payment-ext-unsafe',
      checkoutUrl: 'http://payments.example.test/unsafe',
    });

    const lead = store.createLead({
      customerId: customer.id,
      conversationId: conversation.id,
      productId: product.id,
      stage: 'ready_to_buy',
      objections: [],
    });
    await tools.execute({
      action: 'create_order',
      leadId: lead.id,
      items: [{ productId: product.id, quantity: 1 }],
    });

    const result = await tools.execute({
      action: 'create_payment',
      orderId: 'order-1',
    });

    expect(result).toEqual({
      ok: false,
      action: 'create_payment',
      error: 'Payment checkout URL must use HTTPS.',
    });
    expect(store.listPayments()).toEqual([]);
    expect(store.getOrder('order-1')?.status).toBe('draft');
    expect(store.getLead(lead.id)?.stage).toBe('order_details');
  });

  it('schedules future follow-up and moves the lead into follow_up', async () => {
    const { store, tools, product, customer, conversation } = createHarness();
    const lead = store.createLead({
      customerId: customer.id,
      conversationId: conversation.id,
      productId: product.id,
      stage: 'interested',
      objections: [],
    });

    const result = await tools.execute({
      action: 'schedule_followup',
      leadId: lead.id,
      scheduledAt: 2_000,
      reason: 'Müşteriye yeniden yaz',
    });

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        action: 'schedule_followup',
        data: expect.objectContaining({
          followUp: expect.objectContaining({
            id: 'followup-1',
            status: 'scheduled',
            scheduledAt: 2_000,
          }),
          lead: expect.objectContaining({
            stage: 'follow_up',
          }),
        }),
      }),
    );

    const past = await tools.execute({
      action: 'schedule_followup',
      leadId: lead.id,
      scheduledAt: 999,
      reason: 'Geçmiş zaman',
    });
    expect(past).toEqual({
      ok: false,
      action: 'schedule_followup',
      error: 'Follow-up must be scheduled in the future.',
    });
  });

  it('hands the lead to a human and synchronizes conversation status', async () => {
    const { store, tools, product, customer, conversation } = createHarness();
    const lead = store.createLead({
      customerId: customer.id,
      conversationId: conversation.id,
      productId: product.id,
      stage: 'objection',
      objections: ['Özel indirim istiyor'],
    });

    const result = await tools.execute({
      action: 'handoff_to_human',
      leadId: lead.id,
    });

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        action: 'handoff_to_human',
        data: expect.objectContaining({
          lead: expect.objectContaining({ stage: 'human_handoff' }),
          conversation: expect.objectContaining({ status: 'handoff' }),
        }),
      }),
    );
    expect(store.getConversation(conversation.id)?.status).toBe('handoff');
  });
});
