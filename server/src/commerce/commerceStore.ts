import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { LAYOUT_FILE_DIR } from '../constants.js';
import {
  conversationStatusForSalesStage,
  transitionSalesStage,
  type SalesTransitionOptions,
} from './salesStateMachine.js';
import type {
  Conversation,
  Customer,
  FollowUp,
  Lead,
  Message,
  Order,
  Payment,
  Product,
} from './types.js';

const STORE_VERSION = 1;

type CommerceEntityKind =
  | 'product'
  | 'customer'
  | 'conversation'
  | 'message'
  | 'lead'
  | 'order'
  | 'payment'
  | 'followup';

type CommerceNextIds = Record<CommerceEntityKind, number>;

interface PersistedCommerceStateV1 {
  version: 1;
  nextIds: CommerceNextIds;
  products: Product[];
  customers: Customer[];
  conversations: Conversation[];
  messages: Message[];
  leads: Lead[];
  orders: Order[];
  payments: Payment[];
  followUps: FollowUp[];
}

export interface CommerceStoreOptions {
  workspaceRoot?: string;
  storageDir?: string;
}

export type NewProduct = Omit<Product, 'id' | 'createdAt' | 'updatedAt'>;
export type NewCustomer = Omit<Customer, 'id' | 'createdAt' | 'updatedAt'>;
export type NewConversation = Omit<Conversation, 'id' | 'createdAt' | 'updatedAt'>;
export type NewMessage = Omit<Message, 'id' | 'createdAt'>;
export type NewLead = Omit<Lead, 'id' | 'createdAt' | 'updatedAt'>;
export type NewOrder = Omit<Order, 'id' | 'createdAt' | 'updatedAt'>;
export type NewPayment = Omit<Payment, 'id' | 'createdAt' | 'updatedAt'>;
export type NewFollowUp = Omit<FollowUp, 'id' | 'createdAt' | 'updatedAt'>;

const EMPTY_NEXT_IDS: CommerceNextIds = {
  product: 1,
  customer: 1,
  conversation: 1,
  message: 1,
  lead: 1,
  order: 1,
  payment: 1,
  followup: 1,
};

function workspaceId(workspaceRoot: string): string {
  const normalized = process.platform === 'win32' ? workspaceRoot.toLowerCase() : workspaceRoot;
  return createHash('sha256').update(normalized).digest('hex').slice(0, 24);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseEntityArray<T extends { id: string }>(value: unknown): T[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is T => isRecord(item) && typeof item['id'] === 'string' && item['id'].length > 0,
  );
}

function validNextId(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 1;
}

function nextIdFromRecords(records: Iterable<{ id: string }>, prefix: CommerceEntityKind): number {
  const pattern = new RegExp(`^${prefix}-(\\d+)$`);
  let highest = 0;
  for (const record of records) {
    const match = pattern.exec(record.id);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return highest + 1;
}

function cloneNextIds(value: unknown): CommerceNextIds {
  const input = isRecord(value) ? value : {};
  return {
    product: validNextId(input['product']),
    customer: validNextId(input['customer']),
    conversation: validNextId(input['conversation']),
    message: validNextId(input['message']),
    lead: validNextId(input['lead']),
    order: validNextId(input['order']),
    payment: validNextId(input['payment']),
    followup: validNextId(input['followup']),
  };
}

export class CommerceStore {
  private readonly products = new Map<string, Product>();
  private readonly customers = new Map<string, Customer>();
  private readonly conversations = new Map<string, Conversation>();
  private readonly messages = new Map<string, Message>();
  private readonly leads = new Map<string, Lead>();
  private readonly orders = new Map<string, Order>();
  private readonly payments = new Map<string, Payment>();
  private readonly followUps = new Map<string, FollowUp>();
  private nextIds: CommerceNextIds = { ...EMPTY_NEXT_IDS };
  private readonly stateFilePath: string | null;

  constructor(options: CommerceStoreOptions = {}) {
    if (!options.workspaceRoot) {
      this.stateFilePath = null;
      return;
    }

    const resolvedWorkspace = fs.realpathSync(path.resolve(options.workspaceRoot));
    const storageDir = options.storageDir ?? path.join(os.homedir(), LAYOUT_FILE_DIR, 'commerce');
    this.stateFilePath = path.join(storageDir, `${workspaceId(resolvedWorkspace)}.json`);
    this.loadState();
  }

  createProduct(input: NewProduct): Product {
    if (this.findProductBySku(input.sku)) {
      throw new Error(`Product SKU already exists: ${input.sku}`);
    }
    if (!Number.isInteger(input.stockQuantity) || input.stockQuantity < 0) {
      throw new Error('Product stock quantity must be a non-negative integer.');
    }

    const now = Date.now();
    const product: Product = {
      ...input,
      id: this.nextId('product'),
      createdAt: now,
      updatedAt: now,
    };
    this.products.set(product.id, product);
    this.persistState();
    return product;
  }

  updateProduct(
    id: string,
    patch: Partial<Pick<Product, 'sku' | 'name' | 'description' | 'price' | 'stockQuantity' | 'active'>>,
  ): Product {
    const product = this.requireProduct(id);
    if (patch.sku !== undefined) {
      const existing = this.findProductBySku(patch.sku);
      if (existing && existing.id !== id) {
        throw new Error(`Product SKU already exists: ${patch.sku}`);
      }
    }
    if (
      patch.stockQuantity !== undefined &&
      (!Number.isInteger(patch.stockQuantity) || patch.stockQuantity < 0)
    ) {
      throw new Error('Product stock quantity must be a non-negative integer.');
    }

    Object.assign(product, patch, { updatedAt: Date.now() });
    this.persistState();
    return product;
  }

  createCustomer(input: NewCustomer): Customer {
    if (this.findCustomerByInstagramUserId(input.instagramUserId)) {
      throw new Error(`Instagram customer already exists: ${input.instagramUserId}`);
    }

    const now = Date.now();
    const customer: Customer = {
      ...input,
      id: this.nextId('customer'),
      createdAt: now,
      updatedAt: now,
    };
    this.customers.set(customer.id, customer);
    this.persistState();
    return customer;
  }

  updateCustomer(
    id: string,
    patch: Partial<
      Pick<Customer, 'instagramUserId' | 'username' | 'displayName' | 'phone' | 'shippingAddress'>
    >,
  ): Customer {
    const customer = this.requireCustomer(id);
    if (patch.instagramUserId !== undefined) {
      const existing = this.findCustomerByInstagramUserId(patch.instagramUserId);
      if (existing && existing.id !== id) {
        throw new Error(`Instagram customer already exists: ${patch.instagramUserId}`);
      }
    }

    Object.assign(customer, patch, { updatedAt: Date.now() });
    this.persistState();
    return customer;
  }

  createConversation(input: NewConversation): Conversation {
    this.requireCustomer(input.customerId);
    this.validateConversationLinks(input.customerId, input.activeLeadId, input.activeOrderId);

    const now = Date.now();
    const conversation: Conversation = {
      ...input,
      id: this.nextId('conversation'),
      createdAt: now,
      updatedAt: now,
    };
    this.conversations.set(conversation.id, conversation);
    this.persistState();
    return conversation;
  }

  updateConversation(
    id: string,
    patch: Partial<
      Pick<Conversation, 'status' | 'activeLeadId' | 'activeOrderId' | 'lastMessageAt'>
    >,
  ): Conversation {
    const conversation = this.requireConversation(id);
    this.validateConversationLinks(
      conversation.customerId,
      patch.activeLeadId ?? conversation.activeLeadId,
      patch.activeOrderId ?? conversation.activeOrderId,
    );

    Object.assign(conversation, patch, { updatedAt: Date.now() });
    this.persistState();
    return conversation;
  }

  createMessage(input: NewMessage): Message {
    const conversation = this.requireConversation(input.conversationId);
    if (input.instagramMessageId && this.findMessageByInstagramMessageId(input.instagramMessageId)) {
      throw new Error(`Instagram message already exists: ${input.instagramMessageId}`);
    }

    const now = Date.now();
    const message: Message = {
      ...input,
      id: this.nextId('message'),
      createdAt: now,
    };
    this.messages.set(message.id, message);
    conversation.lastMessageAt = now;
    conversation.updatedAt = now;
    this.persistState();
    return message;
  }

  createLead(input: NewLead): Lead {
    const conversation = this.requireConversation(input.conversationId);
    this.requireCustomer(input.customerId);
    this.requireProduct(input.productId);
    if (conversation.customerId !== input.customerId) {
      throw new Error('Lead customer does not match conversation customer.');
    }

    const now = Date.now();
    const lead: Lead = {
      ...input,
      objections: [...input.objections],
      id: this.nextId('lead'),
      createdAt: now,
      updatedAt: now,
    };
    this.leads.set(lead.id, lead);
    conversation.activeLeadId = lead.id;
    conversation.status = conversationStatusForSalesStage(lead.stage);
    conversation.updatedAt = now;
    this.persistState();
    return lead;
  }

  updateLead(
    id: string,
    patch: Partial<Pick<Lead, 'quantity' | 'objections' | 'followUpAt'>>,
  ): Lead {
    const lead = this.requireLead(id);
    Object.assign(lead, patch, {
      ...(patch.objections !== undefined ? { objections: [...patch.objections] } : {}),
      updatedAt: Date.now(),
    });
    this.persistState();
    return lead;
  }

  transitionLead(id: string, stage: Lead['stage'], options: SalesTransitionOptions = {}): Lead {
    const current = this.requireLead(id);
    const transitioned = transitionSalesStage(current, stage, options);
    this.leads.set(id, transitioned);

    const conversation = this.requireConversation(transitioned.conversationId);
    conversation.activeLeadId = transitioned.id;
    conversation.status = conversationStatusForSalesStage(transitioned.stage);
    conversation.updatedAt = transitioned.updatedAt;
    this.persistState();
    return transitioned;
  }

  createOrder(input: NewOrder): Order {
    const customer = this.requireCustomer(input.customerId);
    const lead = this.requireLead(input.leadId);
    if (lead.customerId !== customer.id) {
      throw new Error('Order customer does not match lead customer.');
    }
    if (input.items.length === 0) {
      throw new Error('Order must contain at least one item.');
    }
    for (const item of input.items) {
      this.requireProduct(item.productId);
      if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
        throw new Error('Order item quantity must be a positive integer.');
      }
    }

    const now = Date.now();
    const order: Order = {
      ...input,
      items: input.items.map((item) => ({ ...item, unitPrice: { ...item.unitPrice } })),
      subtotal: { ...input.subtotal },
      shipping: { ...input.shipping },
      total: { ...input.total },
      id: this.nextId('order'),
      createdAt: now,
      updatedAt: now,
    };
    this.orders.set(order.id, order);

    const conversation = this.requireConversation(lead.conversationId);
    conversation.activeOrderId = order.id;
    conversation.updatedAt = now;
    this.persistState();
    return order;
  }

  updateOrder(id: string, patch: Partial<Pick<Order, 'status'>>): Order {
    const order = this.requireOrder(id);
    Object.assign(order, patch, { updatedAt: Date.now() });
    this.persistState();
    return order;
  }

  createPayment(input: NewPayment): Payment {
    this.requireOrder(input.orderId);
    const now = Date.now();
    const payment: Payment = {
      ...input,
      amount: { ...input.amount },
      id: this.nextId('payment'),
      createdAt: now,
      updatedAt: now,
    };
    this.payments.set(payment.id, payment);
    this.persistState();
    return payment;
  }

  updatePayment(
    id: string,
    patch: Partial<
      Pick<Payment, 'status' | 'externalReference' | 'checkoutUrl'>
    >,
  ): Payment {
    const payment = this.requirePayment(id);
    Object.assign(payment, patch, { updatedAt: Date.now() });
    this.persistState();
    return payment;
  }

  createFollowUp(input: NewFollowUp): FollowUp {
    const customer = this.requireCustomer(input.customerId);
    const conversation = this.requireConversation(input.conversationId);
    const lead = this.requireLead(input.leadId);
    if (conversation.customerId !== customer.id || lead.customerId !== customer.id) {
      throw new Error('Follow-up customer does not match conversation or lead customer.');
    }
    if (lead.conversationId !== conversation.id) {
      throw new Error('Follow-up lead does not belong to the conversation.');
    }

    const now = Date.now();
    const followUp: FollowUp = {
      ...input,
      id: this.nextId('followup'),
      createdAt: now,
      updatedAt: now,
    };
    this.followUps.set(followUp.id, followUp);
    this.persistState();
    return followUp;
  }

  updateFollowUp(
    id: string,
    patch: Partial<Pick<FollowUp, 'scheduledAt' | 'reason' | 'status'>>,
  ): FollowUp {
    const followUp = this.requireFollowUp(id);
    Object.assign(followUp, patch, { updatedAt: Date.now() });
    this.persistState();
    return followUp;
  }

  getProduct(id: string): Product | undefined {
    return this.products.get(id);
  }

  getCustomer(id: string): Customer | undefined {
    return this.customers.get(id);
  }

  getConversation(id: string): Conversation | undefined {
    return this.conversations.get(id);
  }

  getLead(id: string): Lead | undefined {
    return this.leads.get(id);
  }

  getOrder(id: string): Order | undefined {
    return this.orders.get(id);
  }

  getPayment(id: string): Payment | undefined {
    return this.payments.get(id);
  }

  findProductBySku(sku: string): Product | undefined {
    return this.listProducts().find((product) => product.sku === sku);
  }

  findCustomerByInstagramUserId(instagramUserId: string): Customer | undefined {
    return this.listCustomers().find((customer) => customer.instagramUserId === instagramUserId);
  }

  findMessageByInstagramMessageId(instagramMessageId: string): Message | undefined {
    return this.listMessages().find((message) => message.instagramMessageId === instagramMessageId);
  }

  listProducts(): Product[] {
    return [...this.products.values()];
  }

  listCustomers(): Customer[] {
    return [...this.customers.values()];
  }

  listConversations(): Conversation[] {
    return [...this.conversations.values()];
  }

  listMessages(conversationId?: string): Message[] {
    const messages = [...this.messages.values()];
    return conversationId
      ? messages.filter((message) => message.conversationId === conversationId)
      : messages;
  }

  listLeads(): Lead[] {
    return [...this.leads.values()];
  }

  listOrders(): Order[] {
    return [...this.orders.values()];
  }

  listPayments(): Payment[] {
    return [...this.payments.values()];
  }

  listFollowUps(): FollowUp[] {
    return [...this.followUps.values()];
  }

  private nextId(kind: CommerceEntityKind): string {
    const id = `${kind}-${this.nextIds[kind]}`;
    this.nextIds[kind] += 1;
    return id;
  }

  private validateConversationLinks(
    customerId: string,
    activeLeadId?: string,
    activeOrderId?: string,
  ): void {
    if (activeLeadId) {
      const lead = this.requireLead(activeLeadId);
      if (lead.customerId !== customerId) {
        throw new Error('Conversation active lead belongs to another customer.');
      }
    }
    if (activeOrderId) {
      const order = this.requireOrder(activeOrderId);
      if (order.customerId !== customerId) {
        throw new Error('Conversation active order belongs to another customer.');
      }
    }
  }

  private requireProduct(id: string): Product {
    const value = this.products.get(id);
    if (!value) throw new Error(`Unknown product: ${id}`);
    return value;
  }

  private requireCustomer(id: string): Customer {
    const value = this.customers.get(id);
    if (!value) throw new Error(`Unknown customer: ${id}`);
    return value;
  }

  private requireConversation(id: string): Conversation {
    const value = this.conversations.get(id);
    if (!value) throw new Error(`Unknown conversation: ${id}`);
    return value;
  }

  private requireLead(id: string): Lead {
    const value = this.leads.get(id);
    if (!value) throw new Error(`Unknown lead: ${id}`);
    return value;
  }

  private requireOrder(id: string): Order {
    const value = this.orders.get(id);
    if (!value) throw new Error(`Unknown order: ${id}`);
    return value;
  }

  private requirePayment(id: string): Payment {
    const value = this.payments.get(id);
    if (!value) throw new Error(`Unknown payment: ${id}`);
    return value;
  }

  private requireFollowUp(id: string): FollowUp {
    const value = this.followUps.get(id);
    if (!value) throw new Error(`Unknown follow-up: ${id}`);
    return value;
  }

  private loadState(): void {
    if (!this.stateFilePath || !fs.existsSync(this.stateFilePath)) return;

    try {
      const parsed = JSON.parse(fs.readFileSync(this.stateFilePath, 'utf8')) as unknown;
      if (!isRecord(parsed) || parsed['version'] !== STORE_VERSION) {
        throw new Error(
          `Unsupported commerce state version: ${isRecord(parsed) ? String(parsed['version']) : 'invalid'}`,
        );
      }

      const products = parseEntityArray<Product>(parsed['products']);
      const customers = parseEntityArray<Customer>(parsed['customers']);
      const conversations = parseEntityArray<Conversation>(parsed['conversations']);
      const messages = parseEntityArray<Message>(parsed['messages']);
      const leads = parseEntityArray<Lead>(parsed['leads']);
      const orders = parseEntityArray<Order>(parsed['orders']);
      const payments = parseEntityArray<Payment>(parsed['payments']);
      const followUps = parseEntityArray<FollowUp>(parsed['followUps']);

      this.replaceMap(this.products, products);
      this.replaceMap(this.customers, customers);
      this.replaceMap(this.conversations, conversations);
      this.replaceMap(this.messages, messages);
      this.replaceMap(this.leads, leads);
      this.replaceMap(this.orders, orders);
      this.replaceMap(this.payments, payments);
      this.replaceMap(this.followUps, followUps);

      const persistedNextIds = cloneNextIds(parsed['nextIds']);
      this.nextIds = {
        product: Math.max(
          persistedNextIds.product,
          nextIdFromRecords(products, 'product'),
        ),
        customer: Math.max(
          persistedNextIds.customer,
          nextIdFromRecords(customers, 'customer'),
        ),
        conversation: Math.max(
          persistedNextIds.conversation,
          nextIdFromRecords(conversations, 'conversation'),
        ),
        message: Math.max(
          persistedNextIds.message,
          nextIdFromRecords(messages, 'message'),
        ),
        lead: Math.max(persistedNextIds.lead, nextIdFromRecords(leads, 'lead')),
        order: Math.max(persistedNextIds.order, nextIdFromRecords(orders, 'order')),
        payment: Math.max(
          persistedNextIds.payment,
          nextIdFromRecords(payments, 'payment'),
        ),
        followup: Math.max(
          persistedNextIds.followup,
          nextIdFromRecords(followUps, 'followup'),
        ),
      };
    } catch (err) {
      console.error('[Pixel Agents] Failed to read commerce state:', err);
      this.clear();
    }
  }

  private replaceMap<T extends { id: string }>(target: Map<string, T>, values: T[]): void {
    target.clear();
    for (const value of values) target.set(value.id, value);
  }

  private clear(): void {
    this.products.clear();
    this.customers.clear();
    this.conversations.clear();
    this.messages.clear();
    this.leads.clear();
    this.orders.clear();
    this.payments.clear();
    this.followUps.clear();
    this.nextIds = { ...EMPTY_NEXT_IDS };
  }

  private persistState(): void {
    if (!this.stateFilePath) return;

    try {
      const dir = path.dirname(this.stateFilePath);
      fs.mkdirSync(dir, { recursive: true });

      const state: PersistedCommerceStateV1 = {
        version: STORE_VERSION,
        nextIds: { ...this.nextIds },
        products: this.listProducts(),
        customers: this.listCustomers(),
        conversations: this.listConversations(),
        messages: this.listMessages(),
        leads: this.listLeads(),
        orders: this.listOrders(),
        payments: this.listPayments(),
        followUps: this.listFollowUps(),
      };

      const tempPath = `${this.stateFilePath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify(state, null, 2), 'utf8');
      fs.renameSync(tempPath, this.stateFilePath);
    } catch (err) {
      console.error('[Pixel Agents] Failed to write commerce state:', err);
    }
  }
}
