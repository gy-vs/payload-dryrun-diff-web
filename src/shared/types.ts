// Shared types for the payload migration dry-run workbench.

export type DiffKind = 'added' | 'removed' | 'type_changed' | 'value_changed' | 'conversion_failed';

export type Side = 'from' | 'to';

export interface DiffEntry {
  /** Concrete path, e.g. $.lines[sku=A-1].qty — arrays aligned by stable key when configured. */
  path: string;
  /** Normalized path with array selectors collapsed to [], used for summary aggregation. */
  group: string;
  kind: DiffKind;
  /** Which side produced a conversion failure. */
  side?: Side;
  before?: unknown;
  after?: unknown;
  message?: string;
}

export interface SummaryRow {
  path: string;
  added: number;
  removed: number;
  typeChanged: number;
  valueChanged: number;
  conversionFailed: number;
  /** Distinct samples contributing to this path. */
  samples: number;
}

export type SampleStatus = 'ok' | 'failed';

export interface SampleResult {
  sampleId: string;
  status: SampleStatus;
  entries: DiffEntry[];
  durationMs: number;
}

export type SessionStatus = 'running' | 'done' | 'cancelled';

export interface SessionView {
  id: string;
  status: SessionStatus;
  fromRevision: string;
  toRevision: string;
  sampleSetId: string;
  sampleSetVersion: number;
  total: number;
  completed: number;
  summary: SummaryRow[];
  createdAt: string;
  expiresAt: string;
  stats: { maxConcurrency: number };
}

export type DryrunEvent =
  | { seq: number; type: 'started'; total: number; fromRevision: string; toRevision: string; sampleSetVersion: number }
  | { seq: number; type: 'sample'; completed: number; total: number; sample: SampleResult }
  | { seq: number; type: 'summary'; completed: number; total: number; summary: SummaryRow[] }
  | { seq: number; type: 'done'; completed: number; total: number; stats: { maxConcurrency: number } }
  | { seq: number; type: 'cancelled'; completed: number; total: number }
  | { seq: number; type: 'snapshot'; session: SessionView; samples: SampleResult[] };

export interface RevisionInfo {
  id: string;
  label: string;
}

export interface SampleSetInfo {
  id: string;
  version: number;
  count: number;
}
