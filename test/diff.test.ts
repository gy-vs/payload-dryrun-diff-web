import {describe, expect, it} from 'vitest';
import {alignArrays, diagnosticsForValue, diffPayloads, typeOf} from '../src/server/diff';
import {bucketPaths} from '../src/shared/paths';

describe('typeOf', () => {
  it('classifies json values', () => {
    expect(typeOf(null)).toBe('null');
    expect(typeOf('x')).toBe('string');
    expect(typeOf(1)).toBe('number');
    expect(typeOf(true)).toBe('boolean');
    expect(typeOf([])).toBe('array');
    expect(typeOf({})).toBe('object');
  });
});

describe('keyed array alignment', () => {
  const stableKeys = {'$.orders': ['orderId']};

  it('aligns reordered elements by stable key, not position', () => {
    const left = {
      orders: [
        {orderId: 'B', amount: 2},
        {orderId: 'A', amount: 1},
      ],
    };
    const right = {
      orders: [
        {orderId: 'A', amount: 10},
        {orderId: 'B', amount: 20},
      ],
    };
    const {diffs, diagnostics} = diffPayloads(left, right, stableKeys);
    expect(diagnostics).toEqual([]);
    const amountPaths = diffs.filter(d => d.path.includes('amount')).map(d => d.path).sort();
    expect(amountPaths).toEqual(['orders[key="A"].amount', 'orders[key="B"].amount'].map(p => `$.${p}`));
    // No spurious add/remove of whole elements.
    expect(diffs.filter(d => d.type === 'added' || d.type === 'removed')).toHaveLength(0);
    expect(diffs.every(d => d.type === 'value_changed')).toBe(true);
  });

  it('pairs duplicate stable keys FIFO and flags them', () => {
    const left = {
      orders: [
        {orderId: 'A', v: 1},
        {orderId: 'A', v: 2},
        {orderId: 'B', v: 3},
      ],
    };
    const right = {orders: [{orderId: 'A', v: 1}, {orderId: 'B', v: 30}]};
    const {diffs, diagnostics} = diffPayloads(left, right, stableKeys);

    // Second A on the left is a surplus occurrence -> removed with a unique path.
    const removed = diffs.filter(d => d.type === 'removed');
    expect(removed).toHaveLength(1);
    expect(removed[0].path).toContain('[occurrence=1]');
    expect(removed[0].stableKey).toBe('A');

    expect(diagnostics).toContainEqual(
      expect.objectContaining({code: 'duplicate_stable_key', side: 'left', stableKey: 'A'}),
    );
  });

  it('duplicates on both sides pair FIFO and compare', () => {
    const left = {orders: [{orderId: 'A', v: 1}, {orderId: 'A', v: 2}]};
    const right = {orders: [{orderId: 'A', v: 10}, {orderId: 'A', v: 20}]};
    const {diffs} = diffPayloads(left, right, stableKeys);
    const changes = diffs.filter(d => d.path.endsWith('.v'));
    expect(changes).toHaveLength(2);
    expect(changes.map(d => d.left)).toEqual([1, 2]);
    expect(changes.map(d => d.right)).toEqual([10, 20]);
  });

  it('falls back to position when no key is configured', () => {
    const left = {history: [{id: 'B'}, {id: 'A'}]};
    const right = {history: [{id: 'A'}, {id: 'B'}]};
    const {diffs} = diffPayloads(left, right, {});
    // Positional comparison of a reorder: first element differs in place.
    expect(diffs.some(d => d.path === '$.history[0].id' && d.type === 'value_changed')).toBe(true);
    expect(diffs.some(d => d.path === '$.history[1].id' && d.type === 'value_changed')).toBe(true);
  });

  it('flags missing stable keys and pairs leftovers positionally', () => {
    const left = {orders: [{orderId: 'A', v: 1}, {v: 2}]} as unknown as Parameters<typeof diffPayloads>[0];
    const right = {orders: [{orderId: 'A', v: 10}, {v: 20}]} as unknown as Parameters<typeof diffPayloads>[1];
    const {diffs, diagnostics} = diffPayloads(left, right, stableKeys);
    expect(diagnostics.some(d => d.code === 'missing_stable_key' && d.side === 'left')).toBe(true);
    expect(diffs.some(d => d.path === '$.orders[keyless][0].v')).toBe(true);
  });

  it('uses the first present candidate key', () => {
    const pairs = alignArrays(
      [{id: 'x', name: 'n1'}],
      [{id: 'x', name: 'n2'}],
      '$.xs',
      ['orderId', 'id'],
      [],
    );
    expect(pairs[0].align).toBe('key');
    expect(pairs[0].key).toBe('x');
  });
});

describe('value diffing', () => {
  it('reports added, removed and type-changed leaves', () => {
    const {diffs} = diffPayloads(
      {a: 1, b: 'x', c: true},
      {a: 1, b: 2, d: null},
    );
    const byPath = Object.fromEntries(diffs.map(d => [d.path, d]));
    expect(byPath['$.c'].type).toBe('removed');
    expect(byPath['$.d'].type).toBe('added');
    expect(byPath['$.b'].type).toBe('type_changed');
    expect(byPath['$.b'].leftType).toBe('string');
    expect(byPath['$.b'].rightType).toBe('number');
  });

  it('diffs nested arrays with their own stable keys', () => {
    const stableKeys = {'$.orders': ['orderId'], '$.orders[].items': ['sku']};
    // Actual nested path is element-scoped; simulate via direct nested key config using container path.
    const left = {
      orders: [
        {orderId: 'O1', items: [{sku: 'K2', q: 2}, {sku: 'K1', q: 1}]},
      ],
    };
    const right = {
      orders: [
        {orderId: 'O1', items: [{sku: 'K1', q: 10}, {sku: 'K2', q: 2}]},
      ],
    };
    // The config key is the runtime container path.
    const runtime = {'$.orders': ['orderId'], [`$.orders[key="O1"].items`]: ['sku']};
    const {diffs} = diffPayloads(left, right, {...stableKeys, ...runtime});
    expect(
      diffs.some(d => d.path === '$.orders[key="O1"].items[key="K1"].q' && d.left === 1 && d.right === 10),
    ).toBe(true);
    expect(diffs.filter(d => d.type === 'added' || d.type === 'removed')).toHaveLength(0);
  });
});

describe('bucketPaths', () => {
  it('emits every container including root', () => {
    expect(bucketPaths('$.orders[key="O1"].amount.value')).toEqual([
      '$.orders[key="O1"].amount.value',
      '$.orders[key="O1"].amount',
      '$.orders[key="O1"]',
      '$.orders',
      '$',
    ]);
    expect(bucketPaths('$')).toEqual(['$']);
  });
});

describe('diagnosticsForValue', () => {
  it('scans one-sided output for duplicate and missing keys', () => {
    const diags = diagnosticsForValue(
      {orders: [{orderId: 'A'}, {orderId: 'A'}, {}]},
      'right',
      {'$.orders': ['orderId']},
    );
    expect(diags.filter(d => d.code === 'duplicate_stable_key')).toHaveLength(1);
    expect(diags.filter(d => d.code === 'missing_stable_key')).toHaveLength(1);
  });
});
