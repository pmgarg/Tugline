export interface CartLine {
  sku: string;
  qty: number;
  price: number;
}

export class Cart {
  private lines = new Map<string, CartLine>();

  add(sku: string, price: number, qty = 1): void {
    const cur = this.lines.get(sku);
    this.lines.set(sku, { sku, price, qty: (cur?.qty ?? 0) + qty });
  }

  remove(sku: string): void {
    this.lines.delete(sku);
  }

  count(): number {
    return [...this.lines.values()].reduce((n, l) => n + l.qty, 0);
  }

  amount(): number {
    return [...this.lines.values()].reduce((s, l) => s + l.qty * l.price, 0);
  }
}
