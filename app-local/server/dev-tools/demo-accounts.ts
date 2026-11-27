import type { DatabaseConnection } from '@nocobase/db';

/**
 * R-037 演示账户的清单。
 *
 * 一个业务角色一个账户。清单写在代码里，由开发工具在启动时建出来；关着的时候库里没有它们，
 * 正式环境永远不会出现。以后每加一个业务角色，在这张清单里加一行。
 *
 * `role` 是 seed 建好的权限集 key（`database/main/seeds/202611240001_seed_business_permission_sets.ts`）；
 * 客户端按词条 `permissionSets.business.*` 把它翻成角色名。
 */
export interface DemoAccountDefinition {
  readonly username: string;
  readonly name: string;
  readonly role: string;
}

export const DEMO_ACCOUNTS: readonly DemoAccountDefinition[] = [
  {
    username: 'demo.quality_manager',
    name: '演示 · 质量主管',
    role: 'quality_manager',
  },
  {
    username: 'demo.quality_inspector',
    name: '演示 · 质量员',
    role: 'quality_inspector',
  },
  {
    username: 'demo.dept_manager',
    name: '演示 · 部门主管',
    role: 'dept_manager',
  },
  {
    username: 'demo.staff',
    name: '演示 · 普通员工',
    role: 'staff',
  },
  {
    username: 'demo.warehouse',
    name: '演示 · 仓管',
    role: 'warehouse',
  },
  {
    username: 'demo.purchase',
    name: '演示 · 采购',
    role: 'purchase',
  },
  {
    username: 'demo.sales',
    name: '演示 · 销售',
    role: 'sales',
  },
];

/** 接口出参：标识、姓名、用户名、角色名。不外带邮箱等人员信息（R-028）。 */
export interface DevAccount {
  readonly id: string;
  readonly name: string;
  readonly username: string;
  readonly role: string;
}

/**
 * 演示账户的地址。`.invalid` 是 RFC 2606 的保留域名，永远不指向一个能收信的地方。
 * 这些账户不能靠密码登录，地址也不用于登录或找回密码。
 */
export function demoAccountEmail(username: string): string {
  return `${username}@demo.invalid`;
}

interface UserRow {
  readonly id: unknown;
  readonly name: unknown;
  readonly username: unknown;
}

/**
 * 清单里存在、启用、未删的账户，按清单顺序。
 *
 * 停用或删掉的账户不列出来：列出来也切不进去，那比不显示更糟。切换接口用同一份列表
 * 判定「目标必须在清单里」，两处不会给出不同的答案。
 */
export async function readDemoAccounts(
  connection: DatabaseConnection,
): Promise<readonly DevAccount[]> {
  const rows = (await connection.query
    .selectFrom('user')
    .select(['id', 'name', 'username'])
    .where(
      'username',
      'in',
      DEMO_ACCOUNTS.map((account) => account.username),
    )
    .where('deletedAt', 'is', null)
    .where('disabledAt', 'is', null)
    .execute()) as readonly UserRow[];
  const byUsername = new Map(rows.map((row) => [String(row.username), row]));

  return DEMO_ACCOUNTS.flatMap((definition) => {
    const row = byUsername.get(definition.username);
    if (!row) {
      return [];
    }
    return [
      {
        id: String(row.id),
        name: String(row.name),
        username: definition.username,
        role: definition.role,
      },
    ];
  });
}
