import type {RevisionInfo, SampleSetInfo} from '../shared/types';
import {stableKeyOf} from './diff';

export interface FieldRule {
  /** Source path on the input payload; [] expands array elements. Omitted when `const` is set. */
  from?: string;
  /** Target path on the output payload. */
  to: string;
  convert?: 'string' | 'number' | 'boolean' | 'iso-date';
  const?: unknown;
}

export interface PipelineRevision extends RevisionInfo {
  rules: FieldRule[];
  /** Arrays to sort by a stable key after mapping (demonstrates reorder-tolerant diffing). */
  sort?: { path: string; key: string }[];
}

export interface ConversionFailure {
  path: string;
  message: string;
}

export interface TransformOutcome {
  output: unknown;
  failures: ConversionFailure[];
}

class ConversionError extends Error {}

function convert(value: unknown, kind: NonNullable<FieldRule['convert']>): unknown {
  switch (kind) {
    case 'string':
      if (typeof value === 'object' && value !== null) throw new ConversionError('cannot stringify object');
      return String(value);
    case 'number': {
      if (typeof value === 'string' && value.trim() === '') throw new ConversionError('empty string is not a number');
      const num = Number(value);
      if (Number.isNaN(num)) throw new ConversionError(`not a number: ${JSON.stringify(value)}`);
      return num;
    }
    case 'boolean':
      if (value === true || value === 'true' || value === 1) return true;
      if (value === false || value === 'false' || value === 0) return false;
      throw new ConversionError(`not a boolean: ${JSON.stringify(value)}`);
    case 'iso-date': {
      const date = typeof value === 'number' ? new Date(value) : new Date(String(value));
      if (Number.isNaN(date.getTime())) throw new ConversionError(`not a date: ${JSON.stringify(value)}`);
      return date.toISOString();
    }
  }
}

type Seg = string | number;

/** Resolve a rule path like `lines[].qty` or `lines[2].qty` into concrete segments, expanding [] over array indices. */
function expand(input: unknown, pattern: string): { segs: Seg[]; value: unknown }[] {
  const parts = pattern.split('.');
  const results: { segs: Seg[]; value: unknown }[] = [];
  const walk = (node: unknown, rest: string[], segs: Seg[]): void => {
    if (rest.length === 0) {
      results.push({segs, value: node});
      return;
    }
    const [head, ...tail] = rest;
    const indexed = /^([^\[\]]+)\[(\d*)\]$/.exec(head);
    if (indexed) {
      const [, field, indexText] = indexed;
      const arr = field ? (node as Record<string, unknown>)?.[field] : node;
      if (!Array.isArray(arr)) return;
      if (indexText === '') {
        arr.forEach((item, index) => walk(item, tail, [...segs, `${field}[${index}]`]));
      } else {
        walk(arr[Number(indexText)], tail, [...segs, `${field}[${indexText}]`]);
      }
      return;
    }
    if (node === null || typeof node !== 'object') return;
    if (!(head in node)) return; // absent source key: rule does not apply to this element
    walk((node as Record<string, unknown>)[head], tail, [...segs, head]);
  };
  walk(input, parts, []);
  return results;
}

function setPath(target: Record<string, unknown>, segs: Seg[], value: unknown): void {
  let node: Record<string, unknown> = target;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i];
    const arrayMatch = /^(.+)\[(\d+)\]$/.exec(String(seg));
    if (arrayMatch) {
      const [, field, indexText] = arrayMatch;
      const index = Number(indexText);
      const arr = (node[field] ??= []) as unknown[];
      while (arr.length <= index) arr.push({});
      node = arr[index] as Record<string, unknown>;
    } else {
      node = (node[seg] ??= {}) as Record<string, unknown>;
    }
  }
  const last = String(segs[segs.length - 1]);
  const arrayMatch = /^(.+)\[(\d+)\]$/.exec(last);
  if (arrayMatch) {
    const [, field, indexText] = arrayMatch;
    const arr = (node[field] ??= []) as unknown[];
    arr[Number(indexText)] = value;
  } else {
    node[last] = value;
  }
}

function getAt(output: unknown, path: string): unknown {
  return expand(output, path)[0]?.value;
}

/**
 * Apply a revision's field rules to a sample payload. Conversion failures are reported with
 * key-selector paths (e.g. $.lines[sku=C-9].qty) so they line up with diff entries.
 */
export function applyTransform(input: unknown, revision: PipelineRevision, arrayKeys: Record<string, string> = {}): TransformOutcome {
  const output: Record<string, unknown> = {};
  const failures: ConversionFailure[] = [];
  for (const rule of revision.rules) {
    if (rule.const !== undefined) {
      setPath(output, rule.to.split('.'), rule.const);
      continue;
    }
    if (!rule.from) continue;
    for (const {segs, value} of expand(input, rule.from)) {
      // Mirror source indices into the target path so array elements stay aligned.
      const toSegs: Seg[] = [];
      const arraySources = new Map<number, Seg[]>();
      let sourceSegIndex = 0;
      for (const part of rule.to.split('.')) {
        if (part.endsWith('[]')) {
          const field = part.slice(0, -2);
          const sourceSeg = String(segs[sourceSegIndex] ?? '');
          const index = /\[(\d+)\]$/.exec(sourceSeg)?.[1] ?? '0';
          arraySources.set(toSegs.length, segs.slice(0, sourceSegIndex + 1));
          toSegs.push(`${field}[${index}]`);
          sourceSegIndex++;
        } else {
          toSegs.push(part);
        }
      }
      let mapped = value;
      if (rule.convert) {
        try {
          mapped = convert(value, rule.convert);
        } catch (error) {
          failures.push({path: displayPath(toSegs, arraySources, input, arrayKeys), message: (error as Error).message});
          continue;
        }
      }
      setPath(output, toSegs, mapped);
    }
  }
  for (const sort of revision.sort ?? []) {
    const arr = getAt(output, sort.path);
    if (Array.isArray(arr)) {
      arr.sort((a, b) => String((a as Record<string, unknown>)?.[sort.key]).localeCompare(String((b as Record<string, unknown>)?.[sort.key])));
    }
  }
  return {output, failures};
}

/** Build a $-path for a target location, using stable-key selectors where the array is keyed. */
function displayPath(toSegs: Seg[], arraySources: Map<number, Seg[]>, input: unknown, arrayKeys: Record<string, string>): string {
  let path = '$';
  for (let i = 0; i < toSegs.length; i++) {
    const text = String(toSegs[i]);
    const indexed = /^(.+)\[(\d+)\]$/.exec(text);
    if (!indexed) {
      path += `.${text}`;
      continue;
    }
    const [, field, index] = indexed;
    const keyField = arrayKeys[`${path}.${field}`];
    let selector = `[${index}]`;
    const sourcePath = arraySources.get(i);
    if (keyField && sourcePath) {
      const element = getAt(input, sourcePath.join('.'));
      const key = stableKeyOf(element, keyField);
      if (key !== undefined) selector = `[${keyField}=${key}]`;
    }
    path += `.${field}${selector}`;
  }
  return path;
}

export const revisions: PipelineRevision[] = [
  {
    id: 'rev-1',
    label: 'rev-1 · legacy order shape',
    rules: [
      {from: 'orderId', to: 'order.id', convert: 'string'},
      {from: 'customer.name', to: 'customer_name'},
      {from: 'lines[].sku', to: 'lines[].sku'},
      {from: 'lines[].qty', to: 'lines[].qty'},
      {from: 'lines[].note', to: 'lines[].note'},
      {from: 'coupon', to: 'coupon'},
      {from: 'placedAt', to: 'placed_at'},
    ],
  },
  {
    id: 'rev-2',
    label: 'rev-2 · nested customer, typed quantities',
    rules: [
      {from: 'orderId', to: 'order.id', convert: 'string'},
      {from: 'customer.name', to: 'customer.name'},
      {from: 'customer.tier', to: 'customer.tier'},
      {from: 'lines[].sku', to: 'lines[].sku'},
      {from: 'lines[].qty', to: 'lines[].qty', convert: 'number'},
      {from: 'lines[].discount', to: 'lines[].discount', convert: 'number'},
      {from: 'placedAt', to: 'placed_at', convert: 'iso-date'},
      {to: 'schema', const: 2},
    ],
    sort: [{path: 'lines', key: 'sku'}],
  },
];

export interface Sample {
  id: string;
  payload: unknown;
}

export interface SampleSet extends SampleSetInfo {
  samples: Sample[];
}

const ordersV1: Sample[] = [
  {
    id: 'ord-001',
    payload: {
      orderId: 'A-1001',
      customer: {name: 'Ada Lovelace', tier: 'gold'},
      lines: [
        {sku: 'B-2', qty: '1', note: 'gift wrap'},
        {sku: 'A-1', qty: '2', note: 'fragile'},
      ],
      coupon: 'WELCOME',
      placedAt: '2026-09-01T10:00:00Z',
    },
  },
  {
    id: 'ord-002',
    payload: {
      orderId: 'A-1002',
      customer: {name: 'Grace Hopper'},
      lines: [
        {sku: 'C-9', qty: 'N/A', note: 'backorder'},
        {sku: 'A-1', qty: '3'},
      ],
      placedAt: '2026-09-02T11:30:00Z',
    },
  },
  {
    id: 'ord-003',
    payload: {
      orderId: 'A-1003',
      customer: {name: 'Alan Turing', tier: 'silver'},
      lines: [
        {sku: 'D-4', qty: '1'},
        {sku: 'D-4', qty: '5', note: 'duplicate sku line'},
        {sku: 'E-7', qty: '2'},
      ],
      placedAt: 1725000000000,
    },
  },
  {
    id: 'ord-004',
    payload: {
      orderId: 'A-1004',
      customer: {name: 'Edsger Dijkstra'},
      lines: [{sku: 'F-3', qty: '4', discount: '0.15'}],
      placedAt: '2026-09-03T08:15:00Z',
    },
  },
  {
    id: 'ord-005',
    payload: {
      orderId: 'A-1005',
      customer: {name: 'Barbara Liskov', tier: 'gold'},
      lines: [{sku: 'G-8', qty: '7'}],
      coupon: 'FALL',
      placedAt: 'not-a-date',
    },
  },
  {
    id: 'ord-006',
    payload: {orderId: 'A-1006', customer: {name: 'Katherine Johnson'}, lines: [], placedAt: '2026-09-04T09:00:00Z'},
  },
  {
    id: 'ord-007',
    payload: {
      orderId: 'A-1007',
      customer: {name: 'Margaret Hamilton'},
      lines: [{sku: 'H-5', qty: '9', internalNote: 'dropped by both revisions'}],
      legacyFlag: true,
      placedAt: '2026-09-05T14:45:00Z',
    },
  },
  {
    id: 'ord-008',
    payload: {orderId: 'A-1008', customer: {name: 'Radia Perlman'}, lines: null, placedAt: '2026-09-06T16:20:00Z'},
  },
];

export const sampleSets: SampleSet[] = [
  {id: 'orders', version: 1, count: ordersV1.length, samples: ordersV1},
];

export function findRevision(id: string): PipelineRevision | undefined {
  return revisions.find((revision) => revision.id === id);
}

export function findSampleSet(id: string): SampleSet | undefined {
  return sampleSets.find((set) => set.id === id);
}

export function replaceSampleSet(id: string, samples: Sample[]): SampleSet | undefined {
  const set = findSampleSet(id);
  if (!set) return undefined;
  set.samples = samples;
  set.version += 1;
  set.count = samples.length;
  return set;
}
