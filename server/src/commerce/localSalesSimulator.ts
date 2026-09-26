import type {
  CommercePaymentGateway,
  CommerceShippingQuoteProvider,
} from './commerceTools.js';
import type { CommerceStore } from './commerceStore.js';
import type { Money, Product } from './types.js';

function parseNonNegativeInteger(value: string | undefined, label: string): number | null {
  if (value === undefined || value.trim() === '') return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
  return parsed;
}

export function seedLocalSalesProductFromEnv(
  store: CommerceStore,
  env: NodeJS.ProcessEnv = process.env,
): Product | null {
  const sku = env['SALES_PRODUCT_SKU']?.trim();
  const name = env['SALES_PRODUCT_NAME']?.trim();
  const description = env['SALES_PRODUCT_DESCRIPTION']?.trim();
  const currency = env['SALES_PRODUCT_CURRENCY']?.trim();
  const priceMinor = parseNonNegativeInteger(env['SALES_PRODUCT_PRICE_MINOR'], 'SALES_PRODUCT_PRICE_MINOR');
  const stock = parseNonNegativeInteger(env['SALES_PRODUCT_STOCK'], 'SALES_PRODUCT_STOCK');

  const anyConfigured =
    sku !== undefined ||
    name !== undefined ||
    description !== undefined ||
    currency !== undefined ||
    priceMinor !== null ||
    stock !== null;

  if (!anyConfigured) return null;

  if (!sku || !name || !description || !currency || priceMinor === null || stock === null) {
    throw new Error(
      'Local sales product config is incomplete. Set SALES_PRODUCT_SKU, SALES_PRODUCT_NAME, SALES_PRODUCT_DESCRIPTION, SALES_PRODUCT_PRICE_MINOR, SALES_PRODUCT_CURRENCY, and SALES_PRODUCT_STOCK.',
    );
  }

  const existing = store.findProductBySku(sku);
  if (existing) {
    return store.updateProduct(existing.id, {
      name,
      description,
      price: { amountMinor: priceMinor, currency },
      stockQuantity: stock,
      active: true,
    });
  }

  return store.createProduct({
    sku,
    name,
    description,
    price: { amountMinor: priceMinor, currency },
    stockQuantity: stock,
    active: true,
  });
}

export class LocalSimulatorShippingProvider implements CommerceShippingQuoteProvider {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async quote(): Promise<Money> {
    const amountMinor = parseNonNegativeInteger(
      this.env['SALES_SHIPPING_MINOR'],
      'SALES_SHIPPING_MINOR',
    );
    const currency = this.env['SALES_PRODUCT_CURRENCY']?.trim();

    if (amountMinor === null || !currency) {
      throw new Error(
        'Local simulator shipping is not configured. Set SALES_SHIPPING_MINOR and SALES_PRODUCT_CURRENCY.',
      );
    }

    return { amountMinor, currency };
  }
}

export class LocalSimulatorPaymentGateway implements CommercePaymentGateway {
  async createCheckout(order: { id: string }): Promise<{
    provider: string;
    externalReference: string;
    checkoutUrl: string;
  }> {
    return {
      provider: 'local-simulator',
      externalReference: `sim-${order.id}`,
      checkoutUrl: `https://pixel-agents.invalid/pay/${encodeURIComponent(order.id)}`,
    };
  }
}
