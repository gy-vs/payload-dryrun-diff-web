import {describe, expect, it} from 'vitest';
import {diffValues, normalizePath} from '../src/server/diff';

describe('diffValues', () => {
  it('reports added, removed, type_changed and value_changed on objects', () => {
    const entries = diffValues(
      {keep: 1, drop: 'x', retune: 'a', morph: '1'},
      {keep: 1, add: true, retune: 'b', morph: 1},
    );
    const byPath = new Map(entries.map((entry) => [entry.path, entry]));
    expect(byPath.get('$.add')?.kind).toBe('added');
    expect(byPath.get('$.drop')?.kind).toBe('removed');
    expect(byPath.get('$.retune')?.kind).toBe('value_changed');
    expect(byPath.get('$.morph')?.kind).toBe('type_changed');
    expect(byPath.get('$.morph')?.message).toBe('string -> number');
    expect(byPath.has('$.keep')).toBe(false);
    expect(entries.every((entry) => entry.group === normalizePath(entry.path))).toBe(true);
  });

  it('compares arrays positionally when no stable key is configured', () => {
    const entries = diffValues({list: ['a', 'b', 'c']}, {list: ['b', 'a']});
    const byPath = new Map(entries.map((entry) => [entry.path, entry.kind]));
    expect(byPath.get('$.list[0]')).toBe('value_changed');
    expect(byPath.get('$.list[1]')).toBe('value_changed');
    expect(byPath.get('$.list[2]')).toBe('removed');
  });

  it('treats reordered keyed arrays as identical (no add/remove noise)', () => {
    const before = {lines: [{sku: 'A', qty: 1}, {sku: 'B', qty: 2}, {sku: 'C', qty: 3}]};
    const after = {lines: [{sku: 'C', qty: 3}, {sku: 'A', qty: 1}, {sku: 'B', qty: 2}]};
    expect(diffValues(before, after, {arrayKeys: {'$.lines': 'sku'}})).toEqual([]);
  });

  it('reports keyed element changes at key-selector paths and key-based add/remove', () => {
    const before = {lines: [{sku: 'A', qty: 1}, {sku: 'B', qty: 2}]};
    const after = {lines: [{sku: 'B', qty: 5}, {sku: 'C', qty: 9}]};
    const entries = diffValues(before, after, {arrayKeys: {'$.lines': 'sku'}});
    const byPath = new Map(entries.map((entry) => [entry.path, entry]));
    expect(byPath.get('$.lines[sku=B].qty')?.kind).toBe('value_changed');
    expect(byPath.get('$.lines[sku=B].qty')?.group).toBe('$.lines[].qty');
    expect(byPath.get('$.lines[sku=A]')?.kind).toBe('removed');
    expect(byPath.get('$.lines[sku=C]')?.kind).toBe('added');
  });

  it('matches duplicate stable keys in order and reports surplus copies', () => {
    const before = {lines: [{sku: 'D', qty: 1}, {sku: 'D', qty: 2}, {sku: 'E', qty: 3}]};
    const after = {lines: [{sku: 'D', qty: 9}, {sku: 'E', qty: 3}]};
    const entries = diffValues(before, after, {arrayKeys: {'$.lines': 'sku'}});
    const changed = entries.filter((entry) => entry.kind === 'value_changed');
    const removed = entries.filter((entry) => entry.kind === 'removed');
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({path: '$.lines[sku=D].qty', before: 1, after: 9});
    expect(removed).toHaveLength(1);
    expect(removed[0]).toMatchObject({path: '$.lines[sku=D]', before: {sku: 'D', qty: 2}});
  });

  it('aligns extra duplicate keys on the after side as added', () => {
    const before = {lines: [{sku: 'D', qty: 1}]};
    const after = {lines: [{sku: 'D', qty: 1}, {sku: 'D', qty: 2}]};
    const entries = diffValues(before, after, {arrayKeys: {'$.lines': 'sku'}});
    expect(entries).toEqual([
      expect.objectContaining({path: '$.lines[sku=D]', kind: 'added', after: {sku: 'D', qty: 2}}),
    ]);
  });

  it('falls back to positional matching for elements missing the key field', () => {
    const before = {lines: [{sku: 'A', qty: 1}, {qty: 7}, {qty: 8}]};
    const after = {lines: [{qty: 7}, {sku: 'A', qty: 1}, {qty: 9}]};
    const entries = diffValues(before, after, {arrayKeys: {'$.lines': 'sku'}});
    // Unkeyed elements match among themselves by order: 7 vs 7 (no diff), 8 vs 9 (changed).
    expect(entries).toEqual([expect.objectContaining({path: '$.lines[2].qty', kind: 'value_changed', before: 8, after: 9})]);
  });

  it('recurses into nested objects under keyed array elements', () => {
    const before = {lines: [{sku: 'A', dims: {w: 1, h: 2}}]};
    const after = {lines: [{sku: 'A', dims: {w: 1, h: 3}}]};
    const entries = diffValues(before, after, {arrayKeys: {'$.lines': 'sku'}});
    expect(entries).toEqual([expect.objectContaining({path: '$.lines[sku=A].dims.h', kind: 'value_changed'})]);
  });

  it('normalizes positional and key selectors to []', () => {
    expect(normalizePath('$.lines[3].qty')).toBe('$.lines[].qty');
    expect(normalizePath('$.lines[sku=A-1].qty')).toBe('$.lines[].qty');
    expect(normalizePath('$.order.id')).toBe('$.order.id');
  });
});
