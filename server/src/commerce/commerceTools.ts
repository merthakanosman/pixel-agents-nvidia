import {
  canTransitionSalesStage,
  type SalesTransitionOptions,
} from './salesStateMachine.js';
import { CommerceStore } from './commerceStore.js';
import type {
  Customer,
  Lead,
  Money,
  Order,
  Product,
  SalesStage,
} from './types.js';

export interface CommerceShippingQuoteProvider {
  quote(
    customer: Customer,
    items: ReadonlyArray<{ product: Product; quantity: number }>,
  ): Promise<Money>;
}

export interface CommercePaymentGateway {
  createCheckout(order: Order): Promise<{
    provider: string;
    externalReference: string;
    checkoutUrl: string;
  }>;
}

export interface CommerceToolsOptions {
  shipping: CommerceShippingQuoteProvider;
  paymentGateway: CommercePaymentGateway;
  now?: () => number;
}

export type CommerceToolAction =
  | { action: 'get_product'; productId?: string; sku?: string }
  | { action: 'get_stock'; productId: string }
  | { action: 'get_customer'; customerId?: string; instagramUserId?: string }
  | { action: 'get_conversation'; conversationId: string }
  | {
      action: 'create_lead';
      customerId: string;
      conversationId: string;
      productId: string;
      quantity?: number;
    }
  | {
      action: 'update_lead';
      leadId: string;
      stage?: SalesStage;
      quantity?: number;
      objections?: string[];
      followUpAt?: number;
    }
  | {
      action: 'create_order';
      leadId: string;
      items: Array<{ productId: string; quantity: number }>;
    }
  | { action: 'create_payment'; orderId: string }
  | {
      action: 'schedule_followup';
      leadId: string;
      scheduledAt: number;
      reason: string;
    }
  | { action: 'handoff_to_human'; leadId: string };

export type CommerceToolResult =
  | { ok: true; action: CommerceToolAction['action']; data: unknown }
  | { ok: false; action: CommerceToolAction['action']; error: string };

function assertMoney(value: Money, label: string): void {
  if (!Number.isInteger(value.amountMinor) || value.amountMinor < 0) {
    throw new Error(`${label} amount must be a non-negative integer.`);
  }
  if (!value.currency.trim()) {
    throw new Error(`${label} currency is required.`);
  }
}

function addMoney(left: Money, right: Money): Money {
  if (left.currency !== right.currency) {
    throw new Error('Commerce money currencies do not match.');
  }
  return {
    amountMinor: left.amountMinor + right.amountMinor,
    currency: left.currency,
  };
}

export class CommerceTools {
  private readonly now: () => number;

  constructor(
    private readonly store: CommerceStore,
    private readonly options: CommerceToolsOptions,
  ) {
    this.now = options.now ?? Date.now;
  }

  async execute(action: CommerceToolAction): Promise<CommerceToolResult> {
    try {
      switch (action.action) {
        case 'get_product':
          return this.success(action.action, this.getProduct(action.productId, action.sku));

        case 'get_stock': {
          const product = this.requireProduct(action.productId);
          return this.success(action.action, {
            productId: product.id,
            sku: product.sku,
            active: product.active,
            stockQuantity: product.stockQuantity,
          });
        }

        case 'get_customer':
          return this.success(
            action.action,
            this.getCustomer(action.customerId, action.instagramUserId),
          );

        case 'get_conversation':
          return this.success(action.action, this.getConversation(action.conversationId));

        case 'create_lead':
          return this.success(action.action, this.createLead(action));

        case 'update_lead':
          return this.success(action.action, this.updateLead(action));

        case 'create_order':
          return this.success(action.action, await this.createOrder(action));

        case 'create_payment':
          return this.success(action.action, await this.createPayment(action.orderId));

        case 'schedule_followup':
          return this.success(action.action, this.scheduleFollowUp(action));

        case 'handoff_to_human':
          return this.success(action.action, this.handoffToHuman(action.leadId));
      }
    } catch (err) {
      return {
        ok: false,
        action: action.action,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private success(action: CommerceToolAction['action'], data: unknown): CommerceToolResult {
    return { ok: true, action, data };
  }

  private getProduct(productId?: string, sku?: string): Product {
    if (productId) return this.requireProduct(productId);
    if (sku) {
      const product = this.store.findProductBySku(sku);
      if (product) return product;
      throw new Error(`Unknown product SKU: ${sku}`);
    }
    throw new Error('get_product requires productId or sku.');
  }

  private getCustomer(customerId?: string, instagramUserId?: string): Customer {
    if (customerId) return this.requireCustomer(customerId);
    if (instagramUserId) {
      const customer = this.store.findCustomerByInstagramUserId(instagramUserId);
      if (customer) return customer;
      throw new Error(`Unknown Instagram customer: ${instagramUserId}`);
    }
    throw new Error('get_customer requires customerId or instagramUserId.');
  }

  private getConversation(conversationId: string): unknown {
    const conversation = this.store.getConversation(conversationId);
    if (!conversation) throw new Error(`Unknown conversation: ${conversationId}`);

    const customer = this.requireCustomer(conversation.customerId);
    const messages = this.store
      .listMessages(conversation.id)
      .slice()
      .sort((left, right) => left.createdAt - right.createdAt);
    const activeLead = conversation.activeLeadId
      ? this.store.getLead(conversation.activeLeadId)
      : undefined;
    const activeOrder = conversation.activeOrderId
      ? this.store.getOrder(conversation.activeOrderId)
      : undefined;
    const payments = activeOrder
      ? this.store.listPayments().filter((payment) => payment.orderId === activeOrder.id)
      : [];
    const followUps = this.store
      .listFollowUps()
      .filter((followUp) => followUp.conversationId === conversation.id);

    return {
      conversation,
      customer,
      messages,
      activeLead,
      activeOrder,
      payments,
      followUps,
    };
  }

  private createLead(action: Extract<CommerceToolAction, { action: 'create_lead' }>): Lead {
    const product = this.requireProduct(action.productId);
    if (!product.active) {
      throw new Error(`Product is not active: ${product.id}`);
    }
    if (
      action.quantity !== undefined &&
      (!Number.isInteger(action.quantity) || action.quantity <= 0)
    ) {
      throw new Error('Lead quantity must be a positive integer.');
    }

    return this.store.createLead({
      customerId: action.customerId,
      conversationId: action.conversationId,
      productId: action.productId,
      stage: 'new_lead',
      ...(action.quantity !== undefined ? { quantity: action.quantity } : {}),
      objections: [],
    });
  }

  private updateLead(action: Extract<CommerceToolAction, { action: 'update_lead' }>): Lead {
    if (action.stage === 'sold') {
      throw new Error('Sales Agent cannot mark a lead sold; confirmed payment event is required.');
    }
    if (
      action.quantity !== undefined &&
      (!Number.isInteger(action.quantity) || action.quantity <= 0)
    ) {
      throw new Error('Lead quantity must be a positive integer.');
    }

    let lead = this.requireLead(action.leadId);
    if (action.stage !== undefined && action.stage !== lead.stage) {
      lead = this.store.transitionLead(lead.id, action.stage);
    }

    if (
      action.quantity !== undefined ||
      action.objections !== undefined ||
      action.followUpAt !== undefined
    ) {
      lead = this.store.updateLead(lead.id, {
        ...(action.quantity !== undefined ? { quantity: action.quantity } : {}),
        ...(action.objections !== undefined ? { objections: action.objections } : {}),
        ...(action.followUpAt !== undefined ? { followUpAt: action.followUpAt } : {}),
      });
    }

    return lead;
  }

  private async createOrder(
    action: Extract<CommerceToolAction, { action: 'create_order' }>,
  ): Promise<Order> {
    const lead = this.requireLead(action.leadId);
    if (lead.stage !== 'ready_to_buy' && lead.stage !== 'order_details') {
      throw new Error(
        `Cannot create an order while lead is in stage: ${lead.stage}`,
      );
    }
    if (action.items.length === 0) {
      throw new Error('create_order requires at least one item.');
    }

    const conversation = this.store.getConversation(lead.conversationId);
    if (!conversation) {
      throw new Error(`Unknown conversation: ${lead.conversationId}`);
    }
    if (conversation.activeOrderId) {
      const activeOrder = this.store.getOrder(conversation.activeOrderId);
      if (activeOrder && activeOrder.status !== 'cancelled') {
        throw new Error(`Conversation already has an active order: ${activeOrder.id}`);
      }
    }

    const customer = this.requireCustomer(lead.customerId);
    const requestedQuantities = new Map<string, number>();
    for (const item of action.items) {
      if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
        throw new Error('Order item quantity must be a positive integer.');
      }
      const totalQuantity = (requestedQuantities.get(item.productId) ?? 0) + item.quantity;
      if (!Number.isSafeInteger(totalQuantity)) {
        throw new Error('Order item quantity exceeds the safe integer range.');
      }
      requestedQuantities.set(item.productId, totalQuantity);
    }

    const resolvedItems = [...requestedQuantities.entries()].map(([productId, quantity]) => {
      const product = this.requireProduct(productId);
      if (!product.active) {
        throw new Error(`Product is not active: ${product.id}`);
      }
      if (quantity > product.stockQuantity) {
        throw new Error(
          `Insufficient stock for ${product.id}: requested ${quantity}, available ${product.stockQuantity}`,
        );
      }
      assertMoney(product.price, `Product ${product.id} price`);
      const lineTotal = product.price.amountMinor * quantity;
      if (!Number.isSafeInteger(lineTotal)) {
        throw new Error(`Order line total exceeds the safe integer range: ${product.id}`);
      }
      return { product, quantity };
    });

    const currency = resolvedItems[0]?.product.price.currency;
    if (!currency) throw new Error('Order currency could not be determined.');

    let subtotal: Money = { amountMinor: 0, currency };
    for (const item of resolvedItems) {
      if (item.product.price.currency !== currency) {
        throw new Error('All order items must use the same currency.');
      }
      subtotal = addMoney(subtotal, {
        amountMinor: item.product.price.amountMinor * item.quantity,
        currency,
      });
    }

    const shipping = await this.options.shipping.quote(customer, resolvedItems);
    assertMoney(shipping, 'Shipping');
    const total = addMoney(subtotal, shipping);

    const order = this.store.createOrder({
      customerId: customer.id,
      leadId: lead.id,
      items: resolvedItems.map(({ product, quantity }) => ({
        productId: product.id,
        quantity,
        unitPrice: { ...product.price },
      })),
      subtotal,
      shipping,
      total,
      status: 'draft',
    });

    if (lead.stage !== 'order_details') {
      this.store.transitionLead(lead.id, 'order_details');
    }

    return order;
  }

  private async createPayment(orderId: string): Promise<unknown> {
    const order = this.requireOrder(orderId);
    if (order.status !== 'draft') {
      throw new Error(`Cannot create payment for order in status: ${order.status}`);
    }

    const lead = this.requireLead(order.leadId);
    if (lead.stage !== 'order_details') {
      throw new Error(`Cannot create payment while lead is in stage: ${lead.stage}`);
    }

    const checkout = await this.options.paymentGateway.createCheckout(order);
    if (!checkout.provider.trim()) {
      throw new Error('Payment gateway provider id is required.');
    }
    if (!checkout.externalReference.trim()) {
      throw new Error('Payment gateway external reference is required.');
    }

    let checkoutUrl: URL;
    try {
      checkoutUrl = new URL(checkout.checkoutUrl);
    } catch {
      throw new Error('Payment gateway returned an invalid checkout URL.');
    }
    if (checkoutUrl.protocol !== 'https:') {
      throw new Error('Payment checkout URL must use HTTPS.');
    }

    const payment = this.store.createPayment({
      orderId: order.id,
      provider: checkout.provider,
      status: 'pending',
      amount: { ...order.total },
      externalReference: checkout.externalReference,
      checkoutUrl: checkout.checkoutUrl,
    });

    const updatedOrder = this.store.updateOrder(order.id, { status: 'awaiting_payment' });
    const updatedLead = this.store.transitionLead(lead.id, 'payment_pending');

    return {
      payment,
      order: updatedOrder,
      lead: updatedLead,
    };
  }

  private scheduleFollowUp(
    action: Extract<CommerceToolAction, { action: 'schedule_followup' }>,
  ): unknown {
    const lead = this.requireLead(action.leadId);
    if (!Number.isFinite(action.scheduledAt) || action.scheduledAt <= this.now()) {
      throw new Error('Follow-up must be scheduled in the future.');
    }
    const reason = action.reason.trim();
    if (!reason) throw new Error('Follow-up reason is required.');
    if (!canTransitionSalesStage(lead.stage, 'follow_up')) {
      throw new Error(`Cannot schedule follow-up while lead is in stage: ${lead.stage}`);
    }

    const followUp = this.store.createFollowUp({
      customerId: lead.customerId,
      conversationId: lead.conversationId,
      leadId: lead.id,
      scheduledAt: action.scheduledAt,
      reason,
      status: 'scheduled',
    });
    const updatedLead =
      lead.stage === 'follow_up'
        ? lead
        : this.store.transitionLead(lead.id, 'follow_up', { now: this.now() });

    return { followUp, lead: updatedLead };
  }

  private handoffToHuman(leadId: string): unknown {
    const lead = this.requireLead(leadId);
    const options: SalesTransitionOptions = { now: this.now() };
    const updatedLead =
      lead.stage === 'human_handoff'
        ? lead
        : this.store.transitionLead(lead.id, 'human_handoff', options);
    const conversation = this.store.getConversation(updatedLead.conversationId);
    return { lead: updatedLead, conversation };
  }

  private requireProduct(id: string): Product {
    const product = this.store.getProduct(id);
    if (!product) throw new Error(`Unknown product: ${id}`);
    return product;
  }

  private requireCustomer(id: string): Customer {
    const customer = this.store.getCustomer(id);
    if (!customer) throw new Error(`Unknown customer: ${id}`);
    return customer;
  }

  private requireLead(id: string): Lead {
    const lead = this.store.getLead(id);
    if (!lead) throw new Error(`Unknown lead: ${id}`);
    return lead;
  }

  private requireOrder(id: string): Order {
    const order = this.store.getOrder(id);
    if (!order) throw new Error(`Unknown order: ${id}`);
    return order;
  }
}
