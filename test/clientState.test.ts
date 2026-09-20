import {describe, expect, it} from 'vitest';
import {clientReducer, initialClientState} from '../src/client/state';
import type {RunSnapshot, SampleResult} from '../src/shared/types';
import {buildBuckets, resultsForPath, summarize} from '../src/shared/summary';

function baseRun(): RunSnapshot {
  return {
    runId: 'r1',
    status: 'running',
    leftRevisionId: 'l',
    rightRevisionId: 'r',
    sampleGeneration: 1,
    sampleIds: ['s1', 's2'],
    inFlight: [],
    stableKeys: {},
    concurrency: 2,
    results: {},
    createdAt: new Date(0).toISOString(),
  };
}

const sampleResult = (sampleId: string): SampleResult => ({
  sampleId,
  status: 'diffed',
  diffs: [
    {path: '$.orders[key="A"].amount', type: 'added', right: 1},
    {path: '$.tags', type: 'type_changed', left: 'x', right: ['x'], leftType: 'string', rightType: 'array'},
  ],
  diagnostics: [],
  failures: [],
  durationMs: 3,
});

const failedResult = (sampleId: string): SampleResult => ({
  sampleId,
  status: 'failed',
  diffs: [],
  diagnostics: [],
  failures: [{side: 'right', stage: 'transform', path: '$.age', message: 'boom'}],
  durationMs: 4,
});

describe('clientReducer', () => {
  it('applies sample results incrementally and tracks partial progress', () => {
    const run = baseRun();
    let state = clientReducer(initialClientState, {type: 'run_created', run});
    expect(state.connection).toBe('connecting');

    state = clientReducer(state, {
      type: 'event',
      id: 1,
      event: {type: 'sample_started', runId: 'r1', sampleId: 's1', at: ''},
    });
    expect(state.run!.inFlight).toEqual(['s1']);

    state = clientReducer(state, {
      type: 'event',
      id: 2,
      event: {type: 'sample_result', runId: 'r1', sample: sampleResult('s1'), processed: 1, total: 2, at: ''},
    });
    expect(state.run!.inFlight).toEqual([]);
    expect(Object.keys(state.run!.results)).toEqual(['s1']);
    expect(state.lastEventId).toBe(2);
  });

  it('ignores duplicate and older events (safe reconnect replay)', () => {
    let state = clientReducer(initialClientState, {type: 'run_created', run: baseRun()});
    const event = {
      type: 'sample_result' as const,
      runId: 'r1',
      sample: sampleResult('s1'),
      processed: 1,
      total: 2,
      at: '',
    };
    state = clientReducer(state, {type: 'event', id: 5, event});
    const once = state.run!.results;
    state = clientReducer(state, {type: 'event', id: 5, event}); // same id
    state = clientReducer(state, {type: 'event', id: 4, event: {...event, sample: sampleResult('s2')}}); // stale id
    expect(state.run!.results).toBe(once);
    expect(Object.keys(state.run!.results)).toEqual(['s1']);
    expect(state.lastEventId).toBe(5);
  });

  it('never accepts late events for a previous run', () => {
    let state = clientReducer(initialClientState, {type: 'run_created', run: baseRun()});
    state = clientReducer(state, {
      type: 'event',
      id: 9,
      event: {type: 'sample_result', runId: 'OTHER', sample: sampleResult('s1'), processed: 1, total: 2, at: ''},
    });
    expect(state.run!.results).toEqual({});
  });

  it('snapshot replaces state and flags buffer loss when behind', () => {
    let state = clientReducer(initialClientState, {type: 'run_created', run: baseRun()});
    state = clientReducer(state, {
      type: 'event',
      id: 3,
      event: {type: 'sample_started', runId: 'r1', sampleId: 's1', at: ''},
    });
    const snapshotted = {...baseRun(), status: 'completed' as const, results: {s1: sampleResult('s1')}};
    state = clientReducer(state, {
      type: 'snapshot',
      event: {type: 'snapshot', lastEventId: 20, run: snapshotted},
    });
    expect(state.run!.status).toBe('completed');
    expect(state.bufferLost).toBe(true);
  });

  it('handles cancellation, expiry and stale generation notices', () => {
    let state = clientReducer(initialClientState, {type: 'run_created', run: baseRun()});
    state = clientReducer(state, {
      type: 'event',
      id: 1,
      event: {type: 'run_completed', runId: 'r1', status: 'cancelled', processed: 0, total: 2, at: ''},
    });
    expect(state.run!.status).toBe('cancelled');
    expect(state.connection).toBe('closed');

    state = clientReducer(state, {
      type: 'event',
      event: {type: 'run_expired', runId: 'r1', at: ''},
    });
    expect(state.connection).toBe('expired');

    state = clientReducer(state, {type: 'stale_generation', actual: 2});
    expect(state.staleGeneration).toBe(true);
  });
});

describe('path summary', () => {
  it('rolls diffs, failures and diagnostics up to every container path', () => {
    const results = {s1: sampleResult('s1'), s2: failedResult('s2')};
    const buckets = buildBuckets(results);

    const root = buckets.get('$')!;
    expect(root.added).toBe(1);
    expect(root.typeChanged).toBe(1);
    expect(root.conversionFailed).toBe(1);
    expect(root.sampleCount).toBe(2);

    const orders = buckets.get('$.orders[key="A"]')!;
    expect(orders.added).toBe(1);
    expect(orders.sampleIds.has('s1')).toBe(true);

    const age = buckets.get('$.age')!;
    expect(age.conversionFailed).toBe(1);

    const totals = summarize(results, 2);
    expect(totals.processedSamples).toBe(2);
    expect(totals.diffedSamples).toBe(1);
    expect(totals.failedSamples).toBe(1);
    expect(totals.categories).toEqual({
      added: 1,
      removed: 0,
      type_changed: 1,
      conversion_failed: 1,
    });
  });

  it('filters sample details for a selected path including parents', () => {
    const results = {s1: sampleResult('s1'), s2: failedResult('s2')};
    expect(resultsForPath(results, '$.tags').map(r => r.sampleId)).toEqual(['s1']);
    expect(resultsForPath(results, '$.age').map(r => r.sampleId)).toEqual(['s2']);
    expect(resultsForPath(results, '$').map(r => r.sampleId).sort()).toEqual(['s1', 's2']);
    expect(resultsForPath(results, '$.unrelated')).toEqual([]);
  });
});
