import {describe, expect, it} from 'vitest';
import {applyTransform, findRevision, findSampleSet, revisions} from '../src/server/transforms';
import {diffValues} from '../src/server/diff';

const ARRAY_KEYS = {'$.lines': 'sku'};
const rev1 = revisions.find((revision) => revision.id === 'rev-1')!;
const rev2 = revisions.find((revision) => revision.id === 'rev-2')!;

describe('applyTransform', () => {
  it('maps, converts and adds constants', () => {
    const {output, failures} = applyTransform(
      {orderId: 'X-1', customer: {name: 'Ada', tier: 'gold'}, lines: [{sku: 'B', qty: '3'}], placedAt: 0},
      rev2,
      ARRAY_KEYS,
    );
    expect(failures).toEqual([]);
    expect(output).toEqual({
      order: {id: 'X-1'},
      customer: {name: 'Ada', tier: 'gold'},
      lines: [{sku: 'B', qty: 3}],
      placed_at: '1970-01-01T00:00:00.000Z',
      schema: 2,
    });
  });

  it('reports conversion failures with key-selector paths and omits the field', () => {
    const {output, failures} = applyTransform({lines: [{sku: 'C-9', qty: 'N/A'}]}, rev2, ARRAY_KEYS);
    expect(failures).toEqual([{path: '$.lines[sku=C-9].qty', message: 'not a number: "N/A"'}]);
    expect((output as {lines: unknown[]}).lines).toEqual([{sku: 'C-9'}]);
  });

  it('sorts configured arrays by their stable key', () => {
    const {output} = applyTransform({lines: [{sku: 'B', qty: 1}, {sku: 'A', qty: 1}]}, rev2, ARRAY_KEYS);
    expect((output as {lines: {sku: string}[]}).lines.map((line) => line.sku)).toEqual(['A', 'B']);
  });

  it('rejects invalid boolean and date conversions', () => {
    const custom = {
      id: 'x',
      label: 'x',
      rules: [
        {from: 'a', to: 'a', convert: 'boolean' as const},
        {from: 'b', to: 'b', convert: 'iso-date' as const},
      ],
    };
    const {failures} = applyTransform({a: 'maybe', b: 'not-a-date'}, custom);
    expect(failures.map((failure) => failure.path)).toEqual(['$.a', '$.b']);
  });
});

describe('revision fixtures', () => {
  it('exposes revisions and the pinned sample set', () => {
    expect(findRevision('rev-1')).toBeDefined();
    expect(findSampleSet('orders')?.samples.length).toBeGreaterThan(0);
  });

  it('rev-2 reordering lines produces no positional diff noise under key alignment', () => {
    const payload = {orderId: 'A-1', lines: [{sku: 'B-2', qty: '1'}, {sku: 'A-1', qty: '2'}], placedAt: '2026-09-01T10:00:00Z'};
    const from = applyTransform(payload, rev1, ARRAY_KEYS).output;
    const to = applyTransform(payload, rev2, ARRAY_KEYS).output;
    const entries = diffValues(from, to, {arrayKeys: ARRAY_KEYS});
    const lineEntries = entries.filter((entry) => entry.path.startsWith('$.lines'));
    // Every lines entry must use key selectors — reordering must not surface as [0]/[1] changes.
    expect(lineEntries.length).toBeGreaterThan(0);
    expect(lineEntries.every((entry) => !/\[\d+\]/.test(entry.path))).toBe(true);
    expect(lineEntries.filter((entry) => entry.kind === 'added' || entry.kind === 'removed')).toEqual([]);
  });
});
