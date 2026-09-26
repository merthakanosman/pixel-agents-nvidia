import { describe, expect, it, vi } from 'vitest';

import { CommerceStore } from '../src/commerce/commerceStore.js';
import { SalesConversationService } from '../src/commerce/salesConversationService.js';

describe('SalesConversationService', () => {
  it('creates customer and conversation once, then reuses them across messages', async () => {
    const store = new CommerceStore();
    const respond = vi.fn(async ({ conversationId, customerMessage }: {
      conversationId: string;
      customerMessage: string;
    }) => {
      store.createMessage({
        conversationId,
        direction: 'inbound',
        author: 'customer',
        text: customerMessage,
      });
      store.createMessage({
        conversationId,
        direction: 'outbound',
        author: 'sales_agent',
        text: `Yanıt: ${customerMessage}`,
      });
      return { content: `Yanıt: ${customerMessage}` };
    });
    const service = new SalesConversationService(store, { respond });

    const first = await service.handleMessage({
      instagramUserId: 'ig-1',
      username: 'musteri',
      message: 'Merhaba',
    });
    const second = await service.handleMessage({
      instagramUserId: 'ig-1',
      username: 'musteri-yeni',
      message: 'Fiyat nedir?',
    });

    expect(first.customerId).toBe('customer-1');
    expect(second.customerId).toBe('customer-1');
    expect(first.conversationId).toBe('conversation-1');
    expect(second.conversationId).toBe('conversation-1');
    expect(store.listCustomers()).toHaveLength(1);
    expect(store.listConversations()).toHaveLength(1);
    expect(store.getCustomer('customer-1')?.username).toBe('musteri-yeni');
    expect(second.messages).toHaveLength(4);
    expect(respond).toHaveBeenCalledTimes(2);
  });

  it('starts a new conversation after the prior one is closed', async () => {
    const store = new CommerceStore();
    const customer = store.createCustomer({ instagramUserId: 'ig-1' });
    const closed = store.createConversation({
      customerId: customer.id,
      status: 'closed',
    });
    const respond = vi.fn(async ({ conversationId, customerMessage }: {
      conversationId: string;
      customerMessage: string;
    }) => {
      store.createMessage({
        conversationId,
        direction: 'inbound',
        author: 'customer',
        text: customerMessage,
      });
      store.createMessage({
        conversationId,
        direction: 'outbound',
        author: 'sales_agent',
        text: 'Yeni konuşma',
      });
      return { content: 'Yeni konuşma' };
    });
    const service = new SalesConversationService(store, { respond });

    const result = await service.handleMessage({
      instagramUserId: 'ig-1',
      message: 'Tekrar merhaba',
    });

    expect(result.conversationId).toBe('conversation-2');
    expect(result.conversationId).not.toBe(closed.id);
    expect(store.listConversations()).toHaveLength(2);
  });

  it('returns current lead, order, payment, and conversation messages after the Sales Agent runs', async () => {
    const store = new CommerceStore();
    const product = store.createProduct({
      sku: 'SKU-1',
      name: 'Ürün',
      description: 'Ürün',
      price: { amountMinor: 100_00, currency: 'TRY' },
      stockQuantity: 5,
      active: true,
    });

    const respond = vi.fn(async ({ conversationId, customerMessage }: {
      conversationId: string;
      customerMessage: string;
    }) => {
      const conversation = store.getConversation(conversationId);
      if (!conversation) throw new Error('missing conversation');

      store.createMessage({
        conversationId,
        direction: 'inbound',
        author: 'customer',
        text: customerMessage,
      });
      const lead = store.createLead({
        customerId: conversation.customerId,
        conversationId,
        productId: product.id,
        stage: 'ready_to_buy',
        quantity: 1,
        objections: [],
      });
      const order = store.createOrder({
        customerId: conversation.customerId,
        leadId: lead.id,
        items: [
          {
            productId: product.id,
            quantity: 1,
            unitPrice: { amountMinor: 100_00, currency: 'TRY' },
          },
        ],
        subtotal: { amountMinor: 100_00, currency: 'TRY' },
        shipping: { amountMinor: 0, currency: 'TRY' },
        total: { amountMinor: 100_00, currency: 'TRY' },
        status: 'awaiting_payment',
      });
      store.createPayment({
        orderId: order.id,
        provider: 'sandbox',
        status: 'pending',
        amount: { amountMinor: 100_00, currency: 'TRY' },
      });
      store.createMessage({
        conversationId,
        direction: 'outbound',
        author: 'sales_agent',
        text: 'Ödeme bekleniyor.',
      });

      return { content: 'Ödeme bekleniyor.' };
    });

    const service = new SalesConversationService(store, { respond });
    const result = await service.handleMessage({
      instagramUserId: 'ig-1',
      message: 'Alıyorum',
    });

    expect(result).toEqual(
      expect.objectContaining({
        customerId: 'customer-1',
        conversationId: 'conversation-1',
        response: 'Ödeme bekleniyor.',
        leadStage: 'ready_to_buy',
        orderStatus: 'awaiting_payment',
        paymentStatus: 'pending',
      }),
    );
    expect(result.messages.map((message) => message.text)).toEqual([
      'Alıyorum',
      'Ödeme bekleniyor.',
    ]);
  });
});
