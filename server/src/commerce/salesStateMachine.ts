import type {
  ConversationStatus,
  Lead,
  Money,
  Order,
  Payment,
  SalesStage,
} from './types.js';

const ACTIVE_STAGES: readonly SalesStage[] = [
  'need_discovery',
  'interested',
  'objection',
  'ready_to_buy',
  'order_details',
  'payment_pending',
  'follow_up',
  'human_handoff',
  'lost',
];

export const SALES_STAGE_TRANSITIONS: Readonly<Record<SalesStage, readonly SalesStage[]>> = {
  new_lead: ACTIVE_STAGES,
  need_discovery: [
    'interested',
    'objection',
    'ready_to_buy',
    'follow_up',
    'human_handoff',
    'lost',
  ],
  interested: [
    'need_discovery',
    'objection',
    'ready_to_buy',
    'follow_up',
    'human_handoff',
    'lost',
  ],
  objection: ['interested', 'ready_to_buy', 'follow_up', 'human_handoff', 'lost'],
  ready_to_buy: [
    'objection',
    'order_details',
    'payment_pending',
    'follow_up',
    'human_handoff',
    'lost',
  ],
  order_details: [
    'objection',
    'ready_to_buy',
    'payment_pending',
    'follow_up',
    'human_handoff',
    'lost',
  ],
  payment_pending: [
    'objection',
    'ready_to_buy',
    'follow_up',
    'human_handoff',
    'lost',
    'sold',
  ],
  sold: [],
  follow_up: [
    'need_discovery',
    'interested',
    'objection',
    'ready_to_buy',
    'order_details',
    'payment_pending',
    'human_handoff',
    'lost',
  ],
  human_handoff: [
    'need_discovery',
    'interested',
    'objection',
    'ready_to_buy',
    'order_details',
    'payment_pending',
    'follow_up',
    'lost',
    'sold',
  ],
  lost: ['need_discovery', 'interested', 'objection', 'ready_to_buy', 'human_handoff'],
};

export interface SalesTransitionOptions {
  now?: number;
  paymentConfirmed?: boolean;
}

export function canTransitionSalesStage(from: SalesStage, to: SalesStage): boolean {
  return from === to || SALES_STAGE_TRANSITIONS[from].includes(to);
}

export function transitionSalesStage(
  lead: Lead,
  to: SalesStage,
  options: SalesTransitionOptions = {},
): Lead {
  if (!canTransitionSalesStage(lead.stage, to)) {
    throw new Error(`Invalid sales stage transition: ${lead.stage} -> ${to}`);
  }

  if (to === 'sold' && lead.stage !== 'sold' && options.paymentConfirmed !== true) {
    throw new Error('Cannot mark a lead as sold without confirmed payment.');
  }

  return {
    ...lead,
    stage: to,
    updatedAt: options.now ?? Date.now(),
  };
}

export function conversationStatusForSalesStage(stage: SalesStage): ConversationStatus {
  if (stage === 'human_handoff') return 'handoff';
  if (stage === 'sold' || stage === 'lost') return 'closed';
  return 'open';
}

function sameMoney(left: Money, right: Money): boolean {
  return left.amountMinor === right.amountMinor && left.currency === right.currency;
}

export function applySuccessfulPayment(
  lead: Lead,
  order: Order,
  payment: Payment,
  now = Date.now(),
): { lead: Lead; order: Order } {
  if (payment.status !== 'paid') {
    throw new Error('Payment is not confirmed as paid.');
  }
  if (order.leadId !== lead.id) {
    throw new Error('Order does not belong to this lead.');
  }
  if (order.customerId !== lead.customerId) {
    throw new Error('Order customer does not match lead customer.');
  }
  if (payment.orderId !== order.id) {
    throw new Error('Payment does not belong to this order.');
  }
  if (!sameMoney(payment.amount, order.total)) {
    throw new Error('Paid amount does not match order total.');
  }
  if (order.status === 'cancelled' || order.status === 'fulfilled') {
    throw new Error(`Cannot apply payment to order in status: ${order.status}`);
  }

  return {
    lead: transitionSalesStage(lead, 'sold', {
      now,
      paymentConfirmed: true,
    }),
    order: {
      ...order,
      status: 'paid',
      updatedAt: now,
    },
  };
}
