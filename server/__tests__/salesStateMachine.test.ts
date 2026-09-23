import { describe, expect, it } from 'vitest';

import {
  applySuccessfulPayment,
  canTransitionSalesStage,
  conversationStatusForSalesStage,
  transitionSalesStage,
} from '../src/commerce/salesStateMachine.js';
import type { Lead, Order, Payment } from '../src/commerce/types.js';

function lead(stage: Lead['stage']): Lead {
  return {
    id: 'lead-1',
    customerId: 'customer-1',
    conversationId: 'conversation-1',
    productId: 'product-1',
    stage,
    objections: [],
    createdAt: 10,
    updatedAt: 10,
  };
}

function order(status: Order['status'] = 'awaiting_payment'): Order {
  return {
    id: 'order-1',
    customerId: 'customer-1',
    leadId: 'lead-1',
    items: [
      {
        productId: 'product-1',
        quantity: 1,
        unitPrice: { amountMinor: 149_900, currency: 'TRY' },
      },
    ],
    subtotal: { amountMinor: 149_900, currency: 'TRY' },
    shipping: { amountMinor: 0, currency: 'TRY' },
    total: { amountMinor: 149_900, currency: 'TRY' },
    status,
    createdAt: 20,
    updatedAt: 20,
  };
}

function payment(status: Payment['status'] = 'paid'): Payment {
  return {
    id: 'payment-1',
    orderId: 'order-1',
    provider: 'test',
    status,
    amount: { amountMinor: 149_900, currency: 'TRY' },
    createdAt: 30,
    updatedAt: 30,
  };
}

describe('sales state machine', () => {
  it('supports human conversation shortcuts instead of requiring a rigid funnel', () => {
    expect(canTransitionSalesStage('new_lead', 'ready_to_buy')).toBe(true);
    expect(canTransitionSalesStage('interested', 'objection')).toBe(true);
    expect(canTransitionSalesStage('objection', 'ready_to_buy')).toBe(true);
    expect(canTransitionSalesStage('follow_up', 'interested')).toBe(true);
    expect(canTransitionSalesStage('lost', 'ready_to_buy')).toBe(true);
  });

  it('keeps sold terminal for that lead', () => {
    expect(canTransitionSalesStage('sold', 'interested')).toBe(false);
    expect(() => transitionSalesStage(lead('sold'), 'interested')).toThrow(
      'Invalid sales stage transition: sold -> interested',
    );
  });

  it('does not allow the AI to mark a lead sold without confirmed payment', () => {
    expect(() => transitionSalesStage(lead('payment_pending'), 'sold')).toThrow(
      'Cannot mark a lead as sold without confirmed payment.',
    );
  });

  it('maps sales stages to conversation lifecycle status', () => {
    expect(conversationStatusForSalesStage('interested')).toBe('open');
    expect(conversationStatusForSalesStage('human_handoff')).toBe('handoff');
    expect(conversationStatusForSalesStage('sold')).toBe('closed');
    expect(conversationStatusForSalesStage('lost')).toBe('closed');
  });

  it('marks the order paid and lead sold only from a matching confirmed payment', () => {
    const result = applySuccessfulPayment(
      lead('payment_pending'),
      order(),
      payment(),
      40,
    );

    expect(result.lead).toEqual(
      expect.objectContaining({
        id: 'lead-1',
        stage: 'sold',
        updatedAt: 40,
      }),
    );
    expect(result.order).toEqual(
      expect.objectContaining({
        id: 'order-1',
        status: 'paid',
        updatedAt: 40,
      }),
    );
  });

  it('rejects payment mismatch and non-paid payment states', () => {
    expect(() =>
      applySuccessfulPayment(lead('payment_pending'), order(), payment('failed')),
    ).toThrow('Payment is not confirmed as paid.');

    expect(() =>
      applySuccessfulPayment(lead('payment_pending'), order(), {
        ...payment(),
        amount: { amountMinor: 1, currency: 'TRY' },
      }),
    ).toThrow('Paid amount does not match order total.');

    expect(() =>
      applySuccessfulPayment(lead('payment_pending'), order(), {
        ...payment(),
        orderId: 'order-other',
      }),
    ).toThrow('Payment does not belong to this order.');
  });

  it('allows a human handoff to complete after a real payment event', () => {
    const result = applySuccessfulPayment(lead('human_handoff'), order(), payment(), 50);
    expect(result.lead.stage).toBe('sold');
    expect(result.order.status).toBe('paid');
  });
});
