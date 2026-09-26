import { CommerceStore } from './commerceStore.js';
import type { Message, PaymentStatus, SalesStage } from './types.js';

export interface SalesConversationResponder {
  respond(request: {
    conversationId: string;
    customerMessage: string;
    instagramMessageId?: string;
  }): Promise<{ content: string }>;
}

export interface LocalSalesMessageInput {
  instagramUserId: string;
  username?: string;
  message: string;
  messageId?: string;
}

export interface LocalSalesConversationSnapshot {
  customerId: string;
  conversationId: string;
  response: string;
  messages: Message[];
  leadStage?: SalesStage;
  orderStatus?: string;
  paymentStatus?: PaymentStatus;
}

export class SalesConversationService {
  constructor(
    private readonly store: CommerceStore,
    private readonly responder: SalesConversationResponder,
  ) {}

  async handleMessage(input: LocalSalesMessageInput): Promise<LocalSalesConversationSnapshot> {
    const instagramUserId = input.instagramUserId.trim();
    const message = input.message.trim();
    const username = input.username?.trim();

    if (!instagramUserId) throw new Error('instagramUserId is required.');
    if (!message) throw new Error('message is required.');

    let customer = this.store.findCustomerByInstagramUserId(instagramUserId);
    if (!customer) {
      customer = this.store.createCustomer({
        instagramUserId,
        ...(username ? { username } : {}),
      });
    } else if (username && username !== customer.username) {
      customer = this.store.updateCustomer(customer.id, { username });
    }

    const conversation =
      this.store
        .listConversations()
        .filter((candidate) => candidate.customerId === customer.id && candidate.status !== 'closed')
        .sort((left, right) => right.updatedAt - left.updatedAt)[0] ??
      this.store.createConversation({
        customerId: customer.id,
        status: 'open',
      });

    const result = await this.responder.respond({
      conversationId: conversation.id,
      customerMessage: message,
      ...(input.messageId ? { instagramMessageId: input.messageId } : {}),
    });

    const refreshedConversation = this.store.getConversation(conversation.id);
    if (!refreshedConversation) {
      throw new Error(`Conversation disappeared after Sales Agent response: ${conversation.id}`);
    }

    const activeLead = refreshedConversation.activeLeadId
      ? this.store.getLead(refreshedConversation.activeLeadId)
      : undefined;
    const activeOrder = refreshedConversation.activeOrderId
      ? this.store.getOrder(refreshedConversation.activeOrderId)
      : undefined;
    const payment = activeOrder
      ? this.store
          .listPayments()
          .filter((candidate) => candidate.orderId === activeOrder.id)
          .sort((left, right) => right.updatedAt - left.updatedAt)[0]
      : undefined;

    return {
      customerId: customer.id,
      conversationId: conversation.id,
      response: result.content,
      messages: this.store
        .listMessages(conversation.id)
        .slice()
        .sort((left, right) => left.createdAt - right.createdAt),
      ...(activeLead ? { leadStage: activeLead.stage } : {}),
      ...(activeOrder ? { orderStatus: activeOrder.status } : {}),
      ...(payment ? { paymentStatus: payment.status } : {}),
    };
  }
}
