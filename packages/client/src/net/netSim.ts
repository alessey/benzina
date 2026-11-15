/**
 * Fakes a bad network in one direction, for testing netcode on localhost.
 * Models TCP-like behaviour: messages are delayed (latency + jitter) but never reordered,
 * and "loss" shows up as a stall (retransmit) that also holds back everything behind it.
 */
export class NetSim {
  private lastDelivery = 0;

  constructor(
    private readonly oneWayMs: number,
    private readonly jitterMs: number,
    private readonly lossPct: number,
  ) {}

  get active(): boolean {
    return this.oneWayMs > 0 || this.jitterMs > 0 || this.lossPct > 0;
  }

  deliver(fn: () => void): void {
    if (!this.active) {
      fn();
      return;
    }
    const now = performance.now();
    let delay = this.oneWayMs + Math.random() * this.jitterMs;
    // A lost TCP segment costs roughly one retransmission timeout (at least ~200 ms).
    if (Math.random() * 100 < this.lossPct) delay += Math.max(200, this.oneWayMs * 4);
    const at = Math.max(now + delay, this.lastDelivery);
    this.lastDelivery = at;
    setTimeout(fn, at - now);
  }
}
