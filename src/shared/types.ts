// Shared protocol types for the payload migration dry-run workbench.
// Read-only review surface: nothing here is ever written back to an external system.

export type JsonValue =
  | null
  | string
  | number
  | boolean
  | JsonValue[]
  | {[key: string]: JsonValue};

export type Side = 'left' | 'right';

export type ValueType = 'null' | 'string' | 'number' | 'boolean' | 'array' | 'object';

export interface PipelineRevision {
  id: string;
  label: string;
  description: string;
}

export interface SampleDef {
  id: string;
  label: string;
  payload: JsonValue;
}

export interface Catalog {
  revisions: PipelineRevision[];
  samples: SampleDef[];
  sampleGeneration: number;
  /** Map of array container path ($.orders) to stable-key candidates, first present wins. */
  stableKeys: Record<string, string[]>;
}

export type DiffOpType = 'added' | 'removed' | 'type_changed' | 'value_changed';

export interface DiffOp {
  /** Canonical path, '$' is the document root. */
  path: string;
  type: DiffOpType;
  left?: JsonValue;
  right?: JsonValue;
  leftType?: ValueType;
  rightType?: ValueType;
  /** Present on ops that describe a whole aligned array element. */
  align?: 'key' | 'positional';
  stableKey?: string;
}

export type DiagnosticCode =
  | 'duplicate_stable_key'
  | 'missing_stable_key'
  | 'uncomparable_element';

export interface Diagnostic {
  path: string;
  code: DiagnosticCode;
  message: string;
  side?: Side;
  stableKey?: string;
}

export interface TransformFailure {
  side: Side;
  stage: 'transform' | 'diff';
  path: string;
  message: string;
}

export interface SampleResult {
  sampleId: string;
  status: 'diffed' | 'failed';
  diffs: DiffOp[];
  diagnostics: Diagnostic[];
  failures: TransformFailure[];
  transformedLeft?: JsonValue;
  transformedRight?: JsonValue;
  durationMs: number;
}

export type RunStatus = 'running' | 'completed' | 'cancelled' | 'expired';

export interface RunSnapshot {
  runId: string;
  status: RunStatus;
  leftRevisionId: string;
  rightRevisionId: string;
  sampleGeneration: number;
  sampleIds: string[];
  inFlight: string[];
  stableKeys: Record<string, string[]>;
  concurrency: number;
  results: Record<string, SampleResult>;
  createdAt: string;
  finishedAt?: string;
}

export interface SnapshotEvent {
  type: 'snapshot';
  lastEventId: number;
  run: RunSnapshot;
}

export interface SampleStartedEvent {
  type: 'sample_started';
  runId: string;
  sampleId: string;
  at: string;
}

export interface SampleResultEvent {
  type: 'sample_result';
  runId: string;
  sample: SampleResult;
  processed: number;
  total: number;
  at: string;
}

export interface RunCompletedEvent {
  type: 'run_completed';
  runId: string;
  status: 'completed' | 'cancelled';
  processed: number;
  total: number;
  at: string;
}

export interface RunExpiredEvent {
  type: 'run_expired';
  runId: string;
  at: string;
}

export type RunEvent =
  | SampleStartedEvent
  | SampleResultEvent
  | RunCompletedEvent
  | RunExpiredEvent;

export type StreamEvent = SnapshotEvent | RunEvent;
