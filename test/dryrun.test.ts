import {describe, expect, it} from 'vitest';
import request from 'supertest';
import type {AddressInfo} from 'node:net';
import {createApp} from '../src/server/index';
import type {SessionView} from '../src/shared/types';

const fast = {sampleDelayMs: 2, concurrency: 2, eventBufferSize: 200, ttlMs: 60_000};

async function createSession(app: ReturnType<typeof createApp>): Promise<SessionView> {
  const res = await request(app)
    .post('/api/dryrun/sessions')
    .send({fromRevision: 'rev-1', toRevision: 'rev-2', sampleSetId: 'orders'})
    .expect(201);
  return res.body as SessionView;
}

async function waitForStatus(app: ReturnType<typeof createApp>, id: string, status: string): Promise<SessionView> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const res = await request(app).get(`/api/dryrun/sessions/${id}`).expect(200);
    if (res.body.status === status) return res.body as SessionView;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${status}: ${JSON.stringify(res.body)}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

async function eventsJson(app: ReturnType<typeof createApp>, id: string, since: number) {
  const res = await request(app).get(`/api/dryrun/sessions/${id}/events`).query({since}).set('Accept', 'application/json').expect(200);
  return res.body.events as any[];
}

describe('dry-run sessions', () => {
  it('runs to completion and aggregates added/removed/type-changed/conversion-failed by path', async () => {
    const app = createApp(fast);
    const session = await createSession(app);
    expect(session.total).toBe(8);
    const done = await waitForStatus(app, session.id, 'done');
    expect(done.completed).toBe(8);
    const rows = new Map(done.summary.map((row) => [row.path, row]));
    expect(rows.get('$.schema')).toMatchObject({added: 8, samples: 8});
    // customer subtree only exists on the rev-2 side, so it aggregates at the parent path
    expect(rows.get('$.customer')).toMatchObject({added: 8, samples: 8});
    expect(rows.get('$.customer_name')).toMatchObject({removed: 8, samples: 8});
    expect(rows.get('$.coupon')).toMatchObject({removed: 2});
    // rev-2 normalizes dates to ISO (value change on 6), epoch number is a type change, garbage fails
    expect(rows.get('$.placed_at')).toMatchObject({typeChanged: 1, conversionFailed: 1, valueChanged: 6, samples: 8});
    expect(rows.get('$.lines[].qty')).toMatchObject({typeChanged: 9, conversionFailed: 1, samples: 6});
    expect(rows.get('$.lines[].note')).toMatchObject({removed: 4, samples: 3});
    expect(rows.get('$.lines[].discount')).toMatchObject({added: 1, samples: 1});
  });

  it('aligns reordered arrays by stable key without positional noise', async () => {
    const app = createApp(fast);
    const session = await createSession(app);
    await waitForStatus(app, session.id, 'done');
    const events = await eventsJson(app, session.id, 0);
    const sampleEvents = events.filter((event) => event.type === 'sample');
    const ord1 = sampleEvents.find((event) => event.sample.sampleId === 'ord-001').sample;
    const lineEntries = ord1.entries.filter((entry: any) => entry.path.startsWith('$.lines'));
    expect(lineEntries.length).toBeGreaterThan(0);
    expect(lineEntries.every((entry: any) => !/\[\d+\]/.test(entry.path))).toBe(true);
    expect(lineEntries.filter((entry: any) => entry.kind === 'added' || entry.kind === 'removed')).toEqual(
      // notes are dropped by rev-2 — keyed removals only, no element-level add/remove
      expect.not.arrayContaining([expect.objectContaining({path: expect.stringMatching(/^\$\.lines\[sku=[^\]]+\]$/)})]),
    );
  });

  it('handles duplicate stable keys deterministically', async () => {
    const app = createApp(fast);
    const session = await createSession(app);
    await waitForStatus(app, session.id, 'done');
    const events = await eventsJson(app, session.id, 0);
    const ord3 = events.find((event) => event.type === 'sample' && event.sample.sampleId === 'ord-003').sample;
    const qtyChanges = ord3.entries.filter((entry: any) => entry.path === '$.lines[sku=D-4].qty');
    expect(qtyChanges).toHaveLength(2);
    expect(qtyChanges.every((entry: any) => entry.kind === 'type_changed')).toBe(true);
  });

  it('records one-side conversion failure and suppresses the structural duplicate', async () => {
    const app = createApp(fast);
    const session = await createSession(app);
    await waitForStatus(app, session.id, 'done');
    const events = await eventsJson(app, session.id, 0);
    const ord2 = events.find((event) => event.type === 'sample' && event.sample.sampleId === 'ord-002').sample;
    expect(ord2.status).toBe('failed');
    const failure = ord2.entries.find((entry: any) => entry.kind === 'conversion_failed');
    expect(failure).toMatchObject({path: '$.lines[sku=C-9].qty', side: 'to', group: '$.lines[].qty'});
    // The failed field must not also show up as a structural removal.
    expect(ord2.entries.filter((entry: any) => entry.path === '$.lines[sku=C-9].qty')).toHaveLength(1);
  });

  it('limits concurrency and reports the observed peak', async () => {
    const app = createApp({...fast, sampleDelayMs: 30, concurrency: 2});
    const session = await createSession(app);
    const done = await waitForStatus(app, session.id, 'done');
    expect(done.stats.maxConcurrency).toBe(2);
  });

  it('cancels and never accepts late results', async () => {
    const app = createApp({...fast, sampleDelayMs: 60, concurrency: 1});
    const session = await createSession(app);
    // Wait for the first sample, then cancel while the second is in flight.
    const deadline = Date.now() + 5000;
    for (;;) {
      const view = await request(app).get(`/api/dryrun/sessions/${session.id}`);
      if (view.body.completed >= 1) break;
      if (Date.now() > deadline) throw new Error('no progress before cancel');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await request(app).post(`/api/dryrun/sessions/${session.id}/cancel`).expect(200);
    const cancelled = await waitForStatus(app, session.id, 'cancelled');
    expect(cancelled.completed).toBeLessThan(cancelled.total);
    const completedAtCancel = cancelled.completed;
    await new Promise((resolve) => setTimeout(resolve, 200));
    const after = await request(app).get(`/api/dryrun/sessions/${session.id}`).expect(200);
    expect(after.body.completed).toBe(completedAtCancel);
    const events = await eventsJson(app, session.id, 0);
    const cancelledIndex = events.findIndex((event) => event.type === 'cancelled');
    expect(cancelledIndex).toBeGreaterThan(-1);
    expect(events.slice(cancelledIndex + 1).filter((event) => event.type === 'sample' || event.type === 'done')).toEqual([]);
  });

  it('bounds the event buffer and replays a snapshot after eviction', async () => {
    const app = createApp({...fast, eventBufferSize: 6});
    const session = await createSession(app);
    await waitForStatus(app, session.id, 'done');
    const replayed = await eventsJson(app, session.id, 0);
    expect(replayed[0].type).toBe('snapshot');
    expect(replayed[0].session.completed).toBe(8);
    expect(replayed[0].samples).toHaveLength(8);
    expect(replayed.length).toBe(7); // snapshot + 6 buffered events
    const lastSeq = replayed[replayed.length - 1].seq;
    const tail = await eventsJson(app, session.id, lastSeq - 2);
    expect(tail[0].type).not.toBe('snapshot');
    expect(tail.every((event) => event.seq > lastSeq - 2)).toBe(true);
    expect(tail).toHaveLength(2);
  });

  it('expires sessions and answers 410', async () => {
    const app = createApp({...fast, ttlMs: 80});
    const session = await createSession(app);
    await new Promise((resolve) => setTimeout(resolve, 140));
    await request(app).get(`/api/dryrun/sessions/${session.id}`).expect(410, {error: 'session_expired'});
    await request(app).get(`/api/dryrun/sessions/${session.id}/events`).set('Accept', 'application/json').expect(410);
    await request(app).post(`/api/dryrun/sessions/${session.id}/cancel`).expect(410);
    await request(app).get('/api/dryrun/sessions/does-not-exist').expect(404);
  });

  it('streams events as SSE with ids for Last-Event-ID reconnect', async () => {
    const app = createApp({...fast, sampleDelayMs: 20});
    const session = await createSession(app);
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const res = await fetch(`http://127.0.0.1:${port}/api/dryrun/sessions/${session.id}/events`, {
        headers: {accept: 'text/event-stream'},
      });
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let text = '';
      const deadline = Date.now() + 5000;
      while (!text.includes('event: done') && Date.now() < deadline) {
        const {value, done: eof} = await reader.read();
        if (eof) break;
        text += decoder.decode(value, {stream: true});
      }
      await reader.cancel();
      expect(text).toMatch(/id: \d+\nevent: started\n/);
      expect(text).toMatch(/id: \d+\nevent: sample\ndata: /);
      expect(text).toContain('event: done');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  // NOTE: must stay last — it mutates the shared sample set fixture.
  it('pins the sample set version at session start even when the set is updated', async () => {
    const app = createApp(fast);
    const session = await createSession(app);
    await waitForStatus(app, session.id, 'done');
    await request(app)
      .put('/api/sample-sets/orders')
      .send({samples: [{id: 'new-1', payload: {orderId: 'N-1'}}]})
      .expect(200, {id: 'orders', version: 2, count: 1});
    const pinned = await request(app).get(`/api/dryrun/sessions/${session.id}`).expect(200);
    expect(pinned.body.total).toBe(8);
    expect(pinned.body.sampleSetVersion).toBe(1);
    const sets = await request(app).get('/api/sample-sets').expect(200);
    expect(sets.body).toEqual([{id: 'orders', version: 2, count: 1}]);
    const fresh = await createSession(app);
    expect(fresh.total).toBe(1);
    expect(fresh.sampleSetVersion).toBe(2);
    const done = await waitForStatus(app, fresh.id, 'done');
    // order.id is identical on both revisions; only the rev-2 constant differs
    expect(done.summary).toEqual([expect.objectContaining({path: '$.schema', added: 1})]);
  });
});
