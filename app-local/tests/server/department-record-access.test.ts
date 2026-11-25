import { RecordAccessRegistry } from '@nocobase/authorization/core';
import { describe, expect, it } from 'vitest';

import {
  MY_DEPARTMENTS,
  MY_DEPARTMENTS_AND_BELOW,
  defineDepartmentRecordAccess,
} from '../../server/department-record-access.js';
import type { DepartmentService } from '../../server/providers/departments.js';

/**
 * R-013 两把部门范围键的解析器（验收标准第 5 条）。
 *
 * 有部门时返回「departmentId 等于其中某一个」的等值条件并集 —— 框架的条件里没有
 * `$in`；没有部门、或主体不是用户时返回 false，决策仍是放行、范围是空结果，绝不
 * 返回全部。解析器只依赖 R-012 的 DepartmentService，这里用假实现验证，不碰部门表。
 */
function fakeDepartmentService(
  overrides: Partial<DepartmentService> = {},
): DepartmentService {
  return {
    subtreeIds: async () => [],
    departmentIdsOfUser: async () => [],
    managerOf: async () => null,
    primaryDepartmentOf: async () => null,
    titlesByIds: async () => ({}),
    byCode: async () => null,
    resolveSuccessor: async () => null,
    ...overrides,
  };
}

function registryWith(service: DepartmentService): RecordAccessRegistry {
  const registry = new RecordAccessRegistry();
  for (const definition of defineDepartmentRecordAccess(service)) {
    registry.define(definition);
  }
  return registry;
}

const context = (principalType = 'user', id = 'user-1') => ({
  principal: { type: principalType, id },
  collection: 'fqcTickets',
  action: 'read',
  params: undefined,
});

const equalDepartment = (id: string) => ({
  kind: 'condition',
  path: ['departmentId'],
  operator: '$eq',
  value: id,
});

describe('R-013 部门范围键', () => {
  it('returns the union of equality conditions for the subjects departments', async () => {
    const registry = registryWith(
      fakeDepartmentService({
        departmentIdsOfUser: async () => ['dept-a', 'dept-b'],
      }),
    );
    const scope = await registry.resolve(MY_DEPARTMENTS, context());
    expect(scope).toEqual({
      kind: 'group',
      logic: 'or',
      items: [equalDepartment('dept-a'), equalDepartment('dept-b')],
    });
    // 框架的条件里没有 $in，多部门只能展开成等值条件的或。
    expect(JSON.stringify(scope)).not.toContain('$in');
  });

  it('returns the single equality condition when the subject has one department', async () => {
    const registry = registryWith(
      fakeDepartmentService({ departmentIdsOfUser: async () => ['dept-a'] }),
    );
    expect(await registry.resolve(MY_DEPARTMENTS, context())).toEqual(
      equalDepartment('dept-a'),
    );
  });

  it('returns false when the subject belongs to no department', async () => {
    const registry = registryWith(
      fakeDepartmentService({ departmentIdsOfUser: async () => [] }),
    );
    expect(await registry.resolve(MY_DEPARTMENTS, context())).toBe(false);
  });

  it('returns false for a principal that is not a user and never asks the service', async () => {
    let asked = 0;
    const registry = registryWith(
      fakeDepartmentService({
        departmentIdsOfUser: async () => {
          asked += 1;
          return ['dept-a'];
        },
      }),
    );
    expect(
      await registry.resolve(MY_DEPARTMENTS, context('service', 'svc')),
    ).toBe(false);
    expect(asked).toBe(0);
  });

  it('expands the department and every active descendant for the below variant', async () => {
    const registry = registryWith(
      fakeDepartmentService({
        departmentIdsOfUser: async () => ['dept-a', 'dept-b'],
        subtreeIds: async (departmentId) =>
          departmentId === 'dept-a' ? ['dept-a', 'dept-a1'] : ['dept-b'],
      }),
    );
    expect(await registry.resolve(MY_DEPARTMENTS_AND_BELOW, context())).toEqual(
      {
        kind: 'group',
        logic: 'or',
        items: [
          equalDepartment('dept-a'),
          equalDepartment('dept-a1'),
          equalDepartment('dept-b'),
        ],
      },
    );
  });

  it('returns false for the below variant when the subject belongs to no department', async () => {
    const registry = registryWith(
      fakeDepartmentService({ departmentIdsOfUser: async () => [] }),
    );
    expect(await registry.resolve(MY_DEPARTMENTS_AND_BELOW, context())).toBe(
      false,
    );
  });

  // 这里只断言声明里的适用性元数据；「不带 departmentId 的表看不到这两把键」这个行为
  // 由 authorization-resources.test.ts 的目录测试覆盖。
  it('declares the departmentId requirement as workspace metadata', () => {
    const registry = registryWith(fakeDepartmentService());
    const definitions = registry.list();
    expect(definitions.map((definition) => definition.key)).toEqual([
      MY_DEPARTMENTS,
      MY_DEPARTMENTS_AND_BELOW,
    ]);
    for (const definition of definitions) {
      // 框架要求至少声明一张表；requiredFields 让工作区只在这类表上提供这把键。
      expect(definition.collections).toEqual(['*']);
      expect(
        (definition as { requiredFields?: readonly string[] }).requiredFields,
      ).toEqual(['departmentId']);
    }
  });
});
