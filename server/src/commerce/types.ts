export interface Money {
  amountMinor: number;
  currency: string;
}

export interface Product {
  id: string;
  sku: string;
  name: string;
  description: string;
  price: Money;
  stockQuantity: number;
  active: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface Customer {
  id: string;
  instagramUserId: string;
  username?: string;
  displayName?: string;
  phone?: string;
  shippingAddress?: string;
  createdAt: number;
  updatedAt: number;
}

export type ConversationStatus = 'open' | 'handoff' | 'closed';

export interface Conversation {
  id: string;
  customerId: string;
  status: ConversationStatus;
  activeLeadId?: string;
  activeOrderId?: string;
  lastMessageAt?: number;
  createdAt: number;
  updatedAt: number;
}

export type MessageDirection = 'inbound' | 'outbound';
export type MessageAuthor = 'customer' | 'sales_agent' | 'human' | 'system';

export interface Message {
  id: string;
  conversationId: string;
  direction: MessageDirection;
  author: MessageAuthor;
  text: string;
  instagramMessageId?: string;
  replyToInstagramMessageId?: string;
  createdAt: number;
}

export type SalesStage =
  | 'new_lead'
  | 'need_discovery'
  | 'interested'
  | 'objection'
  | 'ready_to_buy'
  | 'order_details'
  | 'payment_pending'
  | 'sold'
  | 'follow_up'
  | 'human_handoff'
  | 'lost';

export interface Lead {
  id: string;
  customerId: string;
  conversationId: string;
  productId: string;
  stage: SalesStage;
  quantity?: number;
  objections: string[];
  followUpAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface OrderItem {
  productId: string;
  quantity: number;
  unitPrice: Money;
}

export type OrderStatus =
  | 'draft'
  | 'awaiting_payment'
  | 'paid'
  | 'cancelled'
  | 'fulfilled';

export interface Order {
  id: string;
  customerId: string;
  leadId: string;
  items: OrderItem[];
  subtotal: Money;
  shipping: Money;
  total: Money;
  status: OrderStatus;
  createdAt: number;
  updatedAt: number;
}

export type PaymentStatus = 'pending' | 'paid' | 'failed' | 'expired' | 'refunded';

export interface Payment {
  id: string;
  orderId: string;
  provider: string;
  status: PaymentStatus;
  amount: Money;
  externalReference?: string;
  checkoutUrl?: string;
  createdAt: number;
  updatedAt: number;
}

export type FollowUpStatus = 'scheduled' | 'sent' | 'completed' | 'cancelled';

export interface FollowUp {
  id: string;
  customerId: string;
  conversationId: string;
  leadId: string;
  scheduledAt: number;
  reason: string;
  status: FollowUpStatus;
  createdAt: number;
  updatedAt: number;
}
