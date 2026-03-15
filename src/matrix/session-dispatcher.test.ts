import assert from "node:assert/strict";
import test from "node:test";

import { MatrixSessionDispatcher } from "./session-dispatcher.js";

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

test("serializes work for the same session key", async () => {
  const dispatcher = new MatrixSessionDispatcher();
  const releaseFirst = createDeferred<void>();
  const firstStarted = createDeferred<void>();
  const order: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;

  const first = dispatcher.enqueue("agent:main:matrix:room-a", async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    order.push("start:first");
    firstStarted.resolve();
    await releaseFirst.promise;
    order.push("end:first");
    inFlight -= 1;
  });

  const second = dispatcher.enqueue("agent:main:matrix:room-a", async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    order.push("start:second");
    order.push("end:second");
    inFlight -= 1;
  });

  await firstStarted.promise;
  assert.deepEqual(order, ["start:first"]);
  assert.equal(dispatcher.getPendingCountForSession("agent:main:matrix:room-a"), 2);

  releaseFirst.resolve();
  await Promise.all([first, second]);

  assert.equal(maxInFlight, 1);
  assert.deepEqual(order, ["start:first", "end:first", "start:second", "end:second"]);
  assert.equal(dispatcher.getTotalPendingCount(), 0);
});

test("runs different session keys in parallel", async () => {
  const dispatcher = new MatrixSessionDispatcher();
  const releaseBoth = createDeferred<void>();
  const started: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;

  const first = dispatcher.enqueue("agent:main:matrix:room-a", async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    started.push("first");
    await releaseBoth.promise;
    inFlight -= 1;
  });

  const second = dispatcher.enqueue("agent:main:matrix:room-b", async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    started.push("second");
    await releaseBoth.promise;
    inFlight -= 1;
  });

  while (started.length < 2) {
    await Promise.resolve();
  }

  assert.equal(maxInFlight, 2);
  assert.deepEqual(new Set(started), new Set(["first", "second"]));

  releaseBoth.resolve();
  await Promise.all([first, second]);
});

test("waitForIdle reports timeout and later succeeds after draining", async () => {
  const dispatcher = new MatrixSessionDispatcher();
  const release = createDeferred<void>();

  const run = dispatcher.enqueue("agent:main:matrix:room-a", async () => {
    await release.promise;
  });

  assert.equal(await dispatcher.waitForIdle({ timeoutMs: 10 }), false);

  release.resolve();
  await run;

  assert.equal(await dispatcher.waitForIdle({ timeoutMs: 10 }), true);
});
