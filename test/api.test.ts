import {afterEach, describe, expect, it} from 'vitest';
import http from 'node:http';
import request from 'supertest';
import {createApp} from '../src/server/index';
import {createCatalogService} from '../src/server/catalog';
import {RunManager} from '../src/server/runManager';

type App = ReturnType<typeof createApp>;

interface ParsedSse {
  events: {id?: string; event: string; data: unknown}[];
  raw: string;
}

async function sseOnce(
  app: App,
  path: string,
  opts: {waitFor?: string; timeoutMs?: number} = {},
): Promise<ParsedSse> {
  const targetEvent = opts.waitFor ?? 'run_completed';
  const timeoutMs = opts.timeoutMs ?? 1500;
  const server = app.listen(0);
  await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const port = (server.address() as {port: number}).port;
  const body = await new Promise<string>((resolve, reject) => {
    let buffer = '';
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      req.destroy();
      resolve(buffer);
    };
    const req = http.get(
      {port, host: '127.0.0.1', path, headers: {Accept: 'text/event-stream'}},
      res => {
        res.on('data', chunk => {
          buffer += chunk;
          if (buffer.includes(`event: ${targetEvent}`)) finish();
        });
        res.on('close', finish);
        res.on('error', finish);
      },
    );
    req.on('error', err => {
      if (!settled) reject(err);
    });
    setTimeout(finish, timeoutMs).unref();
  });
  server.close();

  const frames = body.split('\n\n').filter(f => f.trim());
  const events = frames.map(frame => {
    const lines = frame.split('\n');
    const idLine = lines.find(l => l.startsWith('id: '));
    const eventLine = lines.find(l => l.startsWith('event: '));
    const dataLine = lines.find(l => l.startsWith('data: '));
    return {
      id: idLine?.slice(4),
      event: eventLine?.slice(7) ?? 'message',
      data: dataLine ? JSON.parse(dataLine.slice(6)) : undefined,
    };
  });
  return {events, raw: body};
}

describe('dry-run HTTP API', () => {
  afterEach(() => {});

  it('serves the fixed catalog with generation header', async () => {
    const app = createApp();
    const res = await request(app).get('/api/catalog').expect(200);
    expect(res.headers['x-sample-generation']).toBe('1');
    expect(res.body.revisions.map((r: {id: string}) => r.id)).toEqual([
      'rev-legacy',
      'rev-current',
      'rev-canary',
    ]);
    expect(res.body.samples.length).toBeGreaterThanOrEqual(7);
    expect(res.body.stableKeys['$.orders']).toEqual(['orderId', 'id']);
  });

  it('creates a run, streams snapshot+results, and completes', async () => {
    const catalog = createCatalogService();
    const manager = new RunManager({catalog, concurrency: 2, delayMs: 1});
    const app = createApp({catalog, runManager: manager});

    const created = await request(app)
      .post('/api/runs')
      .send({leftRevisionId: 'rev-legacy', rightRevisionId: 'rev-current', expectedGeneration: 1})
      .expect(201);
    const runId = created.body.runId;

    const stream = await sseOnce(app, `/api/runs/${runId}/events`);
    expect(stream.events[0].event).toBe('snapshot');
    const eventNames = stream.events.map(e => e.event);
    expect(eventNames).toContain('sample_result');
    expect(eventNames).toContain('run_completed');
    // Durable frames carry numeric ids; snapshot does not.
    const resultFrame = stream.events.find(e => e.event === 'sample_result');
    expect(Number.isInteger(Number(resultFrame!.id))).toBe(true);

    const finalState = await request(app).get(`/api/runs/${runId}`).expect(200);
    expect(finalState.body.status).toBe('completed');
  });

  it('404s unknown/expired runs on state, cancel and stream endpoints', async () => {
    const app = createApp();
    await request(app).get('/api/runs/nope').expect(404);
    await request(app).post('/api/runs/nope/cancel').expect(404);
    await request(app).get('/api/runs/nope/events').expect(404);
  });

  it('rejects a run when the client is pinned to a stale generation', async () => {
    const catalog = createCatalogService();
    const app = createApp({catalog});
    await request(app)
      .post('/api/testing/sample-set')
      .send({generation: 2})
      .expect(200);
    const res = await request(app)
      .post('/api/runs')
      .send({
        leftRevisionId: 'rev-legacy',
        rightRevisionId: 'rev-current',
        expectedGeneration: 1,
      })
      .expect(409);
    expect(res.body.error).toBe('sample_set_updated');
    expect(res.body.actual).toBe(2);
    expect(res.body.catalog.samples.map((s: {id: string}) => s.id)).toContain(
      's-canary-failure',
    );
  });

  it('cancels a run and finishes it as cancelled', async () => {
    const catalog = createCatalogService();
    const manager = new RunManager({catalog, concurrency: 1, delayMs: 25});
    const app = createApp({catalog, runManager: manager});

    const created = await request(app)
      .post('/api/runs')
      .send({leftRevisionId: 'rev-legacy', rightRevisionId: 'rev-current'})
      .expect(201);
    const runId = created.body.runId;
    await new Promise(r => setTimeout(r, 5));
    await request(app).post(`/api/runs/${runId}/cancel`).expect(200);

    // Wait for the cancelled completion.
    const state = await waitFor(() => manager.get(runId)?.status, 'cancelled');
    expect(state).toBe('cancelled');
    expect(manager.get(runId)!.sampleIds.length).toBeGreaterThan(
      Object.keys(manager.get(runId)!.results).length,
    );
  });

  it('supports Last-Event-ID replay without resending a snapshot', async () => {
    const catalog = createCatalogService();
    const manager = new RunManager({catalog, concurrency: 2, delayMs: 1});
    const app = createApp({catalog, runManager: manager});
    const created = await request(app)
      .post('/api/runs')
      .send({leftRevisionId: 'rev-legacy', rightRevisionId: 'rev-current'})
      .expect(201);
    const runId = created.body.runId;
    // Let the run finish.
    await waitFor(() => manager.get(runId)?.status, 'completed');

    const stream = await sseOnce(app, `/api/runs/${runId}/events?lastEventId=1`, {
      waitFor: 'snapshot',
    });
    // lastEventId=1 is inside the buffer but run is finished: frames after 1
    // include run_completed but never a new snapshot.
    expect(stream.events.map(e => e.event)).not.toContain('snapshot');
    expect(stream.events[0].id).not.toBe('1');
  });
});

async function waitFor<T>(read: () => T | undefined, expected: T, timeoutMs = 2000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = read();
    if (value === expected) return value as T;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${expected}`);
    await new Promise(r => setTimeout(r, 10));
  }
}
