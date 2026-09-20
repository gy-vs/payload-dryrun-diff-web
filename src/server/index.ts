import express from 'express';
import type {Response} from 'express';
import {fileURLToPath} from 'node:url';
import {createCatalogService} from './catalog';
import {GenerationStaleError, RunManager} from './runManager';
import type {RunEvent, StreamEvent} from '../shared/types';

export interface AppOptions {
  runManager?: RunManager;
  catalog?: ReturnType<typeof createCatalogService>;
}

export function createApp(options: AppOptions = {}) {
  const app = express();
  const catalog = options.catalog ?? createCatalogService();
  const manager =
    options.runManager ?? new RunManager({catalog, concurrency: 3, delayMs: 80, bufferSize: 128});

  app.use(express.json({limit: '1mb'}));

  // ---- Read-only review surface ---------------------------------------------

  app.get('/api/catalog', (_req, res) => {
    res.set('X-Sample-Generation', String(catalog.get().sampleGeneration));
    res.json(catalog.get());
  });

  app.post('/api/runs', (req, res) => {
    const {leftRevisionId, rightRevisionId, expectedGeneration, concurrency, sampleIds} =
      req.body ?? {};
    if (typeof leftRevisionId !== 'string' || typeof rightRevisionId !== 'string') {
      return res.status(400).json({error: 'invalid_request', message: 'revision ids required'});
    }
    try {
      const run = manager.createRun({
        leftRevisionId,
        rightRevisionId,
        expectedGeneration,
        concurrency,
        sampleIds,
      });
      return res.status(201).json(run);
    } catch (err) {
      if (err instanceof GenerationStaleError) {
        return res.status(409).json({
          error: 'sample_set_updated',
          expected: err.expected,
          actual: err.actual,
          catalog: catalog.get(),
        });
      }
      return res.status(400).json({error: 'invalid_request', message: (err as Error).message});
    }
  });

  app.get('/api/runs/:id', (req, res) => {
    const run = manager.get(req.params.id);
    if (!run) return res.status(404).json({error: 'run_not_found', message: 'session expired'});
    res.json(run);
  });

  app.post('/api/runs/:id/cancel', (req, res) => {
    const run = manager.cancel(req.params.id);
    if (!run) return res.status(404).json({error: 'run_not_found', message: 'session expired'});
    res.json(run);
  });

  // ---- Server-sent events with bounded replay buffer ------------------------

  app.get('/api/runs/:id/events', (req, res) => {
    const runId = req.params.id;
    if (!manager.get(runId)) {
      return res.status(404).json({error: 'run_not_found', message: 'session expired'});
    }

    res.status(200);
    res.set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    const lastEventId = parseLastEventId(req.header('last-event-id')) ?? parseLastEventId(req.query.lastEventId);
    const sink = {
      onEvent(event: RunEvent | StreamEvent, id: number | undefined) {
        writeEvent(res, event, id);
      },
    };
    const unsubscribe = manager.subscribe(runId, sink, lastEventId ?? 0);
    if (!unsubscribe) {
      return res.status(404).json({error: 'run_not_found', message: 'session expired'});
    }

    const heartbeat = setInterval(() => {
      res.write(': ping\n\n');
    }, 15_000);
    heartbeat.unref?.();

    const close = () => {
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    };
    req.on('aborted', close);
    req.on('close', close);
    res.on('error', close);
  });

  // ---- Test/admin: rotate the FIXED sample set ------------------------------

  app.post('/api/testing/sample-set', (req, res) => {
    const generation = Number(req.body?.generation);
    if (!Number.isInteger(generation) || generation < 1) {
      return res.status(400).json({error: 'invalid_request', message: 'generation required'});
    }
    const next = catalog.rotateTo(generation);
    res.set('X-Sample-Generation', String(next.sampleGeneration));
    res.json({sampleGeneration: next.sampleGeneration, sampleIds: next.samples.map(s => s.id)});
  });

  return app;
}

function parseLastEventId(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function writeEvent(res: Response, event: RunEvent | StreamEvent, id: number | undefined): void {
  if (event.type === 'snapshot') {
    // Synthetic event: carries the durable high-water mark instead of an id.
    res.write(`event: snapshot\ndata: ${JSON.stringify(event)}\n\n`);
    return;
  }
  // Durable id: the browser sends it back as Last-Event-ID on reconnect.
  res.write(`id: ${id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 4174);
  createApp().listen(port, '127.0.0.1', () => {
    console.log(`dry-run review server http://127.0.0.1:${port}`);
  });
}
