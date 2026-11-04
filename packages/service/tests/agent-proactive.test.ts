/**
 * Tests for the proactive wake loop (design-docs/ai-agent.md §6):
 * wake fires on event with context, rate-limiting batches bursts,
 * mute suppresses (whole-thing + per-category), mute persists per user.
 */
import { describe, expect, it, afterEach } from 'vitest';
import {
  ProactiveWatcher,
  defaultMuteConfig,
  type ProactiveEvent,
  type ProactiveEventType,
  type ProactiveWatcherDeps,
} from '../src/agent/proactive.js';
import { memoryPersistence } from '../src/metadataStore.js';

interface FakeSource {
  deps: ProactiveWatcherDeps;
  queued: ProactiveEvent[];
  subscribed: { events: ProactiveEventType[]; sheet?: string }[];
  unsubscribed: string[];
  now: number;
  decisions: { notify: boolean; message: string }[];
}

function fakeSource(opts: { decide?: ProactiveWatcherDeps['decide'] } = {}): FakeSource {
  const s: FakeSource = {
    queued: [],
    subscribed: [],
    unsubscribed: [],
    now: 1_000_000,
    decisions: [],
    deps: null as unknown as ProactiveWatcherDeps,
  };
  s.deps = {
    subscribe: async (events, sheet) => {
      s.subscribed.push({ events, sheet });
      return 'sub-1';
    },
    poll: async () => {
      const out = s.queued;
      s.queued = [];
      return out;
    },
    unsubscribe: async (id) => {
      s.unsubscribed.push(id);
    },
    decide: opts.decide,
    mutePersistence: memoryPersistence(),
    now: () => s.now,
  };
  return s;
}

function ev(seq: number, type: ProactiveEventType, detail: Record<string, unknown> = {}): ProactiveEvent {
  return { seq, ts: 1_000_000 + seq * 10, type, detail };
}

const watchers: ProactiveWatcher[] = [];
afterEach(async () => {
  for (const w of watchers.splice(0)) await w.close();
});

function makeWatcher(src: FakeSource, opts = {}) {
  const w = new ProactiveWatcher(src.deps, {
    pollIntervalMs: 3_600_000, // never fire on its own in tests; drive pollOnce manually
    batchWindowMs: 100,
    minPingIntervalMs: 5_000,
    maxPingsPerHour: 20,
    ...opts,
  });
  watchers.push(w);
  return w;
}

describe('proactive wake loop', () => {
  it('wake fires on event with context', async () => {
    const src = fakeSource();
    const w = makeWatcher(src);
    const watchId = await w.startWatch('alice', { events: ['cells_changed'], sheet: 'Sheet1' });
    expect(src.subscribed).toHaveLength(1);
    expect(src.subscribed[0]).toMatchObject({ events: ['cells_changed'], sheet: 'Sheet1' });

    src.queued.push(ev(1, 'cells_changed', { sheet: 'Sheet1', range: 'A1:B2' }));
    await w.pollOnce(watchId); // buffers; batch window not elapsed
    expect(w.pollWakes(watchId)).toHaveLength(0);

    src.now += 200; // past the batch window
    await w.pollOnce(watchId); // flushes
    const wakes = w.pollWakes(watchId);
    expect(wakes).toHaveLength(1);
    const wake = wakes[0]!;
    expect(wake.watchId).toBe(watchId);
    expect(wake.categories).toEqual(['cells_changed']);
    expect(wake.summary).toContain('Sheet1');
    expect(wake.summary).toContain('1 cell change');
    // Context hands the agent specifics, not bare counts.
    expect(wake.context).toContain('alice');
    expect(wake.context).toContain('A1:B2');
    expect(wake.events).toHaveLength(1);
    // Drained: second poll returns nothing.
    expect(w.pollWakes(watchId)).toHaveLength(0);
  });

  it('rate-limiting batches bursts into one wake', async () => {
    const src = fakeSource();
    const w = makeWatcher(src);
    const watchId = await w.startWatch('alice', { events: ['cells_changed', 'recalc_complete'] });

    // Burst of 6 events across two poll ticks, inside one batch window.
    src.queued.push(ev(1, 'cells_changed'), ev(2, 'cells_changed'), ev(3, 'recalc_complete'));
    await w.pollOnce(watchId);
    src.queued.push(ev(4, 'cells_changed'), ev(5, 'cells_changed'), ev(6, 'recalc_complete'));
    await w.pollOnce(watchId);
    src.now += 200;
    await w.pollOnce(watchId);

    const wakes = w.pollWakes(watchId);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.events).toHaveLength(6);
    expect(wakes[0]!.categories.sort()).toEqual(['cells_changed', 'recalc_complete']);
    expect(wakes[0]!.summary).toContain('4 cell changes');
    expect(wakes[0]!.summary).toContain('2 recalculations finished');

    // A second batch inside the minimum ping interval does NOT ping again —
    // it re-buffers and joins the next wake instead of spamming.
    src.queued.push(ev(7, 'cells_changed'));
    src.now += 200;
    await w.pollOnce(watchId);
    expect(w.pollWakes(watchId)).toHaveLength(0);

    // After the minimum interval passes, the buffered events ping once.
    src.now += 6_000;
    await w.pollOnce(watchId);
    const later = w.pollWakes(watchId);
    expect(later).toHaveLength(1);
    expect(later[0]!.events).toHaveLength(1);
  });

  it('the agent decider can suppress a batch', async () => {
    const src = fakeSource({
      decide: async (ctx) => {
        // The agent looked at the context and judged it noise.
        expect(ctx.events.length).toBeGreaterThan(0);
        return { notify: false, message: '' };
      },
    });
    const w = makeWatcher(src);
    const watchId = await w.startWatch('alice', { events: ['recalc_complete'] });
    src.queued.push(ev(1, 'recalc_complete'));
    src.now += 200;
    await w.pollOnce(watchId);
    expect(w.pollWakes(watchId)).toHaveLength(0);
  });

  it('stopWatch removes the session and unsubscribes', async () => {
    const src = fakeSource();
    const w = makeWatcher(src);
    const watchId = await w.startWatch('alice', { events: ['cells_changed'] });
    expect(await w.stopWatch(watchId)).toBe(true);
    expect(src.unsubscribed).toEqual(['sub-1']);
    expect(await w.stopWatch(watchId)).toBe(false);
  });

  it('rejects empty event lists', async () => {
    const src = fakeSource();
    const w = makeWatcher(src);
    await expect(w.startWatch('alice', { events: [] })).rejects.toThrow(/at least one valid/);
    await expect(w.startWatch('alice', { events: ['bogus' as ProactiveEventType] })).rejects.toThrow(
      /at least one valid/,
    );
  });
});

describe('proactive mute', () => {
  async function watchWithEvents(
    src: FakeSource,
    w: ProactiveWatcher,
    principal: string,
  ): Promise<string> {
    const watchId = await w.startWatch(principal, { events: ['cells_changed', 'recalc_complete'] });
    src.queued.push(ev(1, 'cells_changed'), ev(2, 'recalc_complete'));
    src.now += 200;
    await w.pollOnce(watchId);
    return watchId;
  }

  it('defaults to unmuted', () => {
    const src = fakeSource();
    const w = makeWatcher(src);
    expect(w.getMuteConfig('alice')).toEqual(defaultMuteConfig());
  });

  it('whole-thing mute suppresses every category', async () => {
    const src = fakeSource();
    const w = makeWatcher(src);
    w.setMuteConfig('alice', { mutedAll: true });
    const watchId = await watchWithEvents(src, w, 'alice');
    expect(w.pollWakes(watchId)).toHaveLength(0);
  });

  it('per-category mute suppresses only that category', async () => {
    const src = fakeSource();
    const w = makeWatcher(src);
    w.setMuteConfig('alice', { muted: { recalc_complete: true } });
    const watchId = await watchWithEvents(src, w, 'alice');
    const wakes = w.pollWakes(watchId);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.categories).toEqual(['cells_changed']);
    expect(wakes[0]!.events).toHaveLength(1);
    expect(wakes[0]!.summary).toContain('1 cell change');
    expect(wakes[0]!.summary).not.toContain('recalculation');
  });

  it('mute is per user', async () => {
    const src = fakeSource();
    const w = makeWatcher(src);
    w.setMuteConfig('alice', { mutedAll: true });
    const bobWatch = await watchWithEvents(src, w, 'bob');
    expect(w.pollWakes(bobWatch)).toHaveLength(1); // bob is not muted
    expect(w.getMuteConfig('bob')).toEqual(defaultMuteConfig());
  });

  it('mute persists across watcher instances (service metadata store)', async () => {
    const persistence = memoryPersistence();
    const src1 = fakeSource();
    src1.deps.mutePersistence = persistence;
    const w1 = makeWatcher(src1);
    w1.setMuteConfig('alice', { mutedAll: true, muted: { sheet_added: true } });

    const src2 = fakeSource();
    src2.deps.mutePersistence = persistence;
    const w2 = new ProactiveWatcher(src2.deps, { pollIntervalMs: 3_600_000 });
    watchers.push(w2);
    expect(w2.getMuteConfig('alice')).toEqual({
      mutedAll: true,
      muted: {
        cells_changed: false,
        recalc_complete: false,
        sheet_added: true,
        sheet_removed: false,
      },
    });
  });

  it('setMuteConfig patches (does not clobber other fields)', () => {
    const src = fakeSource();
    const w = makeWatcher(src);
    w.setMuteConfig('alice', { muted: { cells_changed: true } });
    const next = w.setMuteConfig('alice', { mutedAll: true });
    expect(next.muted.cells_changed).toBe(true);
    expect(next.muted.recalc_complete).toBe(false);
    expect(next.mutedAll).toBe(true);
  });
});
