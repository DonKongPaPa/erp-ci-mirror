import { describe, expect, test } from 'vitest';

import {
  assertCodeAvailable,
  assertDeactivatable,
  assertDepartmentActive,
  assertKind,
  assertManagerIsMember,
  assertMemberRemovable,
  assertMergeable,
  assertNoCycle,
  assertParentActive,
  assertPrimaryInvariant,
  assertSuccessorActive,
  assertTitleAvailable,
  assertTransferable,
  DepartmentRuleError,
  DEPARTMENT_KINDS,
  type Department,
  type DepartmentMembership,
} from '../../server/providers/departments.js';

/**
 * R-012 部门管理：服务层的校验规则。
 *
 * 每条规则都给出正反两组：满足条件时不抛错，违反时抛出带 code 的
 * DepartmentRuleError。端点（第二部分）把 code 映射成 409 / 422。
 */
const departments: readonly Department[] = [
  {
    id: 'company',
    title: '公司',
    parentId: null,
    managerId: 'u-manager',
    active: true,
    sortOrder: 0,
    kind: 'company',
    code: 'company',
    successorId: null,
  },
  {
    id: 'sales',
    title: '销售部',
    parentId: 'company',
    managerId: 'u-manager',
    active: true,
    sortOrder: 1,
    kind: 'department',
    code: 'sales',
    successorId: null,
  },
  {
    id: 'sales-east',
    title: '华东区',
    parentId: 'sales',
    managerId: null,
    active: true,
    sortOrder: 1,
    kind: 'team',
    code: 'sales-east',
    successorId: null,
  },
  {
    id: 'hr',
    title: '人事部',
    parentId: 'company',
    managerId: null,
    active: true,
    sortOrder: 2,
    kind: 'department',
    code: 'hr',
    successorId: null,
  },
  {
    id: 'closed',
    title: '已撤销售部',
    parentId: 'company',
    managerId: null,
    active: false,
    sortOrder: 3,
    kind: 'department',
    code: 'closed',
    successorId: null,
  },
];

function membership(
  id: string,
  departmentId: string,
  userId: string,
  isPrimary = false,
): DepartmentMembership {
  return { id, departmentId, userId, isPrimary };
}

/** 跑一段应被拒绝的逻辑，返回抛出的规则错误。 */
function ruleError(run: () => void): DepartmentRuleError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(DepartmentRuleError);
    return error as DepartmentRuleError;
  }
  throw new Error('预期抛出 DepartmentRuleError，但没有抛。');
}

describe('R-012 不成环', () => {
  test('移到另一棵子树下是允许的', () => {
    expect(() => assertNoCycle(departments, 'sales-east', 'hr')).not.toThrow();
    expect(() => assertNoCycle(departments, 'sales', null)).not.toThrow();
  });

  test('上级就是自己要被拒绝', () => {
    expect(
      ruleError(() => assertNoCycle(departments, 'sales', 'sales')).code,
    ).toBe('department-cycle');
  });

  test('移到自己的后代下面要被拒绝', () => {
    expect(
      ruleError(() => assertNoCycle(departments, 'company', 'sales-east')).code,
    ).toBe('department-cycle');
  });

  test('现有数据里已有环时也拒绝继续移动', () => {
    const broken: readonly Department[] = [
      { ...departments[0], id: 'loop-a', parentId: 'loop-b' },
      { ...departments[0], id: 'loop-b', parentId: 'loop-a' },
      { ...departments[0], id: 'other', parentId: null },
    ];
    expect(ruleError(() => assertNoCycle(broken, 'other', 'loop-a')).code).toBe(
      'department-cycle',
    );
  });
});

describe('R-012 同一上级下名称不重名', () => {
  test('不同上级下同名可以', () => {
    expect(() =>
      assertTitleAvailable(departments, {
        title: '销售部',
        parentId: 'hr',
      }),
    ).not.toThrow();
  });

  test('同一上级下重名要被拒绝', () => {
    expect(
      ruleError(() =>
        assertTitleAvailable(departments, {
          title: '销售部',
          parentId: 'company',
        }),
      ).code,
    ).toBe('duplicate-title');
  });

  test('根部门之间的重名也要被拒绝（数据库唯一约束盖不到）', () => {
    expect(
      ruleError(() =>
        assertTitleAvailable(departments, {
          title: '公司',
          parentId: null,
        }),
      ).code,
    ).toBe('duplicate-title');
  });

  test('改名时排除自己', () => {
    expect(() =>
      assertTitleAvailable(departments, {
        title: '销售部',
        parentId: 'company',
        excludeId: 'sales',
      }),
    ).not.toThrow();
    expect(
      ruleError(() =>
        assertTitleAvailable(departments, {
          title: '人事部',
          parentId: 'company',
          excludeId: 'sales',
        }),
      ).code,
    ).toBe('duplicate-title');
  });
});

describe('R-012 一个用户的主部门至多一个', () => {
  test('每个用户至多一个主部门时通过', () => {
    expect(() =>
      assertPrimaryInvariant([
        membership('m-1', 'company', 'u-1', true),
        membership('m-2', 'sales', 'u-1'),
        membership('m-3', 'hr', 'u-2', true),
      ]),
    ).not.toThrow();
    expect(() => assertPrimaryInvariant([])).not.toThrow();
  });

  test('同一用户两个主部门要被拒绝', () => {
    expect(
      ruleError(() =>
        assertPrimaryInvariant([
          membership('m-1', 'company', 'u-1', true),
          membership('m-2', 'sales', 'u-1', true),
        ]),
      ).code,
    ).toBe('multiple-primary-departments');
  });
});

describe('R-012 停用的部门一定是空的', () => {
  test('没有成员也没有未停用子部门时可以停用', () => {
    expect(() => assertDeactivatable(departments, [], 'hr')).not.toThrow();
    // 只有停用的子部门也算空。
    expect(() => assertDeactivatable(departments, [], 'closed')).not.toThrow();
  });

  test('还有成员时停用要被拒绝', () => {
    expect(
      ruleError(() =>
        assertDeactivatable(
          departments,
          [membership('m-1', 'hr', 'u-1')],
          'hr',
        ),
      ).code,
    ).toBe('department-has-members');
  });

  test('还有未停用子部门时停用要被拒绝', () => {
    expect(
      ruleError(() => assertDeactivatable(departments, [], 'sales')).code,
    ).toBe('department-has-active-children');
  });
});

describe('R-012 负责人必须是本部门成员', () => {
  test('负责人是本部门成员时通过', () => {
    expect(() =>
      assertManagerIsMember(
        [membership('m-1', 'sales', 'u-manager')],
        'sales',
        'u-manager',
      ),
    ).not.toThrow();
    expect(() => assertManagerIsMember([], 'sales', null)).not.toThrow();
  });

  test('负责人不是本部门成员时要被拒绝', () => {
    expect(
      ruleError(() =>
        assertManagerIsMember(
          [membership('m-1', 'sales-east', 'u-manager')],
          'sales',
          'u-manager',
        ),
      ).code,
    ).toBe('manager-not-member');
  });
});

describe('R-012 移出成员', () => {
  const sales = departments[1];

  test('普通成员可以移出', () => {
    expect(() =>
      assertMemberRemovable(sales, 'u-1', [
        membership('m-1', 'sales', 'u-1'),
        membership('m-2', 'hr', 'u-1'),
      ]),
    ).not.toThrow();
  });

  test('负责人不能移出', () => {
    expect(
      ruleError(() =>
        assertMemberRemovable(sales, 'u-manager', [
          membership('m-1', 'sales', 'u-manager'),
        ]),
      ).code,
    ).toBe('manager-cannot-be-removed');
  });

  test('要移出的是主部门而这个人还有别的部门时，拒绝', () => {
    expect(
      ruleError(() =>
        assertMemberRemovable(sales, 'u-1', [
          membership('m-1', 'sales', 'u-1', true),
          membership('m-2', 'hr', 'u-1'),
        ]),
      ).code,
    ).toBe('primary-department-in-use');
  });

  test('主部门是这个人在的唯一部门时，可以移出', () => {
    expect(() =>
      assertMemberRemovable(sales, 'u-1', [
        membership('m-1', 'sales', 'u-1', true),
      ]),
    ).not.toThrow();
  });

  test('移出的不是主部门时，即使还有别的部门也可以', () => {
    expect(() =>
      assertMemberRemovable(sales, 'u-1', [
        membership('m-1', 'sales', 'u-1'),
        membership('m-2', 'hr', 'u-1', true),
      ]),
    ).not.toThrow();
  });
});

describe('R-012 验收11：类型必须在四种之内', () => {
  test('四种类型都通过', () => {
    for (const kind of DEPARTMENT_KINDS) {
      expect(() => assertKind(kind)).not.toThrow();
    }
  });

  test('拼错的类型要被拒绝', () => {
    expect(ruleError(() => assertKind('division')).code).toBe(
      'invalid-department-kind',
    );
  });
});

describe('R-012 验收11：编码在还没有继任者的部门之间唯一', () => {
  test('空闲的编码通过', () => {
    expect(() =>
      assertCodeAvailable(departments, { code: 'NEW' }),
    ).not.toThrow();
  });

  test('被在用部门占用的编码要被拒绝', () => {
    expect(
      ruleError(() =>
        assertCodeAvailable(departments, { code: 'sales' }),
      ).code,
    ).toBe('duplicate-code');
  });

  test('已撤销的部门不再占用编码', () => {
    const revoked: readonly Department[] = [
      { ...departments[1], id: 'revoked', code: 'REUSE', successorId: 'sales' },
    ];
    expect(() =>
      assertCodeAvailable(revoked, { code: 'REUSE' }),
    ).not.toThrow();
  });

  test('改自己的编码时排除自己', () => {
    expect(() =>
      assertCodeAvailable(departments, { code: 'sales', excludeId: 'sales' }),
    ).not.toThrow();
  });
});

describe('R-012 验收6：停用部门的成员与上级', () => {
  test('往未停用的部门加成员通过', () => {
    expect(() => assertDepartmentActive(departments, 'sales')).not.toThrow();
  });

  test('往停用的部门加成员要被拒绝', () => {
    expect(ruleError(() => assertDepartmentActive(departments, 'closed')).code).toBe(
      'department-deactivated',
    );
  });

  test('挂到未停用的上级下通过', () => {
    expect(() => assertParentActive(departments, 'sales')).not.toThrow();
    expect(() => assertParentActive(departments, null)).not.toThrow();
  });

  test('挂到停用的上级下要被拒绝', () => {
    expect(ruleError(() => assertParentActive(departments, 'closed')).code).toBe(
      'parent-deactivated',
    );
  });

  test('继任者未停用时通过', () => {
    expect(() =>
      assertSuccessorActive(departments, 'closed', 'sales'),
    ).not.toThrow();
    expect(() =>
      assertSuccessorActive(departments, 'sales', null),
    ).not.toThrow();
  });

  test('继任者已停用、不存在或就是自己时被拒', () => {
    expect(
      ruleError(() => assertSuccessorActive(departments, 'sales', 'closed')).code,
    ).toBe('successor-deactivated');
    expect(
      ruleError(() => assertSuccessorActive(departments, 'sales', 'missing'))
        .code,
    ).toBe('successor-deactivated');
    expect(
      ruleError(() => assertSuccessorActive(departments, 'sales', 'sales')).code,
    ).toBe('successor-deactivated');
  });
});

describe('R-012 验收12：合并的预检', () => {
  test('源部门没有未停用子部门时可以合并', () => {
    expect(() => assertMergeable(departments, 'sales-east', 'hr')).not.toThrow();
  });

  test('目标是源部门自己时被拒', () => {
    expect(ruleError(() => assertMergeable(departments, 'sales', 'sales')).code).toBe(
      'merge-target-self',
    );
  });

  test('目标已停用或不存在时被拒', () => {
    expect(
      ruleError(() => assertMergeable(departments, 'sales-east', 'closed')).code,
    ).toBe('merge-target-deactivated');
    expect(
      ruleError(() => assertMergeable(departments, 'sales-east', 'missing')).code,
    ).toBe('merge-target-not-found');
  });

  test('源部门已停用时被拒', () => {
    expect(
      ruleError(() => assertMergeable(departments, 'closed', 'sales')).code,
    ).toBe('merge-source-deactivated');
  });

  test('源部门还有未停用的子部门时被拒', () => {
    expect(ruleError(() => assertMergeable(departments, 'sales', 'hr')).code).toBe(
      'merge-source-has-active-children',
    );
  });
});

describe('R-012 验收13：批量调动的预检', () => {
  const memberships: readonly DepartmentMembership[] = [
    membership('m-1', 'sales', 'u-1'),
    membership('m-2', 'sales-east', 'u-2'),
    membership('m-3', 'sales', 'u-manager'),
  ];

  test('全员在源部门且不含负责人时通过', () => {
    expect(() =>
      assertTransferable(departments, memberships, {
        userIds: ['u-1'],
        fromDepartmentId: 'sales',
        toDepartmentId: 'sales-east',
      }),
    ).not.toThrow();
  });

  test('有人不在源部门时整批被拒', () => {
    expect(
      ruleError(() =>
        assertTransferable(departments, memberships, {
          userIds: ['u-1', 'u-2'],
          fromDepartmentId: 'sales',
          toDepartmentId: 'hr',
        }),
      ).code,
    ).toBe('transfer-user-not-member');
  });

  test('这批人包含源部门的负责人时整批被拒', () => {
    expect(
      ruleError(() =>
        assertTransferable(departments, memberships, {
          userIds: ['u-manager'],
          fromDepartmentId: 'sales',
          toDepartmentId: 'hr',
        }),
      ).code,
    ).toBe('transfer-includes-manager');
  });

  test('目标是停用的部门时被拒', () => {
    expect(
      ruleError(() =>
        assertTransferable(departments, memberships, {
          userIds: ['u-1'],
          fromDepartmentId: 'sales',
          toDepartmentId: 'closed',
        }),
      ).code,
    ).toBe('department-deactivated');
  });
});
