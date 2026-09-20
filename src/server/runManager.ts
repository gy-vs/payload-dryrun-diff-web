import {randomUUID} from 'node:crypto';
import type {CatalogService} from './catalog';
import {applyRevision} from './catalog';
import {diagnosticsForValue, diffPayloads} from './diff';
import {ROOT_PATH} from '../shared/paths';
import type {
  RunEvent,
  RunSnapshot,
  RunStatus,
  SampleDef,
  SampleResult,
  StreamEvent,
  TransformFailure,
} from '../shared/types';

export interface RunManagerOptions {
  catalog: CatalogService;
  /** Default concurrency ceiling per run. */
  concurrency?: number;
  /** Per-sample transform delay (ms), simulates real work. */
  delayMs?: number;
  /** Bounded per-run event buffer size. */
  bufferSize?: number;
  /** Runs are removed this long after they reach a terminal state; <=0 keeps them forever. */
  ttlMs?: number;
  /** Inject a scheduler, defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

export interface CreateRunInput {
  leftRevisionId: string;
  rightRevisionId: string;
  expectedGeneration?: number;
  concurrency?: number;
  sampleIds?: string[];
}

export interface EventSink {
  /** Live/replayed event with its durable id; snapshot has no id (use its lastEventId). */
  onEvent(event: RunEvent, id: number | undefined): void;
}

interface StoredEvent {
  id: number;
  event: RunEvent;
}

interface RunRecord {
  snapshot: RunSnapshot;
  /** Bounded ring of durable events. */
  events: StoredEvent[];
  firstEventId: number;
  nextEventId: number;
  queue: string[];
  inFlight: Set<string>;
  active: number;
  cancelled: boolean;
  workers: number;
  finishing: boolean;
  sinks: Set<EventSink>;
  samples: Map<string, SampleDef>;
  ttlTimer?: NodeJS.Timeout;
}

const PATH_IN_MESSAGE = /at\s+(\$[A-Za-z0-9_.[\]"]*)/;

function failureFromError(side: 'left' | 'right', revisionId: string, err: unknown): TransformFailure {
  const message = err instanceof Error ? err.message : String(err);
  const match = PATH_IN_MESSAGE.exec(message);
  return {
    side,
    stage: 'transform',
    path: match?.[1] ?? ROOT_PATH,
    message: `${revisionId}: ${message}`,
  };
}

export class GenerationStaleError extends Error {
  constructor(
    public expected: number,
    public actual: number,
  ) {
    super(`sample set generation is ${actual}, client expected ${expected}`);
    this.name = 'GenerationStaleError';
  }
}

export class RunManager {
  private readonly runs = new Map<string, RunRecord>();
  private readonly defaultConcurrency: number;
  private readonly delayMs: number;
  private readonly bufferSize: number;
  private readonly ttlMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => Date;

  constructor(private readonly options: RunManagerOptions) {
    this.defaultConcurrency = options.concurrency ?? 3;
    this.delayMs = options.delayMs ?? 60;
    this.bufferSize = options.bufferSize ?? 128;
    this.ttlMs = options.ttlMs ?? 10 * 60_000;
    this.sleep =
      options.sleep ?? ((ms: number) => new Promise(resolve => setTimeout(resolve, ms)));
    this.now = options.now ?? (() => new Date());
  }

  get(runId: string): RunSnapshot | undefined {
    const record = this.runs.get(runId);
    return record ? cloneSnapshot(record.snapshot) : undefined;
  }

  createRun(input: CreateRunInput): RunSnapshot {
    const catalog = this.options.catalog.get();
    if (
      input.expectedGeneration !== undefined &&
      input.expectedGeneration !== catalog.sampleGeneration
    ) {
      throw new GenerationStaleError(input.expectedGeneration, catalog.sampleGeneration);
    }
    if (!catalog.revisions.some(rev => rev.id === input.leftRevisionId)) {
      throw new Error(`unknown left revision: ${input.leftRevisionId}`);
    }
    if (!catalog.revisions.some(rev => rev.id === input.rightRevisionId)) {
      throw new Error(`unknown right revision: ${input.rightRevisionId}`);
    }
    const concurrency = Math.min(Math.max(input.concurrency ?? this.defaultConcurrency, 1), 8);

    const requested = new Set(input.sampleIds ?? catalog.samples.map(sample => sample.id));
    const samples = catalog.samples.filter(sample => requested.has(sample.id));

    const runId = randomUUID();
    const record: RunRecord = {
      snapshot: {
        runId,
        status: 'running',
        leftRevisionId: input.leftRevisionId,
        rightRevisionId: input.rightRevisionId,
        sampleGeneration: catalog.sampleGeneration,
        sampleIds: samples.map(sample => sample.id),
        inFlight: [],
        stableKeys: catalog.stableKeys,
        concurrency,
        results: {},
        createdAt: this.now().toISOString(),
      },
      events: [],
      firstEventId: 1,
      nextEventId: 1,
      queue: samples.map(sample => sample.id),
      inFlight: new Set<string>(),
      active: 0,
      cancelled: false,
      workers: concurrency,
      finishing: false,
      sinks: new Set(),
      samples: new Map(samples.map(sample => [sample.id, sample])),
    };
    this.runs.set(runId, record);

    // Kick workers off on later microtasks so callers can subscribe before
    // the first sample_started is published.
    for (let i = 0; i < concurrency; i += 1) {
      void Promise.resolve().then(() => void this.worker(record));
    }
    return cloneSnapshot(record.snapshot);
  }

  cancel(runId: string): RunSnapshot | undefined {
    const record = this.runs.get(runId);
    if (!record) return undefined;
    if (record.snapshot.status === 'running') {
      record.cancelled = true;
      record.queue.length = 0;
    }
    return cloneSnapshot(record.snapshot);
  }

  private async worker(record: RunRecord): Promise<void> {
    for (;;) {
      if (record.cancelled) {
        this.retireWorker(record);
        return;
      }
      const sampleId = record.queue.shift();
      if (sampleId === undefined) {
        this.retireWorker(record);
        return;
      }
      record.active += 1;
      record.inFlight.add(sampleId);
      record.snapshot.inFlight = [...record.inFlight];
      this.publish(record, {
        type: 'sample_started',
        runId: record.snapshot.runId,
        sampleId,
        at: this.now().toISOString(),
      });

      const result = await this.processSample(record, sampleId);
      record.inFlight.delete(sampleId);
      record.active -= 1;

      // Cancellation wins: a result finishing after cancel is dropped.
      if (record.cancelled) {
        this.retireWorker(record);
        return;
      }
      record.snapshot.results[sampleId] = result;
      record.snapshot.inFlight = [...record.inFlight];
      const processed = Object.keys(record.snapshot.results).length;
      this.publish(record, {
        type: 'sample_result',
        runId: record.snapshot.runId,
        sample: result,
        processed,
        total: record.snapshot.sampleIds.length,
        at: this.now().toISOString(),
      });
    }
  }

  private retireWorker(record: RunRecord): void {
    record.workers -= 1;
    if (record.workers === 0 && !record.finishing) {
      record.finishing = true;
      this.finish(record);
    }
  }

  private async processSample(record: RunRecord, sampleId: string): Promise<SampleResult> {
    const started = Date.now();
    const sample = record.samples.get(sampleId)!;
    const {leftRevisionId, rightRevisionId, stableKeys} = record.snapshot;
    const failures: TransformFailure[] = [];
    let diagnostics: SampleResult['diagnostics'] = [];

    let transformedLeft;
    let transformedRight;
    try {
      transformedLeft = applyRevision(leftRevisionId, sample);
    } catch (err) {
      failures.push(failureFromError('left', leftRevisionId, err));
    }
    try {
      transformedRight = applyRevision(rightRevisionId, sample);
    } catch (err) {
      failures.push(failureFromError('right', rightRevisionId, err));
    }

    if (this.delayMs > 0) await this.sleep(this.delayMs);

    let diffs: SampleResult['diffs'] = [];
    if (failures.length === 0 && transformedLeft !== undefined && transformedRight !== undefined) {
      try {
        const outcome = diffPayloads(transformedLeft, transformedRight, stableKeys);
        diffs = outcome.diffs;
        diagnostics = outcome.diagnostics;
      } catch (err) {
        failures.push({
          side: 'right',
          stage: 'diff',
          path: ROOT_PATH,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    } else {
      // Surface stable-key diagnostics from whichever side still transformed.
      if (transformedLeft !== undefined) {
        diagnostics = diagnosticsForValue(transformedLeft, 'left', stableKeys);
      } else if (transformedRight !== undefined) {
        diagnostics = diagnosticsForValue(transformedRight, 'right', stableKeys);
      }
    }

    return {
      sampleId,
      status: failures.length > 0 ? 'failed' : 'diffed',
      diffs,
      diagnostics,
      failures,
      transformedLeft: failures.length === 0 ? transformedLeft : undefined,
      transformedRight: failures.length === 0 ? transformedRight : undefined,
      durationMs: Date.now() - started,
    };
  }

  private finish(record: RunRecord): void {
    if (record.snapshot.status !== 'running') return;
    const status: RunStatus = record.cancelled ? 'cancelled' : 'completed';
    record.snapshot.status = status;
    record.snapshot.inFlight = [];
    record.snapshot.finishedAt = this.now().toISOString();
    this.publish(record, {
      type: 'run_completed',
      runId: record.snapshot.runId,
      status,
      processed: Object.keys(record.snapshot.results).length,
      total: record.snapshot.sampleIds.length,
      at: this.now().toISOString(),
    });
    this.armTtl(record);
  }

  private armTtl(record: RunRecord): void {
    if (this.ttlMs <= 0) return;
    record.ttlTimer = setTimeout(() => {
      const runId = record.snapshot.runId;
      record.snapshot.status = 'expired';
      // Expiry is ephemeral: the run is about to vanish, so it is not buffered.
      this.fanoutEphemeral(record, {type: 'run_expired', runId, at: this.now().toISOString()});
      this.runs.delete(runId);
    }, this.ttlMs);
    // Don't keep the process alive solely for TTL cleanup.
    record.ttlTimer.unref?.();
  }

  private publish(record: RunRecord, event: RunEvent): void {
    const id = record.nextEventId;
    record.nextEventId += 1;
    record.events.push({id, event});
    if (record.events.length > this.bufferSize) {
      const dropped = record.events.shift()!;
      record.firstEventId = dropped.id + 1;
    }
    for (const sink of record.sinks) sink.onEvent(event, id);
  }

  private fanout(record: RunRecord, event: RunEvent, id: number): void {
    for (const sink of record.sinks) sink.onEvent(event, id);
  }

  private fanoutEphemeral(record: RunRecord, event: RunEvent): void {
    for (const sink of record.sinks) sink.onEvent(event, undefined);
  }

  /**
   * Subscribe to a run.
   *
   * - `lastEventId` inside the bounded buffer: replay newer durable events.
   * - otherwise (first connect / evicted IDs / 0): send a full `snapshot`
   *   event tagged with the current high-water mark, then replay everything
   *   after that mark.
   *
   * Returns an unsubscribe function, or undefined when the run is unknown
   * (e.g. session expired).
   */
  subscribe(runId: string, sink: EventSink, lastEventId = 0): (() => void) | undefined {
    const record = this.runs.get(runId);
    if (!record) return undefined;

    let replayFromId = lastEventId;
    if (replayFromId < record.firstEventId) {
      const highWater = record.nextEventId - 1;
      const snapshotEvent: StreamEvent = {
        type: 'snapshot',
        lastEventId: highWater,
        run: cloneSnapshot(record.snapshot),
      };
      sink.onEvent(snapshotEvent as unknown as RunEvent, undefined);
      replayFromId = highWater;
    }
    for (const stored of record.events) {
      if (stored.id > replayFromId) sink.onEvent(stored.event, stored.id);
    }

    record.sinks.add(sink);
    return () => {
      record.sinks.delete(sink);
    };
  }
}

function cloneSnapshot(snapshot: RunSnapshot): RunSnapshot {
  return globalThis.structuredClone(snapshot);
}
