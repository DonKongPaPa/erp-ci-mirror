// @vitest-environment node
import { expect } from 'vitest';

import { createAppTest } from '../helpers/test-app.js';
import { createStandaloneServer } from '../../server/standalone.js';
import { shiftServiceToken } from '../../server/providers/shifts.js';

/**
 * R-025 验收12/19 的内部服务部分：不经过 HTTP、不查授权，只回在用班次，
 * 按 sortOrder 再按编码排序。返回值是副本，调用方改对象或数组都动不到库。
 */
const test = createAppTest({
  scope: 'test',
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

interface Row {
  [key: string]: unknown;
}

const now = new Date('2026-11-27T00:00:00.000Z');

test('R-025 验收19: listActiveShifts 空表返回空、排序正确、返回值改不动库', async ({
  app,
  connection,
}) => {
  const service = app.container.resolve(shiftServiceToken);
  // 前置条件真成立：这张表没有预置班次，第一次读必须是空数组。
  expect(await connection.repository<Row>('shifts').count()).toBe(0);
  expect(await service.listActiveShifts()).toEqual([]);

  for (const row of [
    { id: 'C', sortOrder: 2, active: true },
    { id: 'A', sortOrder: 1, active: true },
    { id: 'B', sortOrder: 1, active: true },
    { id: 'OFF', sortOrder: 0, active: false },
  ]) {
    await connection.repository<Row>('shifts').createOne({
      values: {
        id: row.id,
        title: row.id,
        startMinute: 480,
        endMinute: 1020,
        breakStartMinute: null,
        breakEndMinute: null,
        active: row.active,
        sortOrder: row.sortOrder,
        createdAt: now,
        updatedAt: now,
      },
    });
  }

  const shifts = await service.listActiveShifts();
  expect(shifts.map((shift) => shift.id)).toEqual(['A', 'B', 'C']);
  expect(shifts[0]).toMatchObject({
    id: 'A',
    title: 'A',
    startMinute: 480,
    endMinute: 1020,
    breakStartMinute: null,
    breakEndMinute: null,
    active: true,
    sortOrder: 1,
  });
  expect(Object.keys(shifts[0]!).sort()).toEqual([
    'active',
    'breakEndMinute',
    'breakStartMinute',
    'createdAt',
    'endMinute',
    'id',
    'sortOrder',
    'startMinute',
    'title',
    'updatedAt',
  ]);

  // 改返回值与改数组都不能写回库；再读一次还是原来的三行。
  const mutable = shifts as { id: string; title: string }[];
  mutable[0]!.title = '被改过';
  mutable.pop();
  const again = await service.listActiveShifts();
  expect(again.map((shift) => shift.id)).toEqual(['A', 'B', 'C']);
  const stored = await connection
    .repository<Row>('shifts')
    .findOne({ filter: { id: 'A' } });
  expect(stored?.title).toBe('A');
});
