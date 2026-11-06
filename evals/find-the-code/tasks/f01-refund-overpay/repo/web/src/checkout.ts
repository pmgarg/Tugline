import { Cart } from './cart';
import { withBackoff } from './retry';

export async function placeOrder(cart: Cart, cardToken: string): Promise<string> {
  if (!cart.count()) throw new Error('empty cart');
  const res = await withBackoff(() =>
    fetch('/api/orders', { method: 'POST', body: JSON.stringify({ amount: cart.amount(), cardToken }) }),
  );
  if (!res.ok) throw new Error(`payment declined (${res.status})`);
  return (await res.json()).orderId;
}
