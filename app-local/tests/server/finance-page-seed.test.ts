import { describe, expect, it } from 'vitest';

import {
  financePageGrants,
  persistFinancePageGrants,
} from '../../database/main/seeds/202611280004_seed_finance_page_grants.js';
import { businessPermissionSets } from '../../database/main/seeds/202611240001_seed_business_permission_sets.js';

/**
 * R-075 / R-065：新种子只在 finance 角色的授权仍是原种子写出的那份时补页面授权。
 * 用内存里的假 QueryAdapter 覆盖三条路径；示例数据一律编造。
 */
type Row = { key: string; grants: string; id: string; createdAt: Date; updatedAt: Date };

function fakeAdapter(initial: Row | undefined) {
  let row = initial;
  let inserted = 0;
  let updated = 0;
  const query = {
    selectFrom: (_table: string) => ({
      select: () => ({
        where: (_field: string, _op: string, key: string) => ({
          executeTakeFirst: async () =>
            row?.key === key
              ? { key: row.key, grants: row.grants }
              : undefined,
        }),
      }),
    }),
    insertInto: (_table: string) => ({
      values: (values: Omit<Row, 'id'> & { id: string }) => ({
        execute: async () => {
          inserted += 1;
          row = { ...values } as Row;
          return row;
        },
      }),
    }),
    updateTable: (_table: string) => ({
      set: (patch: { grants: string; updatedAt: Date }) => ({
        where: (_field: string, _op: string, key: string) => ({
          execute: async () => {
            if (row?.key !== key) return;
            updated += 1;
            row = { ...row, ...patch };
          },
        }),
      }),
    }),
  };
  return {
    query,
    state: () => ({ row, inserted, updated }),
  };
}

const baseline = JSON.stringify(
  businessPermissionSets.find((set) => set.key === 'finance')!.grants,
);

describe('202611280004 finance page grant seed', () => {
  it('gives a fresh finance role both page grants and is idempotent', async () => {
    const db = fakeAdapter({
      key: 'finance',
      grants: baseline,
      id: 'f1',
      createdAt: new Date('2026-11-28T00:00:00Z'),
      updatedAt: new Date('2026-11-28T00:00:00Z'),
    });
    expect(await persistFinancePageGrants(db.query as never)).toEqual({
      created: [],
      granted: ['finance'],
    });
    const stored = JSON.parse(db.state().row!.grants) as {
      resource: { type: string; id: string };
    }[];
    expect(stored).toEqual(expect.arrayContaining(financePageGrants));
    expect(db.state().updated).toBe(1);

    expect(await persistFinancePageGrants(db.query as never)).toEqual({
      created: [],
      granted: [],
    });
    expect(db.state().updated).toBe(1);
  });

  it('never overwrites grants an administrator changed', async () => {
    const changed = JSON.stringify([
      { resource: { type: 'composite', id: 'expenses' }, actions: [{ action: 'view' }] },
    ]);
    const db = fakeAdapter({
      key: 'finance',
      grants: changed,
      id: 'f1',
      createdAt: new Date('2026-11-28T00:00:00Z'),
      updatedAt: new Date('2026-11-28T00:00:00Z'),
    });
    expect(await persistFinancePageGrants(db.query as never)).toEqual({
      created: [],
      granted: [],
    });
    expect(db.state().row!.grants).toBe(changed);
    expect(db.state().updated).toBe(0);
  });

  it('creates the role with page grants when it is missing', async () => {
    const db = fakeAdapter(undefined);
    expect(await persistFinancePageGrants(db.query as never)).toEqual({
      created: ['finance'],
      granted: [],
    });
    expect(db.state().row!.grants).toBe(JSON.stringify(financePageGrants));
    expect(db.state().inserted).toBe(1);
  });
});
