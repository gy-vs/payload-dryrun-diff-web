import {randomUUID} from 'node:crypto';
import type {DryrunEvent, SampleResult, SessionStatus, SessionView, SummaryRow} from '../shared/types';
import {diffValues, normalizePath} from './diff';
import {applyTransform, findRevision, findSampleSet, type PipelineRevision, type Sample} from './transforms';

export interface SessionOptions {
  /** Max samples processed concurrently. */
  concurrency: number;
  /** Bounded per-session event buffer; older events are evicted and reconnecting clients get a snapshot. */
  eventBufferSize: number;
  /** Session lifetime; afterwards the session is gone and clients see 410. */
  ttlMs: number;
  /** Simulated per-sample transform latency. */
  sampleDelayMs: number;
}

export const defaultSessionOptions: SessionOptions = {
  concurrency: 3,
  eventBufferSize: 200,
  ttlMs: 15 * 60 * 1000,
  sampleDelayMs: 80,
};

/** Stable-key alignment config, keyed by normalized array path. */
const ARRAY_KEYS: Record<string, string> = {'$.lines': 'sku'};

interface SummaryAcc {
  row: SummaryRow;
  sampleIds: Set<string>;
}

export interface Session {
  id: string;
  status: SessionStatus;
  fromRevision: string;
  toRevision: string;
  sampleSetId: string;
  sampleSetVersion: number;
  createdAt: number;
  expiresAt: number;
  total: number;
  completed: number;
  samples: Map<string, SampleResult>;
  summaryAcc: Map<string, SummaryAcc>;
  events: DryrunEvent[];
  seq: number;
  stats: { maxConcurrency: number };
  cancelRequested: boolean;
  pinnedSamples: Sample[];
  subscribers: Set<(event: DryrunEvent) => void>;
}

export type Lookup = {kind: 'ok'; session: Session} | {kind: 'expired'} | {kind: 'missing'};

export class SessionStore {
  private sessions = new Map<string, Session>();
  /** Recently expired session ids, kept so late polls/reconnects get a consistent 410. */
  private tombstones = new Map<string, number>();

  constructor(private options: SessionOptions = defaultSessionOptions) {}

  create(input: {fromRevision: string; toRevision: string; sampleSetId: string}): Session | {error: string} {
    const from = findRevision(input.fromRevision);
    const to = findRevision(input.toRevision);
    const set = findSampleSet(input.sampleSetId);
    if (!from || !to) return {error: 'unknown_revision'};
    if (!set) return {error: 'unknown_sample_set'};
    const now = Date.now();
    const session: Session = {
      id: randomUUID(),
      status: 'running',
      fromRevision: from.id,
      toRevision: to.id,
      sampleSetId: set.id,
      sampleSetVersion: set.version,
      createdAt: now,
      expiresAt: now + this.options.ttlMs,
      total: set.samples.length,
      completed: 0,
      samples: new Map(),
      summaryAcc: new Map(),
      events: [],
      seq: 0,
      stats: {maxConcurrency: 0},
      cancelRequested: false,
      // Pin the sample set snapshot: later updates to the set must not leak into this run.
      pinnedSamples: set.samples.map((sample) => ({id: sample.id, payload: sample.payload})),
      subscribers: new Set(),
    };
    this.sessions.set(session.id, session);
    this.push(session, {
      seq: 0,
      type: 'started',
      total: session.total,
      fromRevision: from.id,
      toRevision: to.id,
      sampleSetVersion: set.version,
    });
    void this.run(session, from, to);
    return session;
  }

  get(id: string): Lookup {
    const session = this.sessions.get(id);
    const now = Date.now();
    if (session) {
      if (now <= session.expiresAt) return {kind: 'ok', session};
      this.sessions.delete(id);
      this.tombstones.set(id, now);
      this.purgeTombstones(now);
      return {kind: 'expired'};
    }
    if (this.tombstones.has(id)) return {kind: 'expired'};
    return {kind: 'missing'};
  }

  private purgeTombstones(now: number): void {
    for (const [id, expiredAt] of this.tombstones) {
      if (now - expiredAt > this.options.ttlMs) this.tombstones.delete(id);
    }
  }

  cancel(id: string): Lookup {
    const lookup = this.get(id);
    if (lookup.kind !== 'ok') return lookup;
    if (lookup.session.status === 'running') lookup.session.cancelRequested = true;
    return lookup;
  }

  view(session: Session): SessionView {
    return {
      id: session.id,
      status: session.status,
      fromRevision: session.fromRevision,
      toRevision: session.toRevision,
      sampleSetId: session.sampleSetId,
      sampleSetVersion: session.sampleSetVersion,
      total: session.total,
      completed: session.completed,
      summary: summaryRows(session),
      createdAt: new Date(session.createdAt).toISOString(),
      expiresAt: new Date(session.expiresAt).toISOString(),
      stats: session.stats,
    };
  }

  /** Events a (re)connecting client needs after `since`; a snapshot is prepended if the buffer evicted them. */
  replay(session: Session, since: number): DryrunEvent[] {
    const buffered = session.events.filter((event) => event.seq > since);
    const evicted = session.events.length > 0 && session.events[0].seq > since + 1;
    if (!evicted) return buffered;
    const snapshot: DryrunEvent = {
      seq: session.seq,
      type: 'snapshot',
      session: this.view(session),
      samples: [...session.samples.values()],
    };
    return [snapshot, ...buffered];
  }

  subscribe(session: Session, listener: (event: DryrunEvent) => void): () => void {
    session.subscribers.add(listener);
    return () => session.subscribers.delete(listener);
  }

  private push(session: Session, event: DryrunEvent): void {
    session.seq += 1;
    const stamped = {...event, seq: session.seq} as DryrunEvent;
    session.events.push(stamped);
    if (session.events.length > this.options.eventBufferSize) session.events.shift();
    for (const subscriber of session.subscribers) subscriber(stamped);
  }

  private async run(session: Session, from: PipelineRevision, to: PipelineRevision): Promise<void> {
    const queue = [...session.pinnedSamples];
    let active = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        if (session.cancelRequested) return;
        const sample = queue.shift();
        if (!sample) return;
        active += 1;
        session.stats.maxConcurrency = Math.max(session.stats.maxConcurrency, active);
        const result = await this.processSample(sample, from, to);
        active -= 1;
        // Cancelled while this sample was in flight: discard the late result.
        if (session.cancelRequested) return;
        this.record(session, result);
      }
    };
    const workerCount = Math.max(1, Math.min(this.options.concurrency, queue.length));
    await Promise.all(Array.from({length: workerCount}, () => worker()));
    if (session.cancelRequested) {
      session.status = 'cancelled';
      this.push(session, {seq: 0, type: 'cancelled', completed: session.completed, total: session.total});
    } else {
      session.status = 'done';
      this.push(session, {seq: 0, type: 'done', completed: session.completed, total: session.total, stats: session.stats});
    }
  }

  private async processSample(sample: Sample, from: PipelineRevision, to: PipelineRevision): Promise<SampleResult> {
    const startedAt = Date.now();
    if (this.options.sampleDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.options.sampleDelayMs));
    }
    const fromOutcome = applyTransform(sample.payload, from, ARRAY_KEYS);
    const toOutcome = applyTransform(sample.payload, to, ARRAY_KEYS);
    const structural = diffValues(fromOutcome.output, toOutcome.output, {arrayKeys: ARRAY_KEYS});
    const failedPaths = [...fromOutcome.failures, ...toOutcome.failures].map((failure) => failure.path);
    const covered = (path: string): boolean =>
      failedPaths.some((failed) => path === failed || path.startsWith(failed + '.') || path.startsWith(failed + '['));
    const entries = structural.filter((entry) => !covered(entry.path));
    for (const failure of fromOutcome.failures) {
      entries.push({path: failure.path, group: normalizePath(failure.path), kind: 'conversion_failed', side: 'from', message: failure.message});
    }
    for (const failure of toOutcome.failures) {
      entries.push({path: failure.path, group: normalizePath(failure.path), kind: 'conversion_failed', side: 'to', message: failure.message});
    }
    entries.sort((a, b) => a.path.localeCompare(b.path));
    return {
      sampleId: sample.id,
      status: entries.some((entry) => entry.kind === 'conversion_failed') ? 'failed' : 'ok',
      entries,
      durationMs: Date.now() - startedAt,
    };
  }

  private record(session: Session, result: SampleResult): void {
    session.samples.set(result.sampleId, result);
    session.completed = session.samples.size;
    for (const entry of result.entries) {
      let acc = session.summaryAcc.get(entry.group);
      if (!acc) {
        acc = {row: {path: entry.group, added: 0, removed: 0, typeChanged: 0, valueChanged: 0, conversionFailed: 0, samples: 0}, sampleIds: new Set()};
        session.summaryAcc.set(entry.group, acc);
      }
      if (entry.kind === 'added') acc.row.added += 1;
      else if (entry.kind === 'removed') acc.row.removed += 1;
      else if (entry.kind === 'type_changed') acc.row.typeChanged += 1;
      else if (entry.kind === 'value_changed') acc.row.valueChanged += 1;
      else if (entry.kind === 'conversion_failed') acc.row.conversionFailed += 1;
      acc.sampleIds.add(result.sampleId);
      acc.row.samples = acc.sampleIds.size;
    }
    this.push(session, {seq: 0, type: 'sample', completed: session.completed, total: session.total, sample: result});
    this.push(session, {seq: 0, type: 'summary', completed: session.completed, total: session.total, summary: summaryRows(session)});
  }
}

function summaryRows(session: Session): SummaryRow[] {
  return [...session.summaryAcc.values()].map((acc) => ({...acc.row})).sort((a, b) => a.path.localeCompare(b.path));
}
