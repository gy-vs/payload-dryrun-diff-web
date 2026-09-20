import type {Catalog, JsonValue, PipelineRevision, SampleDef} from '../shared/types';

/**
 * Fixed demo catalog: pipeline revisions, the fixed sample collection
 * (two generations, so "sample set updated" can be exercised) and the
 * stable-key configuration used to align array elements.
 */

export const REVISIONS: PipelineRevision[] = [
  {id: 'rev-legacy', label: 'rev-legacy', description: 'Legacy payload shape (v1): orders in cents, tags string.'},
  {id: 'rev-current', label: 'rev-current', description: 'Current shape (v2): amounts as money objects, tags arrays.'},
  {id: 'rev-canary', label: 'rev-canary', description: 'Canary transform (v2 + strict age validation).'},
];

const STABLE_KEYS: Record<string, string[]> = {
  '$.orders': ['orderId', 'id'],
  '$.contacts': ['email'],
  '$.items': ['sku'],
};

// A marker payload uses this sentinel to deterministically force a
// transform failure on a given side.
const POISON = '__FORCE_TRANSFORM_ERROR__';

function gen1Samples(): SampleDef[] {
  return [
    {
      id: 's-array-reorder',
      label: '数组重排：订单按稳定键对齐',
      payload: {
        customer: 'Acme',
        orders: [
          {orderId: 'O-2', amount: 2000, state: 'paid'},
          {orderId: 'O-1', amount: 1000, state: 'open'},
          {orderId: 'O-3', amount: 3000, state: 'open'},
        ],
      },
    },
    {
      id: 's-duplicate-key',
      label: '重复稳定键：同一侧出现重复 orderId',
      payload: {
        customer: 'Globex',
        orders: [
          {orderId: 'O-1', amount: 1000, state: 'open'},
          {orderId: 'O-1', amount: 1500, state: 'open'},
          {orderId: 'O-2', amount: 2000, state: 'paid'},
        ],
      },
    },
    {
      id: 's-side-failure',
      label: '某侧失败：right transform 抛错',
      payload: {
        customer: 'Initech',
        orders: [{orderId: 'O-9', amount: 900, state: 'open'}],
        // eslint-disable-next-line @typescript-eslint/naming-convention
        [`${POISON}`]: 'right',
      },
    },
    {
      id: 's-type-change',
      label: '类型变化与新增/删除字段',
      payload: {
        name: 'Umbrella',
        tags: 'vip,enterprise',
        active: 1,
        legacyCode: 'L-42',
        contacts: [{email: 'a@x.dev', handle: 'aaa'}],
      },
    },
    {
      id: 's-positional-array',
      label: '无稳定键数组：按位置比较并重排',
      payload: {
        history: [
          {at: '2026-09-01', event: 'created'},
          {at: '2026-09-02', event: 'shipped'},
        ],
        scores: [10, 20, 30],
      },
    },
    {
      id: 's-nested-items',
      label: '嵌套数组与内部稳定键',
      payload: {
        orders: [
          {
            orderId: 'O-1',
            amount: 1000,
            items: [
              {sku: 'A-1', qty: 2},
              {sku: 'A-2', qty: 1},
            ],
          },
          {
            orderId: 'O-2',
            amount: 2000,
            items: [{sku: 'A-2', qty: 3}],
          },
        ],
      },
    },
    {
      id: 's-unchanged',
      label: '无差异样例',
      payload: {
        customer: 'Stable Co',
        orders: [{orderId: 'O-1', amount: 1000, state: 'paid'}],
      },
    },
  ];
}

function gen2Samples(): SampleDef[] {
  return [
    {
      id: 's-array-reorder',
      label: '数组重排：订单按稳定键对齐',
      payload: {
        customer: 'Acme',
        region: 'eu',
        orders: [
          {orderId: 'O-3', amount: 3000, state: 'paid'},
          {orderId: 'O-1', amount: 1000, state: 'paid'},
          {orderId: 'O-2', amount: 2000, state: 'paid'},
        ],
      },
    },
    {
      id: 's-duplicate-key',
      label: '重复稳定键：同一侧出现重复 orderId',
      payload: {
        customer: 'Globex',
        orders: [
          {orderId: 'O-1', amount: 1000, state: 'open'},
          {orderId: 'O-1', amount: 1500, state: 'open'},
          {orderId: 'O-2', amount: 2000, state: 'paid'},
        ],
      },
    },
    {
      id: 's-side-failure',
      label: '某侧失败：right transform 抛错',
      payload: {
        customer: 'Initech',
        orders: [{orderId: 'O-9', amount: 900, state: 'open'}],
        // eslint-disable-next-line @typescript-eslint/naming-convention
        [`${POISON}`]: 'right',
      },
    },
    {
      id: 's-type-change',
      label: '类型变化与新增/删除字段',
      payload: {
        name: 'Umbrella',
        tags: 'vip,enterprise',
        active: 1,
        legacyCode: 'L-42',
        contacts: [{email: 'a@x.dev', handle: 'aaa'}],
      },
    },
    {
      id: 's-positional-array',
      label: '无稳定键数组：按位置比较并重排',
      payload: {
        history: [
          {at: '2026-09-01', event: 'created'},
          {at: '2026-09-02', event: 'shipped'},
        ],
        scores: [10, 20, 30],
      },
    },
    {
      id: 's-nested-items',
      label: '嵌套数组与内部稳定键',
      payload: {
        orders: [
          {
            orderId: 'O-1',
            amount: 1000,
            items: [
              {sku: 'A-1', qty: 2},
              {sku: 'A-2', qty: 1},
            ],
          },
          {
            orderId: 'O-2',
            amount: 2000,
            items: [{sku: 'A-2', qty: 3}],
          },
        ],
      },
    },
    {
      id: 's-unchanged',
      label: '无差异样例',
      payload: {
        customer: 'Stable Co',
        orders: [{orderId: 'O-1', amount: 1000, state: 'paid'}],
      },
    },
    // New in generation 2:
    {
      id: 's-canary-failure',
      label: 'canary 严格校验失败（age 类型错误）',
      payload: {customer: 'New Co', age: 'twenty-nine'},
    },
    {
      id: 's-multi-dup',
      label: '双侧重复稳定键',
      payload: {
        orders: [
          {orderId: 'O-1', amount: 1},
          {orderId: 'O-1', amount: 2},
          {orderId: 'O-1', amount: 3},
        ],
      },
    },
  ];
}

export interface TransformContext {
  revisionId: string;
  sampleId: string;
}

function clone<T extends JsonValue>(value: T): T {
  return globalThis.structuredClone(value);
}

/**
 * Apply a pipeline revision to a sample payload. Throws when the revision
 * cannot transform the payload (e.g. explicit poison marker or strict
 * validation failure in canary).
 */
export function applyRevision(revisionId: string, sample: SampleDef): JsonValue {
  const payload = clone(sample.payload);
  const root = payload as Record<string, JsonValue>;
  const poison = root[POISON];

  if (revisionId === 'rev-legacy') {
    if (poison === 'left' || poison === 'both') {
      throw new Error(`legacy transform failed for sample ${sample.id}: forced failure`);
    }
    delete root[POISON];
    return root;
  }

  if (revisionId === 'rev-current' || revisionId === 'rev-canary') {
    if (poison === 'right' || poison === 'both') {
      throw new Error(`${revisionId} transform failed for sample ${sample.id}: forced failure`);
    }
    delete root[POISON];

    const migrateOrders = (value: JsonValue): void => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return;
      const record = value as Record<string, JsonValue>;
      if (Array.isArray(record.orders)) {
        record.orders = record.orders.map(rawOrder => {
          const order = rawOrder as Record<string, JsonValue>;
          if (typeof order.amount === 'number') {
            order.amount = {value: order.amount, currency: 'USD'};
          }
          return order;
        });
      }
    };

    migrateOrders(root);

    if (typeof root.tags === 'string') {
      root.tags = root.tags.split(',').map(tag => tag.trim()).filter(Boolean);
    }
    if (typeof root.active === 'number') {
      root.active = root.active !== 0;
    }
    delete root.legacyCode;

    if (revisionId === 'rev-canary' && 'age' in root) {
      if (typeof root.age !== 'number') {
        throw new Error(
          `canary strict validation failed for sample ${sample.id}: age must be a number at $.age`,
        );
      }
    }
    return root;
  }

  throw new Error(`unknown revision: ${revisionId}`);
}

export interface CatalogService {
  get(): Catalog;
  rotateTo(generation: number): Catalog;
}

export function createCatalogService(): CatalogService {
  let generation = 1;
  const samplesFor = (gen: number): SampleDef[] => (gen === 1 ? gen1Samples() : gen2Samples());
  return {
    get() {
      return {
        revisions: REVISIONS,
        samples: samplesFor(generation),
        sampleGeneration: generation,
        stableKeys: STABLE_KEYS,
      };
    },
    rotateTo(next: number) {
      generation = next;
      return this.get();
    },
  };
}
