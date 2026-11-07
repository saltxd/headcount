/**
 * The mainnet reader's manners: at most 2 requests a second, retries with backoff, and only the
 * keyless FastNEAR hosts. A fake clock and fake network stand in for both, so no test waits or
 * touches the internet.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { MAX_PER_SECOND, createPacedFetch, type FetchLike } from "../screener/paced-fetch.ts";

/** A clock that only moves when something sleeps. */
const fakeClock = () => {
  let now = 0;
  const sleeps: number[] = [];
  return {
    now: () => now,
    sleep: async (ms: number): Promise<void> => {
      sleeps.push(ms);
      now += ms;
    },
    sleeps,
    advance: (ms: number): void => {
      now += ms;
    },
  };
};

const ok = (body: unknown = {}): Response => new Response(JSON.stringify(body), { status: 200 });
const URL_RPC = "https://free.rpc.fastnear.com";

test("requests start at least 500 ms apart, whatever the caller does", async () => {
  const clock = fakeClock();
  const starts: number[] = [];
  const base: FetchLike = async () => {
    starts.push(clock.now());
    return ok();
  };
  const paced = createPacedFetch({ base, sleep: clock.sleep, now: clock.now });
  await Promise.all([1, 2, 3, 4, 5].map(() => paced(URL_RPC, { method: "POST" })));
  assert.equal(starts.length, 5);
  for (let i = 1; i < starts.length; i += 1) assert.ok((starts[i] as number) - (starts[i - 1] as number) >= 500, `gap ${i}: ${starts.join(",")}`);
});

test("time the caller already spent counts toward the gap", async () => {
  const clock = fakeClock();
  const base: FetchLike = async () => ok();
  const paced = createPacedFetch({ base, sleep: clock.sleep, now: clock.now });
  await paced(URL_RPC, {});
  clock.advance(5000);
  await paced(URL_RPC, {});
  assert.deepEqual(clock.sleeps, [], "no sleep needed when 5 s already passed");
});

test("refuses a rate above 2 requests a second", () => {
  assert.equal(MAX_PER_SECOND, 2);
  assert.throws(() => createPacedFetch({ base: async () => ok(), perSecond: 3 }), /at most 2/);
  assert.throws(() => createPacedFetch({ base: async () => ok(), perSecond: 0 }), /at most 2/);
});

test("refuses a host that is not on the keyless allow-list, and never sends the request", async () => {
  let sent = 0;
  const paced = createPacedFetch({ base: async () => (sent += 1, ok()) });
  await assert.rejects(() => paced("https://rpc.mainnet.near.org", {}), /not on the allow-list/);
  await assert.rejects(() => paced("http://free.rpc.fastnear.com", {}), /not on the allow-list/);
  await assert.rejects(() => paced("https://api.fastnear.com.evil.example/x", {}), /not on the allow-list/);
  assert.equal(sent, 0);
});

test("retries 429 and 5xx with doubling backoff, then returns the good answer", async () => {
  const clock = fakeClock();
  const statuses = [429, 503, 200];
  const base: FetchLike = async () => {
    const status = statuses.shift() ?? 500;
    return status === 200 ? ok({ fine: true }) : new Response("slow down", { status });
  };
  const paced = createPacedFetch({ base, sleep: clock.sleep, now: clock.now, backoffMs: 1000 });
  const response = await paced(URL_RPC, {});
  assert.deepEqual(await response.json(), { fine: true });
  // each attempt is also paced 500 ms after the last; the backoff waits are 1000 then 2000
  assert.ok(clock.sleeps.includes(1000) && clock.sleeps.includes(2000), clock.sleeps.join(","));
});

test("honours Retry-After, and a network error counts as a retry", async () => {
  const clock = fakeClock();
  let call = 0;
  const base: FetchLike = async () => {
    call += 1;
    if (call === 1) return new Response("", { status: 429, headers: { "retry-after": "7" } });
    if (call === 2) throw new TypeError("fetch failed");
    return ok();
  };
  const paced = createPacedFetch({ base, sleep: clock.sleep, now: clock.now, backoffMs: 1000 });
  assert.equal((await paced(URL_RPC, {})).status, 200);
  assert.ok(clock.sleeps.includes(7000), clock.sleeps.join(","));
  assert.equal(call, 3);
});

test("a 4xx that is not 429 is the caller's to see, not retried", async () => {
  let call = 0;
  const base: FetchLike = async () => (call += 1, new Response("bad request", { status: 400 }));
  const paced = createPacedFetch({ base, sleep: fakeClock().sleep });
  assert.equal((await paced(URL_RPC, {})).status, 400);
  assert.equal(call, 1);
});

test("gives up after the configured attempts and says what failed", async () => {
  const clock = fakeClock();
  let call = 0;
  const base: FetchLike = async () => (call += 1, new Response("down", { status: 503 }));
  const paced = createPacedFetch({ base, sleep: clock.sleep, now: clock.now, attempts: 3 });
  await assert.rejects(() => paced(URL_RPC, {}), /HTTP 503.*after 3 attempts/);
  assert.equal(call, 3);
});

test("counts every request it sends, retries included", async () => {
  const clock = fakeClock();
  let call = 0;
  const base: FetchLike = async () => (call += 1, call === 1 ? new Response("", { status: 502 }) : ok());
  const paced = createPacedFetch({ base, sleep: clock.sleep, now: clock.now });
  await paced(URL_RPC, {});
  await paced(URL_RPC, {});
  assert.equal(paced.requests, 3);
});

test("after a 429 the gap doubles for the rest of the run and never shrinks back", async () => {
  const clock = fakeClock();
  const starts: number[] = [];
  let call = 0;
  const base: FetchLike = async () => {
    starts.push(clock.now());
    call += 1;
    return call === 1 ? new Response("", { status: 429 }) : ok();
  };
  const paced = createPacedFetch({ base, sleep: clock.sleep, now: clock.now, backoffMs: 100 });
  for (let i = 0; i < 4; i += 1) await paced(URL_RPC, {});
  const gaps = starts.slice(1).map((t, i) => t - (starts[i] as number));
  assert.ok(gaps.slice(1).every((g) => g >= 1000), `gaps after the 429: ${gaps.join(",")}`);
});
