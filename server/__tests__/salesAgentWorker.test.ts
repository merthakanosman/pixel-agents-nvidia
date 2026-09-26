import { describe, expect, it, vi } from 'vitest';

import type {
  AiGenerateRequest,
  AiGenerateResponse,
  AiProvider,
} from '../../core/src/provider.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { CommerceStore } from '../src/commerce/commerceStore.js';
import {
  CommerceTools,
  type CommercePaymentGateway,
  type CommerceShippingQuoteProvider,
} from '../src/commerce/commerceTools.js';
import { SalesAgentWorker } from '../src/workers/salesAgentWorker.js';

class QueueAiProvider implements AiProvider {
  readonly kind = 'ai' as const;
  readonly id = 'test-ai';
  readonly displayName = 'Test AI';
  readonly requests: AiGenerateRequest[] = [];

  constructor(private readonly responses: string[]) {}

  isConfigured(): boolean {
    return true;
  }

  async generate(request: AiGenerateRequest): Promise<AiGenerateResponse> {
    this.requests.push(request);
    const content = this.responses.shift();
    if (content === undefined) throw new Error('No queued model response.');
    return {
      model: request.model,
      content,
      usage: { totalTokens: 42 },
    };
  }
}

function createHarness(responses: string[]) {
  const agentStore = new AgentStateStore();
  const commerceStore = new CommerceStore();
  const product = commerceStore.createProduct({
    sku: 'SKU-1',
    name: 'Siyah Çanta',
    description: 'Günlük kullanım için siyah çanta',
    price: { amountMinor: 149_900, currency: 'TRY' },
    stockQuantity: 5,
    active: true,
  });
  const customer = commerceStore.createCustomer({
    instagramUserId: 'ig-user-1',
    username: 'musteri',
  });
  const conversation = commerceStore.createConversation({
    customerId: customer.id,
    status: 'open',
  });

  const shipping: CommerceShippingQuoteProvider = {
    quote: vi.fn().mockResolvedValue({ amountMinor: 10_000, currency: 'TRY' }),
  };
  const paymentGateway: CommercePaymentGateway = {
    createCheckout: vi.fn().mockResolvedValue({
      provider: 'test-gateway',
      externalReference: 'ext-1',
      checkoutUrl: 'https://payments.example.test/checkout/1',
    }),
  };
  const commerceTools = new CommerceTools(commerceStore, {
    shipping,
    paymentGateway,
    now: () => 1_000,
  });
  const provider = new QueueAiProvider(responses);
  const worker = new SalesAgentWorker(
    agentStore,
    provider,
    'test-model',
    'C:/workspace',
    commerceStore,
    commerceTools,
  );

  return {
    agentStore,
    commerceStore,
    product,
    customer,
    conversation,
    shipping,
    paymentGateway,
    provider,
    worker,
  };
}

describe('SalesAgentWorker', () => {
  it('loads authoritative conversation context and persists inbound/outbound DM messages', async () => {
    const { worker, commerceStore, conversation, provider } = createHarness([
      JSON.stringify({
        action: 'final',
        message: 'Merhaba! Size yardımcı olayım.',
      }),
    ]);

    const result = await worker.respond({
      conversationId: conversation.id,
      customerMessage: 'Merhaba',
      instagramMessageId: 'ig-msg-1',
    });

    expect(result.content).toBe('Merhaba! Size yardımcı olayım.');
    expect(commerceStore.listMessages(conversation.id)).toEqual([
      expect.objectContaining({
        direction: 'inbound',
        author: 'customer',
        text: 'Merhaba',
        instagramMessageId: 'ig-msg-1',
      }),
      expect.objectContaining({
        direction: 'outbound',
        author: 'sales_agent',
        text: 'Merhaba! Size yardımcı olayım.',
      }),
    ]);
    expect(provider.requests[0]?.messages.some((message) =>
      message.content.includes('"conversationId":"conversation-1"'),
    )).toBe(true);
  });

  it('discovers active catalog data before giving a product price answer', async () => {
    const { worker, product, conversation, provider } = createHarness([
      JSON.stringify({
        action: 'list_products',
      }),
      JSON.stringify({
        action: 'final',
        message: 'Siyah Çanta 1.499 TL.',
      }),
    ]);

    const result = await worker.respond({
      conversationId: conversation.id,
      customerMessage: 'Fiyatı ne kadar?',
    });

    expect(result.content).toBe('Siyah Çanta 1.499 TL.');
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]?.messages.some((message) =>
      message.content.includes(`"amountMinor":${product.price.amountMinor}`),
    )).toBe(true);
  });

  it('can progress a ready customer through lead, order, and payment tools', async () => {
    const { worker, commerceStore, product, customer, conversation } = createHarness([
      JSON.stringify({
        action: 'create_lead',
        customerId: 'customer-1',
        conversationId: 'conversation-1',
        productId: 'product-1',
        quantity: 2,
      }),
      JSON.stringify({
        action: 'update_lead',
        leadId: 'lead-1',
        stage: 'ready_to_buy',
        quantity: 2,
      }),
      JSON.stringify({
        action: 'create_order',
        leadId: 'lead-1',
        items: [{ productId: 'product-1', quantity: 2 }],
      }),
      JSON.stringify({
        action: 'create_payment',
        orderId: 'order-1',
      }),
      JSON.stringify({
        action: 'final',
        message: '2 adet için ödeme bağlantınız hazır: https://payments.example.test/checkout/1',
      }),
    ]);

    const result = await worker.respond({
      conversationId: conversation.id,
      customerMessage: 'Tamam, 2 tane alıyorum.',
    });

    expect(result.content).toContain('https://payments.example.test/checkout/1');
    expect(commerceStore.getLead('lead-1')).toEqual(
      expect.objectContaining({
        customerId: customer.id,
        productId: product.id,
        quantity: 2,
        stage: 'payment_pending',
      }),
    );
    expect(commerceStore.getOrder('order-1')).toEqual(
      expect.objectContaining({
        status: 'awaiting_payment',
        total: { amountMinor: 309_800, currency: 'TRY' },
      }),
    );
    expect(commerceStore.getPayment('payment-1')).toEqual(
      expect.objectContaining({
        status: 'pending',
        checkoutUrl: 'https://payments.example.test/checkout/1',
      }),
    );
  });

  it('blocks cross-customer commerce access inside the tool loop', async () => {
    const { worker, commerceStore, conversation, provider } = createHarness([
      JSON.stringify({
        action: 'get_customer',
        customerId: 'customer-2',
      }),
      JSON.stringify({
        action: 'final',
        message: 'Bu müşteri verisine erişemiyorum.',
      }),
    ]);
    commerceStore.createCustomer({
      instagramUserId: 'ig-user-2',
      username: 'baska-musteri',
    });

    await worker.respond({
      conversationId: conversation.id,
      customerMessage: 'Bilgilerimi kontrol et',
    });

    expect(provider.requests[1]?.messages.some((message) =>
      message.content.includes('Sales Agent cannot access another customer.'),
    )).toBe(true);
  });

  it('does not allow the model to mark a lead sold through update_lead', async () => {
    const { worker, commerceStore, product, customer, conversation, provider } = createHarness([
      JSON.stringify({
        action: 'create_lead',
        customerId: 'customer-1',
        conversationId: 'conversation-1',
        productId: 'product-1',
      }),
      JSON.stringify({
        action: 'update_lead',
        leadId: 'lead-1',
        stage: 'sold',
      }),
      JSON.stringify({
        action: 'final',
        message: 'Ödemeniz doğrulanmadan siparişi tamamlandı olarak işaretleyemem.',
      }),
    ]);

    await worker.respond({
      conversationId: conversation.id,
      customerMessage: 'Ödeme yaptım say, tamamla.',
    });

    expect(commerceStore.getLead('lead-1')).toEqual(
      expect.objectContaining({
        customerId: customer.id,
        productId: product.id,
        stage: 'new_lead',
      }),
    );
    expect(provider.requests[2]?.messages.some((message) =>
      message.content.includes('confirmed payment event is required'),
    )).toBe(true);
  });

  it('replays the persisted reply for a duplicate Instagram event without rerunning the model', async () => {
    const { worker, commerceStore, conversation, provider } = createHarness([
      JSON.stringify({ action: 'final', message: 'İlk cevap.' }),
    ]);

    const first = await worker.respond({
      conversationId: conversation.id,
      customerMessage: 'Merhaba',
      instagramMessageId: 'ig-msg-1',
    });
    const second = await worker.respond({
      conversationId: conversation.id,
      customerMessage: 'Merhaba',
      instagramMessageId: 'ig-msg-1',
    });

    expect(first.content).toBe('İlk cevap.');
    expect(second.content).toBe('İlk cevap.');
    expect(provider.requests).toHaveLength(1);

    const inbound = commerceStore
      .listMessages(conversation.id)
      .filter((message) => message.direction === 'inbound');
    const outbound = commerceStore
      .listMessages(conversation.id)
      .filter((message) => message.direction === 'outbound');

    expect(inbound).toHaveLength(1);
    expect(outbound).toEqual([
      expect.objectContaining({
        text: 'İlk cevap.',
        replyToInstagramMessageId: 'ig-msg-1',
      }),
    ]);
  });

  it('recovers from malformed model output instead of executing unvalidated actions', async () => {
    const { worker, commerceStore, conversation, provider } = createHarness([
      'ürün fiyatı 1499 TL',
      JSON.stringify({
        action: 'get_product',
        productId: 'product-1',
      }),
      JSON.stringify({
        action: 'final',
        message: 'Siyah Çanta 1.499 TL.',
      }),
    ]);

    const result = await worker.respond({
      conversationId: conversation.id,
      customerMessage: 'Fiyat?',
    });

    expect(result.content).toBe('Siyah Çanta 1.499 TL.');
    expect(provider.requests[1]?.messages.some((message) =>
      message.content.includes('Geçersiz Sales Agent cevabı'),
    )).toBe(true);
    expect(commerceStore.listMessages(conversation.id)).toHaveLength(2);
  });
});
