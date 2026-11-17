export type LeaseOwner = "chat" | "task" | "bench" | "test";

export interface Lease {
  id: string;
  owner: LeaseOwner;
  label: string;
  acquiredAt: number;
  release: () => void;
}

export class RuntimeLeaseManager {
  private activeLease: Lease | null = null;
  private queue: Array<{
    owner: LeaseOwner;
    label: string;
    resolve: (lease: Lease) => void;
    reject: (err: Error) => void;
  }> = [];

  isBusy(): boolean {
    return this.activeLease !== null;
  }

  currentOwner(): Lease | null {
    return this.activeLease;
  }

  /**
   * Immediately attempts to acquire the lease. Returns null if busy.
   */
  acquire(owner: LeaseOwner, label: string): Lease | null {
    if (this.activeLease !== null) {
      return null;
    }
    const lease: Lease = {
      id: `${owner}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      owner,
      label,
      acquiredAt: Date.now(),
      release: () => {
        if (this.activeLease?.id === lease.id) {
          this.activeLease = null;
          this.pump();
        }
      }
    };
    this.activeLease = lease;
    return lease;
  }

  /**
   * Acquires the lease or queues until available.
   */
  acquireOrWait(owner: LeaseOwner, label: string, timeoutMs = 60_000): Promise<Lease> {
    const immediate = this.acquire(owner, label);
    if (immediate) return Promise.resolve(immediate);

    return new Promise<Lease>((resolve, reject) => {
      const entry = {
        owner,
        label,
        resolve: (lease: Lease) => { clearTimeout(timer); resolve(lease); },
        reject: (err: Error) => { clearTimeout(timer); reject(err); }
      };
      /* the wait is cancelled by entry identity: the queue holds the wrapper, not the promise's own resolve */
      const timer = setTimeout(() => {
        const idx = this.queue.indexOf(entry);
        if (idx >= 0) {
          this.queue.splice(idx, 1);
          reject(new Error("NPU is currently busy with another task (lease timeout)"));
        }
      }, timeoutMs);

      this.queue.push(entry);
    });
  }

  private pump() {
    if (this.activeLease !== null || this.queue.length === 0) return;
    const next = this.queue.shift();
    if (!next) return;
    const lease = this.acquire(next.owner, next.label);
    if (lease) {
      next.resolve(lease);
    } else {
      this.queue.unshift(next);
    }
  }

  reset() {
    this.activeLease = null;
    const queued = this.queue;
    this.queue = [];
    for (const item of queued) {
      item.reject(new Error("Runtime lease manager reset"));
    }
  }
}

export const runtimeLease = new RuntimeLeaseManager();
