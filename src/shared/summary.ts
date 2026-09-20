import type {
  Diagnostic,
  DiffOp,
  SampleResult,
  TransformFailure,
} from './types';
import {bucketPaths} from './paths';

export type DiffCategory = 'added' | 'removed' | 'type_changed' | 'conversion_failed';

export interface PathBucket {
  path: string;
  added: number;
  removed: number;
  typeChanged: number;
  conversionFailed: number;
  valueChanged: number;
  /** number of distinct samples contributing to this path */
  sampleCount: number;
  /** duplicate keys / missing keys / alignment diagnostics */
  diagnosticCount: number;
  sampleIds: Set<string>;
}

export interface SampleSummary {
  totalSamples: number;
  processedSamples: number;
  failedSamples: number;
  diffedSamples: number;
  categories: Record<DiffCategory, number>;
  valueChanged: number;
  diagnosticCount: number;
}

/**
 * Which summary buckets does one op/failure/diagnostic contribute to?
 * Every item counts at its own path and at each container path up to '$',
 * so clicking a parent path shows everything beneath it.
 */
function pathsFor(op: {path: string}): string[] {
  return bucketPaths(op.path);
}

function bump(
  buckets: Map<string, PathBucket>,
  path: string,
  sampleId: string,
  apply: (bucket: PathBucket) => void,
): void {
  let bucket = buckets.get(path);
  if (!bucket) {
    bucket = {
      path,
      added: 0,
      removed: 0,
      typeChanged: 0,
      conversionFailed: 0,
      valueChanged: 0,
      sampleCount: 0,
      diagnosticCount: 0,
      sampleIds: new Set<string>(),
    };
    buckets.set(path, bucket);
  }
  const wasNewSample = !bucket.sampleIds.has(sampleId);
  bucket.sampleIds.add(sampleId);
  if (wasNewSample) bucket.sampleCount += 1;
  apply(bucket);
}

function addDiff(buckets: Map<string, PathBucket>, sampleId: string, op: DiffOp): void {
  for (const path of pathsFor(op)) {
    bump(buckets, path, sampleId, bucket => {
      if (op.type === 'added') bucket.added += 1;
      else if (op.type === 'removed') bucket.removed += 1;
      else if (op.type === 'type_changed') bucket.typeChanged += 1;
      else if (op.type === 'value_changed') bucket.valueChanged += 1;
    });
  }
}

function addFailure(buckets: Map<string, PathBucket>, sampleId: string, failure: TransformFailure): void {
  for (const path of pathsFor(failure)) {
    bump(buckets, path, sampleId, bucket => {
      bucket.conversionFailed += 1;
    });
  }
}

function addDiagnostic(buckets: Map<string, PathBucket>, sampleId: string, diagnostic: Diagnostic): void {
  for (const path of pathsFor(diagnostic)) {
    bump(buckets, path, sampleId, bucket => {
      bucket.diagnosticCount += 1;
    });
  }
}

export function buildBuckets(results: Record<string, SampleResult>): Map<string, PathBucket> {
  const buckets = new Map<string, PathBucket>();
  for (const result of Object.values(results)) {
    for (const op of result.diffs) addDiff(buckets, result.sampleId, op);
    for (const failure of result.failures) addFailure(buckets, result.sampleId, failure);
    for (const diagnostic of result.diagnostics) addDiagnostic(buckets, result.sampleId, diagnostic);
  }
  return buckets;
}

export function summarize(results: Record<string, SampleResult>, totalSamples: number): SampleSummary {
  const summary: SampleSummary = {
    totalSamples,
    processedSamples: Object.keys(results).length,
    failedSamples: 0,
    diffedSamples: 0,
    categories: {added: 0, removed: 0, type_changed: 0, conversion_failed: 0},
    valueChanged: 0,
    diagnosticCount: 0,
  };
  for (const result of Object.values(results)) {
    if (result.status === 'failed') summary.failedSamples += 1;
    else summary.diffedSamples += 1;
    for (const op of result.diffs) {
      if (op.type === 'added') summary.categories.added += 1;
      else if (op.type === 'removed') summary.categories.removed += 1;
      else if (op.type === 'type_changed') summary.categories.type_changed += 1;
      else if (op.type === 'value_changed') summary.valueChanged += 1;
    }
    summary.categories.conversion_failed += result.failures.length;
    summary.diagnosticCount += result.diagnostics.length;
  }
  return summary;
}

/** Sample results touching a given bucket path (used when drilling into detail). */
export function resultsForPath(
  results: Record<string, SampleResult>,
  path: string,
): SampleResult[] {
  return Object.values(results)
    .filter(result => {
      return (
        result.diffs.some(op => pathsFor(op).includes(path)) ||
        result.failures.some(failure => pathsFor(failure).includes(path)) ||
        result.diagnostics.some(diagnostic => pathsFor(diagnostic).includes(path))
      );
    })
    .sort((a, b) => a.sampleId.localeCompare(b.sampleId));
}
