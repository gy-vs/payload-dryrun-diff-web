import {afterEach, describe, expect, it, vi} from 'vitest';
import {createCatalogService} from '../src/server/catalog';
import {GenerationStaleError, RunManager, type EventSink} from '../src/server/runManager';
import type {RunEvent} from '../src/shared/types';

function collected(): {events: RunEvent[]; ids: (number | undefined)[]; sink: EventSink} {
  const events: RunEvent[] = [];
  const ids: (number | undefined)[] = [];
  const sink: EventSink = {
    onEvent(event, id) {
      events.push(event);
      ids.push(id);
    },
  };
  return {events, ids, sink};
}

function whenDone(events: RunEvent[]): Promise<void> {
  return new Promise(resolve => {
    if (events.some(e => e.type === 'run_completed')) return resolve();
    const timer = setInterval(() => {
      if (events.some(e => e.type === 'run_completed')) {
        clearInterval(timer);
        resolve();
      }
    }, 5);
  });
}

describe('RunManager', () => {
  afterEach(() => vi.useRealTimers());

  it('processes all samples with bounded concurrency and emits structured results', async () => {
    const catalog = createCatalogService();
    const manager = new RunManager({catalog, concurrency: 2, delayMs: 1});
    const run = manager.createRun({leftRevisionId: 'rev-legacy', rightRevisionId: 'rev-current'});
    expect(run.sampleIds.length).toBeGreaterThanOrEqual(7);

    const {events, sink} = collected();
    manager.subscribe(run.runId, sink);
    await whenDone(events);

    const finalRun = manager.get(run.runId)!;
    expect(finalRun.status).toBe('completed');
    expect(Object.keys(finalRun.results)).toHaveLength(run.sampleIds.length);

    // Concurrency ceiling: at most 2 samples in flight simultaneously.
    let inFlight = 0;
    let maxInFlight = 0;
    for (const event of events) {
      if (event.type === 'sample_started') {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
      }
      if (event.type === 'sample_result') inFlight -= 1;
    }
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(maxInFlight).toBe(2);

    // The poisoned sample fails only on the right side.
    const poison = finalRun.results['s-side-failure'];
    expect(poison.status).toBe('failed');
    expect(poison.failures[0].side).toBe('right');

    // Reordered orders diff by stable key, no whole add/remove.
    const reorder = finalRun.results['s-array-reorder'];
    expect(reorder.status).toBe('diffed');
    expect(reorder.diagnostics).toEqual([]);
    expect(reorder.diffs.filter(d => d.type === 'added' || d.type === 'removed')).toHaveLength(0);

    // Duplicate key diagnostic exists for s-duplicate-key.
    const dup = finalRun.results['s-duplicate-key'];
    expect(dup.diagnostics.some(d => d.code === 'duplicate_stable_key')).toBe(true);
  });

  it('cancel drops queued samples and ignores late in-flight results', async () => {
    const catalog = createCatalogService();
    // concurrency 1 + a generous delay: samples queue up; cancel after first start.
    const manager = new RunManager({catalog, concurrency: 1, delayMs: 30});
    const run = manager.createRun({leftRevisionId: 'rev-legacy', rightRevisionId: 'rev-current'});
    const {events, sink} = collected();
    manager.subscribe(run.runId, sink);

    await new Promise(r => setTimeout(r, 5));
    manager.cancel(run.runId);

    await new Promise(r => setTimeout(r, 120));

    const finalRun = manager.get(run.runId)!;
    expect(finalRun.status).toBe('cancelled');
    // In-flight result arriving after cancel is dropped: zero or one result.
    expect(Object.keys(finalRun.results).length).toBeLessThanOrEqual(1);
    const completed = events.find(e => e.type === 'run_completed');
    expect(completed && completed.type === 'run_completed' && completed.status).toBe('cancelled');
    // No late sample_result after completion.
    const completionIndex = events.findIndex(e => e.type === 'run_completed');
    expect(events.slice(completionIndex + 1)).toHaveLength(0);
  });

  it('replays a snapshot for new subscribers and durable events from lastEventId', async () => {
    const catalog = createCatalogService();
    const manager = new RunManager({catalog, concurrency: 2, delayMs: 1, bufferSize: 100});
    const run = manager.createRun({leftRevisionId: 'rev-legacy', rightRevisionId: 'rev-current'});
    const first = collected();
    manager.subscribe(run.runId, first.sink);
    await whenDone(first.events);

    // Late subscriber with no cursor: gets a snapshot, not history replay.
    const late = collected();
    const unsub = manager.subscribe(run.runId, late.sink, 0)!;
    expect(late.events[0].type).toBe('snapshot');
    const snapshot = late.events[0] as unknown as {run: {status: string}; type: string};
    expect(snapshot.type).toBe('snapshot');
    expect(snapshot.run.status).toBe('completed');
    expect(late.events).toHaveLength(1);
    unsub();

    // Replay from mid-history cursor: only newer durable events, no snapshot.
    const mid = collected();
    manager.subscribe(run.runId, mid.sink, 2);
    expect(mid.events.map(e => e.type as string)).not.toContain('snapshot');
    expect(mid.ids[0]).toBeGreaterThan(2);
  });

  it('sends snapshot when the cursor falls out of the bounded buffer', async () => {
    const catalog = createCatalogService();
    const manager = new RunManager({catalog, concurrency: 4, delayMs: 0, bufferSize: 4});
    const run = manager.createRun({leftRevisionId: 'rev-legacy', rightRevisionId: 'rev-current'});
    const first = collected();
    manager.subscribe(run.runId, first.sink);
    await whenDone(first.events);

    const backfill = collected();
    manager.subscribe(run.runId, backfill.sink, 1);
    expect(backfill.events[0].type).toBe('snapshot');
  });

  it('rejects runs pinned to an older sample generation', () => {
    const catalog = createCatalogService();
    catalog.rotateTo(2);
    const manager = new RunManager({catalog, delayMs: 0});
    expect(() =>
      manager.createRun({
        leftRevisionId: 'rev-legacy',
        rightRevisionId: 'rev-current',
        expectedGeneration: 1,
      }),
    ).toThrow(GenerationStaleError);
  });

  it('old runs keep their sample generation; new runs see the updated set', async () => {
    const catalog = createCatalogService();
    const manager = new RunManager({catalog, concurrency: 2, delayMs: 1});
    const run1 = manager.createRun({leftRevisionId: 'rev-legacy', rightRevisionId: 'rev-current'});
    expect(run1.sampleGeneration).toBe(1);
    expect(run1.sampleIds).not.toContain('s-canary-failure');

    catalog.rotateTo(2);
    const run2 = manager.createRun({leftRevisionId: 'rev-legacy', rightRevisionId: 'rev-current'});
    expect(run2.sampleGeneration).toBe(2);
    expect(run2.sampleIds).toContain('s-canary-failure');

    // Old run continues unaffected against its captured samples.
    const events: RunEvent[] = [];
    manager.subscribe(run1.runId, {onEvent: e => events.push(e)});
    await whenDone(events);
    expect(manager.get(run1.runId)!.sampleIds).toHaveLength(run1.sampleIds.length);
  });

  it('expires sessions after ttl and drops the run', async () => {
    vi.useFakeTimers();
    const catalog = createCatalogService();
    const manager = new RunManager({catalog, delayMs: 0, ttlMs: 50});
    const run = manager.createRun({leftRevisionId: 'rev-legacy', rightRevisionId: 'rev-current'});
    const {events, sink} = collected();
    manager.subscribe(run.runId, sink);

    await vi.advanceTimersByTimeAsync(0);
    await vi.runAllTimersAsync();
    // Completion event happens first; expiry after ttl.
    await vi.advanceTimersByTimeAsync(60);

    expect(events.map(e => e.type)).toContain('run_expired');
    expect(manager.get(run.runId)).toBeUndefined();
  }, 1000);

  it('canary revision fails strict validation with an attributed path', async () => {
    const catalog = createCatalogService();
    catalog.rotateTo(2);
    const manager = new RunManager({catalog, concurrency: 2, delayMs: 0});
    const run = manager.createRun({leftRevisionId: 'rev-legacy', rightRevisionId: 'rev-canary'});
    const events: RunEvent[] = [];
    manager.subscribe(run.runId, {onEvent: e => events.push(e)});
    await whenDone(events);
    const result = manager.get(run.runId)!.results['s-canary-failure'];
    expect(result.status).toBe('failed');
    expect(result.failures[0].path).toBe('$.age');
    expect(result.failures[0].side).toBe('right');
  });
});
