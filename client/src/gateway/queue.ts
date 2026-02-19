export class OutboundQueue<T> {
  private readonly maxSize: number;
  private items: T[] = [];

  constructor(maxSize = 200) {
    this.maxSize = maxSize;
  }

  enqueue(item: T): boolean {
    if (this.items.length >= this.maxSize) {
      return false;
    }
    this.items.push(item);
    return true;
  }

  drain(handler: (item: T) => void): void {
    const pending = this.items;
    this.items = [];
    for (const item of pending) {
      handler(item);
    }
  }

  clear(): void {
    this.items = [];
  }

  size(): number {
    return this.items.length;
  }
}

