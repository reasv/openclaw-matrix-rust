import { KeyedAsyncQueue } from "openclaw/plugin-sdk";

type WaitForIdleOptions = {
  timeoutMs?: number;
};

const DEFAULT_SESSION_KEY = "__matrix:session-dispatcher:default";

export class MatrixSessionDispatcher {
  private readonly queue = new KeyedAsyncQueue();
  private readonly pendingBySession = new Map<string, number>();
  private readonly idleWaiters = new Set<() => void>();
  private pendingTotal = 0;

  enqueue<T>(sessionKey: string, task: () => Promise<T>): Promise<T> {
    const key = sessionKey.trim() || DEFAULT_SESSION_KEY;
    return this.queue.enqueue(key, task, {
      onEnqueue: () => {
        this.pendingTotal += 1;
        this.pendingBySession.set(key, (this.pendingBySession.get(key) ?? 0) + 1);
      },
      onSettle: () => {
        this.pendingTotal = Math.max(0, this.pendingTotal - 1);
        const pending = (this.pendingBySession.get(key) ?? 1) - 1;
        if (pending <= 0) {
          this.pendingBySession.delete(key);
        } else {
          this.pendingBySession.set(key, pending);
        }
        if (this.pendingTotal === 0) {
          this.notifyIdle();
        }
      },
    });
  }

  getTotalPendingCount(): number {
    return this.pendingTotal;
  }

  getPendingCountForSession(sessionKey: string): number {
    const key = sessionKey.trim() || DEFAULT_SESSION_KEY;
    return this.pendingBySession.get(key) ?? 0;
  }

  async waitForIdle(opts?: WaitForIdleOptions): Promise<boolean> {
    if (this.pendingTotal === 0) {
      return true;
    }

    const timeoutMs = opts?.timeoutMs;
    return await new Promise<boolean>((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;

      const finish = (drained: boolean) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer) {
          clearTimeout(timer);
        }
        this.idleWaiters.delete(onIdle);
        resolve(drained);
      };

      const onIdle = () => {
        finish(true);
      };

      this.idleWaiters.add(onIdle);
      if (this.pendingTotal === 0) {
        finish(true);
        return;
      }

      if (typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs >= 0) {
        timer = setTimeout(() => {
          finish(false);
        }, timeoutMs);
      }
    });
  }

  private notifyIdle(): void {
    for (const waiter of [...this.idleWaiters]) {
      waiter();
    }
  }
}
