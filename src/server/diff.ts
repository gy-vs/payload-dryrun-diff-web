import type {DiffEntry, DiffKind} from '../shared/types';

export interface DiffOptions {
  /** Map of exact array path (e.g. "$.lines") to the stable key field used to align elements. */
  arrayKeys?: Record<string, string>;
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** Collapse array selectors ([3], [sku=A-1]) to [] so concrete paths aggregate into schema paths. */
export function normalizePath(path: string): string {
  return path.replace(/\[[^\]]*\]/g, '[]');
}

function entry(path: string, kind: DiffKind, extra: Partial<DiffEntry> = {}): DiffEntry {
  return {path, group: normalizePath(path), kind, ...extra};
}

function keyOf(element: unknown, keyField: string): string | undefined {
  return stableKeyOf(element, keyField);
}

/** Stable key of an array element, if it carries a scalar value for the configured key field. */
export function stableKeyOf(element: unknown, keyField: string): string | undefined {
  if (element !== null && typeof element === 'object' && !Array.isArray(element)) {
    const raw = (element as Record<string, unknown>)[keyField];
    if (raw !== undefined && raw !== null && typeof raw !== 'object') return String(raw);
  }
  return undefined;
}

function formatSelector(keyField: string, key: string): string {
  return `[${keyField}=${key}]`;
}

/**
 * Align two arrays by a configured stable key. Elements sharing a key are matched in order of
 * occurrence, so duplicate keys degrade gracefully (first-with-first, extras become added/removed).
 * Elements lacking the key are matched positionally among themselves.
 */
function diffArraysKeyed(
  before: unknown[],
  after: unknown[],
  keyField: string,
  path: string,
  opts: DiffOptions,
  out: DiffEntry[],
): void {
  const groupOf = (list: unknown[]): Map<string | undefined, number[]> => {
    const groups = new Map<string | undefined, number[]>();
    list.forEach((element, index) => {
      const key = keyOf(element, keyField);
      const bucket = groups.get(key) ?? [];
      bucket.push(index);
      groups.set(key, bucket);
    });
    return groups;
  };
  const beforeGroups = groupOf(before);
  const afterGroups = groupOf(after);
  const keys = new Set<string | undefined>([...beforeGroups.keys(), ...afterGroups.keys()]);
  for (const key of keys) {
    const left = beforeGroups.get(key) ?? [];
    const right = afterGroups.get(key) ?? [];
    const paired = Math.min(left.length, right.length);
    for (let i = 0; i < paired; i++) {
      const selector = key === undefined ? `[${left[i]}]` : formatSelector(keyField, key);
      walk(before[left[i]], after[right[i]], path + selector, opts, out);
    }
    for (let i = paired; i < left.length; i++) {
      const selector = key === undefined ? `[${left[i]}]` : formatSelector(keyField, key);
      out.push(entry(path + selector, 'removed', {before: before[left[i]]}));
    }
    for (let i = paired; i < right.length; i++) {
      const selector = key === undefined ? `[${right[i]}]` : formatSelector(keyField, key);
      out.push(entry(path + selector, 'added', {after: after[right[i]]}));
    }
  }
}

function diffArrays(before: unknown[], after: unknown[], path: string, opts: DiffOptions, out: DiffEntry[]): void {
  const keyField = opts.arrayKeys?.[path];
  if (keyField) {
    diffArraysKeyed(before, after, keyField, path, opts, out);
    return;
  }
  const paired = Math.min(before.length, after.length);
  for (let i = 0; i < paired; i++) walk(before[i], after[i], `${path}[${i}]`, opts, out);
  for (let i = paired; i < before.length; i++) out.push(entry(`${path}[${i}]`, 'removed', {before: before[i]}));
  for (let i = paired; i < after.length; i++) out.push(entry(`${path}[${i}]`, 'added', {after: after[i]}));
}

function walk(before: unknown, after: unknown, path: string, opts: DiffOptions, out: DiffEntry[]): void {
  const beforeType = typeOf(before);
  const afterType = typeOf(after);
  if (beforeType !== afterType) {
    out.push(entry(path, 'type_changed', {before, after, message: `${beforeType} -> ${afterType}`}));
    return;
  }
  if (beforeType === 'array') {
    diffArrays(before as unknown[], after as unknown[], path, opts, out);
    return;
  }
  if (beforeType === 'object') {
    const left = before as Record<string, unknown>;
    const right = after as Record<string, unknown>;
    for (const key of Object.keys(left)) {
      if (!(key in right)) out.push(entry(`${path}.${key}`, 'removed', {before: left[key]}));
    }
    for (const key of Object.keys(right)) {
      if (!(key in left)) out.push(entry(`${path}.${key}`, 'added', {after: right[key]}));
      else walk(left[key], right[key], `${path}.${key}`, opts, out);
    }
    return;
  }
  if (!Object.is(before, after)) out.push(entry(path, 'value_changed', {before, after}));
}

export function diffValues(before: unknown, after: unknown, opts: DiffOptions = {}): DiffEntry[] {
  const out: DiffEntry[] = [];
  walk(before, after, '$', opts, out);
  return out;
}
