import express, {type Request, type Response} from 'express';
import {fileURLToPath} from 'node:url';
import {SessionStore, defaultSessionOptions, type Session, type SessionOptions} from './sessions';
import {revisions, replaceSampleSet, sampleSets, type Sample} from './transforms';

type RecordRow = {id: string; name: string; revision: number; content: string; updatedAt: string};
const rows: RecordRow[] = [
  {id: 'alpha', name: 'Primary transform runs', revision: 3, content: 'transform runs: alpha\nstate: active', updatedAt: new Date(0).toISOString()},
  {id: 'beta', name: 'Secondary transform runs', revision: 5, content: 'transform runs: beta\nstate: review', updatedAt: new Date(1000).toISOString()},
];

export function createApp(sessionOptions: Partial<SessionOptions> = {}) {
  const store = new SessionStore({...defaultSessionOptions, ...sessionOptions});
  const app = express();
  app.use(express.json({limit: '1mb'}));

  const lookupSession = (req: Request, res: Response): Session | undefined => {
    const lookup = store.get(String(req.params.id));
    if (lookup.kind === 'missing') {
      res.status(404).json({error: 'not_found'});
      return undefined;
    }
    if (lookup.kind === 'expired') {
      res.status(410).json({error: 'session_expired'});
      return undefined;
    }
    return lookup.session;
  };

  app.get('/api/bootstrap', (_req, res) =>
    res.json({
      family: 'migration-mapping',
      count: rows.length,
      revisions: revisions.map(({id, label}) => ({id, label})),
      sampleSets: sampleSets.map(({id, version, count: total}) => ({id, version, count: total})),
    }),
  );

  app.get('/api/mappings', (_req, res) => res.json(rows.map(({content, ...row}) => row)));
  app.get('/api/mappings/:id', (req, res) => {
    const row = rows.find((value) => value.id === req.params.id);
    if (!row) return res.status(404).json({error: 'not_found'});
    res.set('ETag', String(row.revision)).json(row);
  });
  app.put('/api/mappings/:id', (req, res) => {
    const row = rows.find((value) => value.id === req.params.id);
    if (!row) return res.status(404).json({error: 'not_found'});
    if (req.body.revision !== row.revision) return res.status(409).json({error: 'revision_conflict', current: row});
    row.content = String(req.body.content ?? '');
    row.revision += 1;
    row.updatedAt = new Date().toISOString();
    res.json(row);
  });
  app.post('/api/mappings/:id/analyze', async (req, res) => {
    const row = rows.find((value) => value.id === req.params.id);
    if (!row) return res.status(404).json({error: 'not_found'});
    await new Promise((resolve) => setTimeout(resolve, req.params.id === 'alpha' ? 100 : 20));
    res.json({id: row.id, revision: row.revision, lines: String(req.body.content ?? row.content).split(/\r?\n/).length, diagnostics: []});
  });

  app.get('/api/revisions', (_req, res) => res.json(revisions.map(({id, label}) => ({id, label}))));
  app.get('/api/sample-sets', (_req, res) => res.json(sampleSets.map(({id, version, count}) => ({id, version, count}))));
  app.put('/api/sample-sets/:id', (req, res) => {
    const samples = req.body?.samples;
    if (!Array.isArray(samples) || samples.some((sample) => typeof sample?.id !== 'string')) {
      return res.status(400).json({error: 'invalid_samples'});
    }
    const set = replaceSampleSet(req.params.id, samples as Sample[]);
    if (!set) return res.status(404).json({error: 'not_found'});
    res.json({id: set.id, version: set.version, count: set.count});
  });

  app.post('/api/dryrun/sessions', (req, res) => {
    const {fromRevision, toRevision, sampleSetId} = req.body ?? {};
    const session = store.create({fromRevision, toRevision, sampleSetId});
    if ('error' in session) return res.status(400).json({error: session.error});
    res.status(201).json(store.view(session));
  });

  app.get('/api/dryrun/sessions/:id', (req, res) => {
    const session = lookupSession(req, res);
    if (session) res.json(store.view(session));
  });

  app.post('/api/dryrun/sessions/:id/cancel', (req, res) => {
    const lookup = store.cancel(String(req.params.id));
    if (lookup.kind === 'missing') return res.status(404).json({error: 'not_found'});
    if (lookup.kind === 'expired') return res.status(410).json({error: 'session_expired'});
    res.json(store.view(lookup.session));
  });

  app.get('/api/dryrun/sessions/:id/events', (req, res) => {
    const session = lookupSession(req, res);
    if (!session) return;
    const lastEventId = req.header('last-event-id');
    const since = Number(req.query.since ?? lastEventId ?? 0);
    const events = store.replay(session, Number.isFinite(since) ? since : 0);
    if (req.accepts(['text/event-stream', 'application/json']) === 'text/event-stream') {
      res.writeHead(200, {'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive'});
      res.write('retry: 1000\n\n');
      for (const event of events) res.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      const unsubscribe = store.subscribe(session, (event) => {
        res.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      });
      req.on('close', unsubscribe);
      return;
    }
    res.json({events, session: store.view(session)});
  });

  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createApp().listen(4174, '127.0.0.1', () => console.log('server http://127.0.0.1:4174'));
}
