import path from 'node:path';
import { createDatabaseTest } from '@nocobase/app-testing/server';
import type { Application } from '@nocobase/app-server/application';
import { databaseManagerToken, type DatabaseConnection } from '@nocobase/db';
import { ServiceContainer } from '@nocobase/service-provider';
import { describe, expect } from 'vitest';

import DepartmentProvider, {
  DatabaseDepartmentService,
  departmentServiceToken,
  type Department,
  type DepartmentMembership,
} from '../../server/providers/departments.js';

/**
 * R-012 部门管理：给别的模块用的内部服务。
 *
 * 一棵三级树上逐个断言五个方法，停用的部门不计入；空表与没有部门的用户返回空、
 * 不抛错（设计文档验收标准第 9 条）。树的解析与环检测都在内存里，所以这里也
 * 验证数据里误写的环不会让读取死循环。
 */
const test = createDatabaseTest({
  migrations: [
    {
      packageName: 'departments-service-test',
      directory: path.resolve(
        import.meta.dirname,
        '../../database/main/migrations',
      ),
    },
  ],
});

const now = new Date('2026-11-24T00:00:00.000Z');

interface DepartmentRow extends Department {
  readonly succeededAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface MembershipRow extends DepartmentMembership {
  readonly createdAt: Date;
}

async function addDepartment(
  connection: DatabaseConnection,
  row: Pick<DepartmentRow, 'id' | 'title'> &
    Partial<Omit<DepartmentRow, 'id' | 'title'>>,
): Promise<void> {
  await connection.repository<DepartmentRow>('departments').createOne({
    values: {
      parentId: null,
      managerId: null,
      active: true,
      sortOrder: 0,
      kind: 'department',
      code: row.id,
      successorId: null,
      succeededAt: null,
      createdAt: now,
      updatedAt: now,
      ...row,
    },
  });
}

async function addMember(
  connection: DatabaseConnection,
  row: Pick<MembershipRow, 'id' | 'departmentId' | 'userId'> &
    Partial<Omit<MembershipRow, 'id' | 'departmentId' | 'userId'>>,
): Promise<void> {
  await connection.repository<MembershipRow>('departmentMembers').createOne({
    values: {
      isPrimary: false,
      createdAt: now,
      ...row,
    },
  });
}

/**
 * 公司
 *  ├─ 销售部
 *  │   ├─ 华东区
 *  │   └─ 华南区
 *  ├─ 人事部
 *  └─ 已撤销售部（停用）
 *      └─ 华东组（停用）
 */
async function seedTree(connection: DatabaseConnection): Promise<void> {
  await addDepartment(connection, {
    id: 'company',
    title: '公司',
    managerId: 'u-manager',
  });
  await addDepartment(connection, {
    id: 'sales',
    title: '销售部',
    parentId: 'company',
    managerId: 'u-manager',
    sortOrder: 1,
  });
  await addDepartment(connection, {
    id: 'sales-east',
    title: '华东区',
    parentId: 'sales',
    sortOrder: 1,
  });
  await addDepartment(connection, {
    id: 'sales-west',
    title: '华南区',
    parentId: 'sales',
    sortOrder: 2,
  });
  await addDepartment(connection, {
    id: 'hr',
    title: '人事部',
    parentId: 'company',
    sortOrder: 2,
  });
  await addDepartment(connection, {
    id: 'closed',
    title: '已撤销售部',
    parentId: 'company',
    managerId: 'u-manager',
    active: false,
    sortOrder: 3,
  });
  await addDepartment(connection, {
    id: 'closed-child',
    title: '华东组',
    parentId: 'closed',
    active: false,
  });

  await addMember(connection, {
    id: 'member-1',
    departmentId: 'company',
    userId: 'u-1',
    isPrimary: true,
  });
  await addMember(connection, {
    id: 'member-2',
    departmentId: 'sales',
    userId: 'u-1',
  });
  await addMember(connection, {
    id: 'member-3',
    departmentId: 'sales-east',
    userId: 'u-1',
  });
  // 停用部门即使还有成员，也不能出现在 departmentIdsOfUser 里。
  await addMember(connection, {
    id: 'member-4',
    departmentId: 'closed',
    userId: 'u-1',
  });
  await addMember(connection, {
    id: 'member-5',
    departmentId: 'hr',
    userId: 'u-2',
  });
  await addMember(connection, {
    id: 'member-6',
    departmentId: 'company',
    userId: 'u-manager',
  });
  // 主部门落在已停用的部门上：primaryDepartmentOf 要返回空。
  await addMember(connection, {
    id: 'member-7',
    departmentId: 'closed',
    userId: 'u-3',
    isPrimary: true,
  });
}

describe('R-012 部门内部服务', () => {
  test('R-012 验收9：subtreeIds 返回部门与全部未停用后代，停用节点以下不再计入', async ({
    connection,
    database,
  }) => {
    await seedTree(connection);
    const service = new DatabaseDepartmentService(database);

    await expect(service.subtreeIds('company')).resolves.toEqual([
      'company',
      'hr',
      'sales',
      'sales-east',
      'sales-west',
    ]);
    await expect(service.subtreeIds('sales')).resolves.toEqual([
      'sales',
      'sales-east',
      'sales-west',
    ]);
    await expect(service.subtreeIds('sales-east')).resolves.toEqual([
      'sales-east',
    ]);
    // 部门自己已停用，整棵子树返回空。
    await expect(service.subtreeIds('closed')).resolves.toEqual([]);
    await expect(service.subtreeIds('missing')).resolves.toEqual([]);
  });

  test('R-012 验收9：departmentIdsOfUser 只返回未停用的部门', async ({
    connection,
    database,
  }) => {
    await seedTree(connection);
    const service = new DatabaseDepartmentService(database);

    await expect(service.departmentIdsOfUser('u-1')).resolves.toEqual([
      'company',
      'sales',
      'sales-east',
    ]);
    await expect(service.departmentIdsOfUser('u-2')).resolves.toEqual(['hr']);
    await expect(service.departmentIdsOfUser('u-manager')).resolves.toEqual([
      'company',
    ]);
    await expect(service.departmentIdsOfUser('nobody')).resolves.toEqual([]);
  });

  test('R-012 验收6：managerOf 返回负责人，停用的部门返回 null', async ({
    connection,
    database,
  }) => {
    await seedTree(connection);
    const service = new DatabaseDepartmentService(database);

    await expect(service.managerOf('sales')).resolves.toBe('u-manager');
    await expect(service.managerOf('company')).resolves.toBe('u-manager');
    await expect(service.managerOf('hr')).resolves.toBeNull();
    // 部门已停用：负责人不再返回，即便库里还留着 managerId。
    await expect(service.managerOf('closed')).resolves.toBeNull();
    await expect(service.managerOf('missing')).resolves.toBeNull();
  });

  test('R-012 验收6：primaryDepartmentOf 返回主部门，主部门停用时返回 null', async ({
    connection,
    database,
  }) => {
    await seedTree(connection);
    const service = new DatabaseDepartmentService(database);

    await expect(service.primaryDepartmentOf('u-1')).resolves.toBe('company');
    // 有部门但不是主部门：返回空。
    await expect(service.primaryDepartmentOf('u-2')).resolves.toBeNull();
    // 主部门已停用：返回空。
    await expect(service.primaryDepartmentOf('u-3')).resolves.toBeNull();
    await expect(service.primaryDepartmentOf('nobody')).resolves.toBeNull();
  });

  test('titlesByIds 返回 id 到名称的对照，缺的 id 不出现', async ({
    connection,
    database,
  }) => {
    await seedTree(connection);
    const service = new DatabaseDepartmentService(database);

    await expect(
      service.titlesByIds(['company', 'sales', 'missing']),
    ).resolves.toEqual({
      company: '公司',
      sales: '销售部',
    });
    // 停用部门仍要能查到名字：业务记录上的 departmentId 会一直指着它。
    await expect(service.titlesByIds(['closed'])).resolves.toEqual({
      closed: '已撤销售部',
    });
    await expect(service.titlesByIds([])).resolves.toEqual({});
  });

  test('R-012 验收9：空表与没有部门的用户返回空、不抛错', async ({ database }) => {
    const service = new DatabaseDepartmentService(database);

    await expect(service.subtreeIds('missing')).resolves.toEqual([]);
    await expect(service.departmentIdsOfUser('nobody')).resolves.toEqual([]);
    await expect(service.managerOf('missing')).resolves.toBeNull();
    await expect(service.primaryDepartmentOf('nobody')).resolves.toBeNull();
    await expect(service.titlesByIds([])).resolves.toEqual({});
    await expect(service.titlesByIds(['missing'])).resolves.toEqual({});
  });

  test('数据里有环时读取不死循环，也不会重复返回', async ({
    connection,
    database,
  }) => {
    await addDepartment(connection, {
      id: 'loop-a',
      title: '环 A',
      parentId: 'loop-b',
    });
    await addDepartment(connection, {
      id: 'loop-b',
      title: '环 B',
      parentId: 'loop-a',
    });
    const service = new DatabaseDepartmentService(database);

    await expect(service.subtreeIds('loop-a')).resolves.toEqual([
      'loop-a',
      'loop-b',
    ]);
  });

  test('provider 把接口注册到容器，别的模块按令牌解析', async ({
    database,
  }) => {
    const container = new ServiceContainer();
    container.instance(databaseManagerToken, database);
    const provider = new DepartmentProvider({
      container,
    } as unknown as Application);

    provider.register();

    expect(container.has(departmentServiceToken)).toBe(true);
    const service = container.resolve(departmentServiceToken);
    await expect(service.titlesByIds([])).resolves.toEqual({});
  });
});

test('R-012 验收18：subtreeIds 遇到停用的节点就不再往下走', async ({
  connection,
  database,
}) => {
  // 数据违反「停用的部门一定是空的」：停用的父节点下挂着未停用的子部门。
  // subtreeIds 不往下走；departmentIdsOfUser 仍会返回这个人所在的未停用部门。
  // 两个方法对同一个人的答案不一致，方向是范围变窄，不是放宽。
  await addDepartment(connection, { id: 'root', title: '公司' });
  await addDepartment(connection, {
    id: 'frozen',
    title: '已停用中心',
    parentId: 'root',
    active: false,
  });
  await addDepartment(connection, {
    id: 'frozen-child',
    title: '停用父节点下的在用部门',
    parentId: 'frozen',
  });
  await addMember(connection, {
    id: 'member-frozen',
    departmentId: 'frozen-child',
    userId: 'u-frozen',
  });

  const service = new DatabaseDepartmentService(database);
  await expect(service.subtreeIds('root')).resolves.toEqual(['root']);
  await expect(service.subtreeIds('frozen')).resolves.toEqual([]);
  await expect(service.subtreeIds('frozen-child')).resolves.toEqual([
    'frozen-child',
  ]);
  await expect(service.departmentIdsOfUser('u-frozen')).resolves.toEqual([
    'frozen-child',
  ]);
});

test('R-012 验收12：byCode 优先未撤销的部门，已撤销的顺着继任关系给承接方', async ({
  connection,
  database,
}) => {
  await addDepartment(connection, {
    id: 'live',
    title: '在用部门',
    code: 'MAIN',
  });
  // 同一个编码也出现在一个已撤销的部门上：在用的优先。
  await addDepartment(connection, {
    id: 'revoked',
    title: '已并掉的部门',
    code: 'MAIN',
    active: false,
    successorId: 'live',
  });
  // 一段继任链：chain-1 → chain-2 → chain-3。
  await addDepartment(connection, {
    id: 'chain-1',
    title: '链一',
    code: 'CHAIN',
    active: false,
    successorId: 'chain-2',
  });
  await addDepartment(connection, {
    id: 'chain-2',
    title: '链二',
    code: 'MIDDLE',
    active: false,
    successorId: 'chain-3',
  });
  await addDepartment(connection, {
    id: 'chain-3',
    title: '链三',
    code: 'TAIL',
  });

  const service = new DatabaseDepartmentService(database);
  await expect(service.byCode('MAIN')).resolves.toBe('live');
  await expect(service.byCode('CHAIN')).resolves.toBe('chain-3');
  await expect(service.byCode('TAIL')).resolves.toBe('chain-3');
  await expect(service.byCode('missing')).resolves.toBeNull();

  await expect(service.resolveSuccessor('chain-1')).resolves.toBe('chain-3');
  await expect(service.resolveSuccessor('chain-2')).resolves.toBe('chain-3');
  await expect(service.resolveSuccessor('chain-3')).resolves.toBeNull();
  await expect(service.resolveSuccessor('live')).resolves.toBeNull();
  await expect(service.resolveSuccessor('missing')).resolves.toBeNull();
});

test('R-012 验收12：同码的已撤销部门不止一个时，byCode 取最晚停用的那个', async ({
  connection,
  database,
}) => {
  // 两个同码的已撤销部门指向不同的承接方；编码在撤销之后让出来，所以能重复。
  // 先插早撤销的，让「取第一个」的实现会给出错误答案。
  await addDepartment(connection, {
    id: 'target-late',
    title: '晚承接',
    code: 'TARGET-LATE',
  });
  await addDepartment(connection, {
    id: 'target-early',
    title: '早承接',
    code: 'TARGET-EARLY',
  });
  await addDepartment(connection, {
    id: 'revoked-early',
    title: '早撤销',
    code: 'REUSED',
    active: false,
    successorId: 'target-early',
    succeededAt: new Date('2026-11-24T10:00:00.000Z'),
  });
  await addDepartment(connection, {
    id: 'revoked-late',
    title: '晚撤销',
    code: 'REUSED',
    active: false,
    successorId: 'target-late',
    succeededAt: new Date('2026-11-25T10:00:00.000Z'),
  });

  // succeededAt 缺失（只可能来自手工改库）时回落到 updatedAt。
  await addDepartment(connection, {
    id: 'target-newer-update',
    title: '新近改过',
    code: 'TARGET-NEWER',
  });
  await addDepartment(connection, {
    id: 'target-older-update',
    title: '早先改过',
    code: 'TARGET-OLDER',
  });
  await addDepartment(connection, {
    id: 'revoked-newer-update',
    title: '新近改动',
    code: 'FALLBACK',
    active: false,
    successorId: 'target-newer-update',
    updatedAt: new Date('2026-11-25T12:00:00.000Z'),
  });
  await addDepartment(connection, {
    id: 'revoked-older-update',
    title: '早先改动',
    code: 'FALLBACK',
    active: false,
    successorId: 'target-older-update',
    updatedAt: new Date('2026-11-23T12:00:00.000Z'),
  });

  const service = new DatabaseDepartmentService(database);
  // 每次都给同一个、且是最晚停用的那个。
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await expect(service.byCode('REUSED')).resolves.toBe('target-late');
    await expect(service.byCode('FALLBACK')).resolves.toBe(
      'target-newer-update',
    );
  }
});
