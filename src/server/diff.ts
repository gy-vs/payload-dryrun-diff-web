import type {
  Diagnostic,
  DiffOp,
  JsonValue,
  Side,
  TransformFailure,
  ValueType,
} from '../shared/types';
import {joinPath, ROOT_PATH} from '../shared/paths';

export type {TransformFailure} from '../shared/types';

/**
 * Structural JSON diff.
 *
 * Arrays are aligned by a configured stable key (first present candidate wins).
 * When the same key repeats on one side the occurrences pair FIFO and a
 * `duplicate_stable_key` diagnostic is emitted; unmatched occurrences are
 * treated as added/removed. Without a configured key arrays compare by
 * position.
 */

const ROOT = ROOT_PATH;

export function typeOf(value: JsonValue): ValueType {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value as ValueType;
}

interface Pair {
  l?: JsonValue;
  r?: JsonValue;
  /** element path suffix, e.g. [2] or [key="ORD-2"] */
  suffix: string;
  align: 'key' | 'positional';
  key?: string;
}

function pickKey(value: JsonValue | undefined, candidates: string[]): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, JsonValue>;
  for (const candidate of candidates) {
    const raw = record[candidate];
    if (typeof raw === 'string' && raw.length > 0) return raw;
    if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  }
  return undefined;
}

/** Group one side of an array into FIFO queues keyed by stable key. */
function groupByKey(
  values: JsonValue[],
  candidates: string[],
  side: Side,
  path: string,
  diagnostics: Diagnostic[],
): Map<string, JsonValue[]> {
  const queues = new Map<string, JsonValue[]>();
  for (const value of values) {
    const key = pickKey(value, candidates);
    if (key === undefined) {
      diagnostics.push({
        path,
        side,
        code: 'missing_stable_key',
        message: `Array element has no stable key (tried ${candidates.join(', ')})`,
      });
      continue;
    }
    const queue = queues.get(key);
    if (queue) {
      // Duplicate stable key on this side.
      diagnostics.push({
        path,
        side,
        stableKey: key,
        code: 'duplicate_stable_key',
        message: `Duplicate stable key ${JSON.stringify(key)} on ${side} side`,
      });
      queue.push(value);
    } else {
      queues.set(key, [value]);
    }
  }
  return queues;
}

/**
 * Align two arrays.
 *
 * - keyed mode: elements sharing a stable key pair FIFO; key collisions are
 *   reported; elements lacking the key are flagged and fall back to positional
 *   pairing of the "keyless" leftovers; surplus elements become whole adds/removes.
 * - positional mode: zip by index; surplus elements become whole adds/removes.
 */
export function alignArrays(
  left: JsonValue[],
  right: JsonValue[],
  path: string,
  keyCandidates: string[] | undefined,
  diagnostics: Diagnostic[],
): Pair[] {
  const pairs: Pair[] = [];

  if (!keyCandidates || keyCandidates.length === 0) {
    const max = Math.max(left.length, right.length);
    for (let i = 0; i < max; i += 1) {
      pairs.push({
        l: left[i],
        r: right[i],
        suffix: `[${i}]`,
        align: 'positional',
      });
    }
    return pairs;
  }

  const leftQueues = groupByKey(left, keyCandidates, 'left', path, diagnostics);
  const rightQueues = groupByKey(right, keyCandidates, 'right', path, diagnostics);

  for (const key of new Set<string>([...leftQueues.keys(), ...rightQueues.keys()])) {
    const lQueue = leftQueues.get(key) ?? [];
    const rQueue = rightQueues.get(key) ?? [];
    const max = Math.max(lQueue.length, rQueue.length);
    for (let i = 0; i < max; i += 1) {
      // Disambiguate repeated keys so surplus occurrences get unique paths.
      const suffix =
        max > 1 && i > 0 ? `[key=${JSON.stringify(key)}][occurrence=${i}]` : `[key=${JSON.stringify(key)}]`;
      pairs.push({l: lQueue[i], r: rQueue[i], suffix, align: 'key', key});
    }
  }

  // Keyless leftovers on each side pair positionally against each other.
  const keylessLeft = left.filter(value => pickKey(value, keyCandidates) === undefined);
  const keylessRight = right.filter(value => pickKey(value, keyCandidates) === undefined);
  const maxKeyless = Math.max(keylessLeft.length, keylessRight.length);
  for (let i = 0; i < maxKeyless; i += 1) {
    pairs.push({
      l: keylessLeft[i],
      r: keylessRight[i],
      suffix: `[keyless][${i}]`,
      align: 'positional',
    });
  }
  return pairs;
}

function wholeElement(opType: DiffOp['type'], pair: Pair, path: string): DiffOp {
  const op: DiffOp = {
    path: `${path}${pair.suffix}`,
    type: opType,
    align: pair.align,
  };
  if (pair.key !== undefined) op.stableKey = pair.key;
  if (pair.l !== undefined) op.left = pair.l;
  if (pair.r !== undefined) op.right = pair.r;
  return op;
}

function compareValues(
  left: JsonValue | undefined,
  right: JsonValue | undefined,
  path: string,
  stableKeys: Record<string, string[]>,
  diffs: DiffOp[],
  diagnostics: Diagnostic[],
): void {
  // Whole-side presence.
  if (left === undefined) {
    diffs.push({path, type: 'added', right});
    return;
  }
  if (right === undefined) {
    diffs.push({path, type: 'removed', left});
    return;
  }

  const leftType = typeOf(left);
  const rightType = typeOf(right);
  if (leftType !== rightType) {
    diffs.push({path, type: 'type_changed', left, right, leftType, rightType});
    return;
  }

  if (leftType === 'array') {
    const pairs = alignArrays(
      left as JsonValue[],
      right as JsonValue[],
      path,
      stableKeys[path],
      diagnostics,
    );
    for (const pair of pairs) {
      const childPath = `${path}${pair.suffix}`;
      if (pair.l === undefined || pair.r === undefined) {
        diffs.push(wholeElement(pair.l === undefined ? 'added' : 'removed', pair, path));
        continue;
      }
      const before = diffs.length;
      compareValues(pair.l, pair.r, childPath, stableKeys, diffs, diagnostics);
      // Tag the first op of an aligned element with how it was matched,
      // so the UI can show key vs positional alignment.
      if (diffs.length > before && (pair.align === 'key' || pair.key !== undefined)) {
        diffs[before].align = pair.align;
        if (pair.key !== undefined) diffs[before].stableKey = pair.key;
      }
    }
    return;
  }

  if (leftType === 'object') {
    const leftRecord = left as Record<string, JsonValue>;
    const rightRecord = right as Record<string, JsonValue>;
    const keys = new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)]);
    for (const key of keys) {
      const hasLeft = Object.prototype.hasOwnProperty.call(leftRecord, key);
      const hasRight = Object.prototype.hasOwnProperty.call(rightRecord, key);
      compareValues(
        hasLeft ? leftRecord[key] : undefined,
        hasRight ? rightRecord[key] : undefined,
        joinPath(path, key),
        stableKeys,
        diffs,
        diagnostics,
      );
    }
    return;
  }

  // Scalar (null/string/number/boolean): same type, compare values.
  if (left !== right) {
    diffs.push({path, type: 'value_changed', left, right, leftType, rightType});
  }
}

export interface DiffOutcome {
  diffs: DiffOp[];
  diagnostics: Diagnostic[];
}

/** Diagnostics for one side of an array forest (used when the other side failed to transform). */
export function diagnosticsForValue(
  value: JsonValue,
  side: Side,
  stableKeys: Record<string, string[]>,
  path = ROOT,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const scan = (node: JsonValue | undefined, nodePath: string): void => {
    if (Array.isArray(node)) {
      const candidates = stableKeys[nodePath];
      if (candidates) {
        const seen = new Set<string>();
        for (const element of node) {
          const key = pickKey(element, candidates);
          if (key === undefined) {
            diagnostics.push({
              path: nodePath,
              side,
              code: 'missing_stable_key',
              message: `Array element has no stable key (tried ${candidates.join(', ')})`,
            });
          } else {
            if (seen.has(key)) {
              diagnostics.push({
                path: nodePath,
                side,
                stableKey: key,
                code: 'duplicate_stable_key',
                message: `Duplicate stable key ${JSON.stringify(key)} on ${side} side`,
              });
            }
            seen.add(key);
          }
          scan(element, `${nodePath}[]`);
        }
      } else {
        node.forEach((element, index) => scan(element, `${nodePath}[${index}]`));
      }
      return;
    }
    if (node && typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) {
        scan(child, joinPath(nodePath, key));
      }
    }
  };
  scan(value, path);
  return diagnostics;
}

export function diffPayloads(
  left: JsonValue,
  right: JsonValue,
  stableKeys: Record<string, string[]> = {},
): DiffOutcome {
  const diffs: DiffOp[] = [];
  const diagnostics: Diagnostic[] = [];
  compareValues(left, right, ROOT, stableKeys, diffs, diagnostics);
  return {diffs, diagnostics};
}
