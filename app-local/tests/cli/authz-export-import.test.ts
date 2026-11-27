// @vitest-environment node
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { bindAppCommand, runAppCommand } from '@nocobase/app-testing/cli';
import { expect, test, vi } from 'vitest';

import AuthzExport from '../../cli/authz/export.js';
import AuthzImport from '../../cli/authz/import.js';
import AuthzUpgradeR002 from '../../cli/authz/upgrade-r002.js';
import AuthzUpgradeR014 from '../../cli/authz/upgrade-r014.js';
import AuthzUpgradeR020 from '../../cli/authz/upgrade-r020.js';
import AuthzUpgradeR021 from '../../cli/authz/upgrade-r021.js';
import AuthzUpgradeR025 from '../../cli/authz/upgrade-r025.js';
import AuthzUpgradeR026 from '../../cli/authz/upgrade-r026.js';
import cliPlugins from '../../cli/plugins.js';
import {
  appRoot,
  authorization,
  configuredAccess,
  createUser,
  effectivePermissionSets,
  minimalDocument,
  openEnvironment,
  runCommand,
  snapshot,
  temporaryDirectory,
  TEST_TIMEOUT,
} from '../helpers/authz-transfer.js';

test('R-013: the authz commands are registered under their own topic', () => {
  const plugin = cliPlugins.plugins.find((entry) => entry.topic === 'authz');
  expect(plugin).toBeDefined();
  expect(Object.keys(plugin!.commands).sort()).toEqual([
    'export',
    'import',
    'upgrade-r002',
    'upgrade-r003',
    'upgrade-r014',
    'upgrade-r020',
    'upgrade-r021',
    'upgrade-r025',
    'upgrade-r026',
  ]);
  expect(plugin!.commands.export).toBe(AuthzExport);
  expect(plugin!.commands.import).toBe(AuthzImport);
  // R-002 的升级步骤：合并之后在已有环境里跑一次，只补两个质量角色的确认记录范围。
  expect(plugin!.commands['upgrade-r002']).toBe(AuthzUpgradeR002);
  expect(AuthzUpgradeR002.description).toContain('fqcScreeningReviews');
  // R-026 的升级步骤：合并之后在已有环境里跑一次，补三个角色的反馈单页与两个新动作。
  expect(plugin!.commands['upgrade-r026']).toBe(AuthzUpgradeR026);
  expect(AuthzUpgradeR026.description).toContain('feedback page');
  // R-025 的升级步骤：给已有环境的 staff 补班次只读授权，可单独跑、可重跑。
  expect(plugin!.commands['upgrade-r025']).toBe(AuthzUpgradeR025);
  expect(AuthzUpgradeR025.description).toContain('shifts.view');
  // R-020 的升级步骤：给已有环境的 warehouse 补库存授权，可单独跑、可重跑。
  expect(plugin!.commands['upgrade-r014']).toBe(AuthzUpgradeR014);
  expect(plugin!.commands['upgrade-r020']).toBe(AuthzUpgradeR020);
  expect(AuthzUpgradeR020.description).toContain('inventory');
  // R-021/R-022 的升级步骤：给采购/销售补订单授权与只读引用，可单独跑、可重跑。
  expect(plugin!.commands['upgrade-r021']).toBe(AuthzUpgradeR021);
  expect(AuthzUpgradeR021.description).toContain('purchaseOrders');
  expect(AuthzUpgradeR021.description).toContain('salesOrders');
  // R-014 的升级步骤：给销售/采购补客户/供应商授权。
  expect(AuthzUpgradeR014.description).toContain('customers');
});

test('R-013: the import help explains how to unblock rules that exchange resources', () => {
  // 已知限制：两条默认访问规则互相换资源时写入会撞上旧占用。成环没有安全的顺序，
  // 把文件拆成两份也不行（每份的目标仍被库里另一条占着，计划阶段就拒）；成链要按链尾到链头写。
  // 帮助文字是操作者唯一能提前看到这条限制的地方。
  expect(AuthzImport.description).toContain(
    'Delete or move one of the old rules first',
  );
});

test('R-013: a file with an unknown format version is refused before the application starts', async () => {
  const directory = await temporaryDirectory();
  try {
    const file = path.join(directory, 'from-the-future.json');
    await writeFile(
      file,
      `${JSON.stringify(minimalDocument({ format: 2 }), null, 2)}\n`,
    );
    const Bound = bindAppCommand(AuthzImport, {
      rootDir: appRoot,
      id: 'authz:import',
      loadRuntime: async () => {
        throw new Error('the file must be refused before a runtime is loaded');
      },
      createApp: () => {
        throw new Error(
          'the file must be refused before an application exists',
        );
      },
    });
    const imported = await runAppCommand(Bound, ['--file', file, '--json']);

    expect(imported.exitCode).toBe(1);
    expect(imported.json().error?.code).toBe('IMPORT_VALIDATION_FAILED');
    const problems = (imported.json().error?.details as { problems?: string[] })
      .problems;
    expect(problems!.some((problem) => problem.includes('format 2'))).toBe(
      true,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  'R-013: exporting in one environment and importing into another keeps the same effective access',
  { timeout: TEST_TIMEOUT },
  async () => {
    const directory = await temporaryDirectory();
    const source = await openEnvironment();
    const target = await openEnvironment();
    try {
      const sourceUserId = await createUser(source, 'roundtrip');
      await authorization(source).permissionSets.assign({
        subject: { type: 'user', id: sourceUserId },
        permissionSet: 'quality_inspector',
      });
      const sourceAccess = await configuredAccess(source, sourceUserId);
      const sourceEffective = await effectivePermissionSets(
        source,
        sourceUserId,
      );

      const file = path.join(directory, 'authorization.json');
      const exported = await runCommand(AuthzExport, source, 'authz:export', [
        '--out',
        file,
        '--json',
      ]);
      expect(exported.error).toBeUndefined();
      expect(exported.exitCode ?? 0).toBe(0);
      expect(exported.json().ok).toBe(true);

      const targetUserId = await createUser(target, 'roundtrip');
      // 目标环境里这个用户按默认只持有 member 与 R-026 的基线 staff：导入之前没有质量员的授权。
      expect(
        (await effectivePermissionSets(target, targetUserId)).map(
          (set) => set.key,
        ),
      ).toEqual(['member', 'staff']);

      const imported = await runCommand(AuthzImport, target, 'authz:import', [
        '--file',
        file,
        '--json',
      ]);
      expect(imported.error).toBeUndefined();
      expect(imported.exitCode ?? 0).toBe(0);
      expect(imported.json().ok).toBe(true);

      expect(await effectivePermissionSets(target, targetUserId)).toEqual(
        sourceEffective,
      );
      expect(await configuredAccess(target, targetUserId)).toEqual(
        sourceAccess,
      );
    } finally {
      await source.close();
      await target.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'R-013: a rule covering every resource of a type (id "*") survives export and import',
  { timeout: TEST_TIMEOUT },
  async () => {
    const directory = await temporaryDirectory();
    const source = await openEnvironment();
    const target = await openEnvironment();
    try {
      const sourceUserId = await createUser(source, 'wildcardowner');
      await authorization(source).sharingRules.create({
        key: 'share-any-collection',
        resource: { type: 'database.collection', id: '*' },
        actions: [
          {
            action: 'read',
            selection: { type: 'records', ids: ['ticket-1'] },
          },
        ],
        subjects: [{ type: 'user', id: sourceUserId }],
      });

      const file = path.join(directory, 'authorization.json');
      const exported = await runCommand(AuthzExport, source, 'authz:export', [
        '--out',
        file,
        '--json',
      ]);
      expect(exported.error).toBeUndefined();
      expect(exported.exitCode ?? 0).toBe(0);
      const document = JSON.parse(await readFile(file, 'utf8'));
      const exportedRule = document.rules.sharing.find(
        (rule: { key: string }) => rule.key === 'share-any-collection',
      );
      expect(exportedRule).toBeDefined();
      expect(exportedRule.resource).toEqual({
        type: 'database.collection',
        id: '*',
      });

      const targetUserId = await createUser(target, 'wildcardowner');
      const imported = await runCommand(AuthzImport, target, 'authz:import', [
        '--file',
        file,
        '--json',
      ]);
      expect(imported.error).toBeUndefined();
      expect(imported.exitCode ?? 0).toBe(0);
      const stored = await authorization(target).sharingRules.list();
      const rule = stored.find((entry) => entry.key === 'share-any-collection');
      expect(rule).toBeDefined();
      // 通配资源在服务层里就是「这一类里的任意一项」，导入的校验不能按具体 id 查。
      expect(rule?.resource).toEqual({
        type: 'database.collection',
        id: '*',
      });
      expect(rule?.subjects).toEqual([{ type: 'user', id: targetUserId }]);
    } finally {
      await source.close();
      await target.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'R-013: a rule covering every composite resource (id "*") survives export and import',
  { timeout: TEST_TIMEOUT },
  async () => {
    const directory = await temporaryDirectory();
    const source = await openEnvironment();
    const target = await openEnvironment();
    try {
      // 服务层对规则资源不查复合的定义：`id: "*"` 在规则约束里命中任意复合资源。
      // 动作要带真实的 `scopeKey`：运行时约束按复合授权的分支范围解析（`fqc.view` 的
      // 分支是 fqcMessages / fqcScreenings / fqcTickets），没有 scopeKey 的规则一个分支都命中不了。
      await authorization(source).sharingRules.create({
        key: 'share-any-composite',
        resource: { type: 'composite', id: '*' },
        actions: [
          {
            action: 'view',
            scopeKey: 'fqcTickets',
            selection: { type: 'records', ids: ['ticket-1'] },
          },
        ],
        subjects: [{ type: 'authenticated', id: '*' }],
      });

      const file = path.join(directory, 'authorization.json');
      const exported = await runCommand(AuthzExport, source, 'authz:export', [
        '--out',
        file,
        '--json',
      ]);
      expect(exported.error).toBeUndefined();
      expect(exported.exitCode ?? 0).toBe(0);
      const document = JSON.parse(await readFile(file, 'utf8'));
      const exportedRule = document.rules.sharing.find(
        (rule: { key: string }) => rule.key === 'share-any-composite',
      );
      expect(exportedRule).toBeDefined();
      expect(exportedRule.resource).toEqual({
        type: 'composite',
        id: '*',
      });
      expect(exportedRule.actions[0].scopeKey).toBe('fqcTickets');

      const imported = await runCommand(AuthzImport, target, 'authz:import', [
        '--file',
        file,
        '--json',
      ]);
      expect(imported.error).toBeUndefined();
      expect(imported.exitCode ?? 0).toBe(0);
      const stored = await authorization(target).sharingRules.list();
      const rule = stored.find((entry) => entry.key === 'share-any-composite');
      expect(rule).toBeDefined();
      // 设计写的是「规则资源可以是通配」，没有给复合资源开例外：导入不能把它判成未注册。
      expect(rule?.resource).toEqual({ type: 'composite', id: '*' });
      expect(rule?.subjects).toEqual([{ type: 'authenticated', id: '*' }]);
      expect(rule?.actions[0]?.scopeKey).toBe('fqcTickets');

      // 通配要真的覆盖「任意一项」：按运行时查询的形状解析约束 ——
      // 资源是具体的复合资源、`scopeKey` 是它的一个分支范围，这条规则要命中。
      const resolved = await authorization(target).constraints.resolve({
        principal: { type: 'authenticated', id: '*' },
        resource: { type: 'composite', id: 'fqc' },
        action: 'view',
        scopeKey: 'fqcTickets',
      });
      expect(
        resolved.some(
          (constraint) => constraint.source.id === 'share-any-composite',
        ),
      ).toBe(true);
      // 换一个分支范围就不该命中：否则「按 scopeKey 绑定一张表」无从谈起。
      const otherScope = await authorization(target).constraints.resolve({
        principal: { type: 'authenticated', id: '*' },
        resource: { type: 'composite', id: 'fqc' },
        action: 'view',
        scopeKey: 'fqcMessages',
      });
      expect(
        otherScope.some(
          (constraint) => constraint.source.id === 'share-any-composite',
        ),
      ).toBe(false);
    } finally {
      await source.close();
      await target.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'R-013: a file with an unknown username and an unregistered resource writes nothing',
  { timeout: TEST_TIMEOUT },
  async () => {
    const directory = await temporaryDirectory();
    const env = await openEnvironment();
    try {
      await createUser(env, 'unchanged');
      const before = await snapshot(env);

      const file = path.join(directory, 'broken.json');
      await writeFile(
        file,
        `${JSON.stringify(
          minimalDocument({
            permissionSets: [
              {
                key: 'broken_role',
                revision: 'from-another-environment',
                grants: [
                  {
                    resource: { type: 'composite', id: 'phantom' },
                    actions: [{ action: 'view' }],
                  },
                ],
              },
            ],
            assignments: [
              {
                subject: { type: 'user', username: 'nobody-here' },
                permissionSet: 'quality_inspector',
              },
            ],
          }),
          null,
          2,
        )}\n`,
      );

      const imported = await runCommand(AuthzImport, env, 'authz:import', [
        '--file',
        file,
        '--json',
      ]);

      expect(imported.exitCode).toBe(1);
      const document = imported.json();
      expect(document.ok).toBe(false);
      expect(document.error?.code).toBe('IMPORT_VALIDATION_FAILED');
      const problems = (document.error?.details as { problems?: string[] })
        .problems;
      expect(problems).toBeDefined();
      expect(problems!.some((problem) => problem.includes('nobody-here'))).toBe(
        true,
      );
      expect(problems!.some((problem) => problem.includes('phantom'))).toBe(
        true,
      );

      expect(await snapshot(env)).toEqual(before);
    } finally {
      await env.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'R-013: importing the same file twice leaves the same result as importing it once',
  { timeout: TEST_TIMEOUT },
  async () => {
    const directory = await temporaryDirectory();
    const env = await openEnvironment();
    try {
      const userId = await createUser(env, 'repeat');
      await authorization(env).permissionSets.assign({
        subject: { type: 'user', id: userId },
        permissionSet: 'quality_manager',
      });

      const file = path.join(directory, 'authorization.json');
      const exported = await runCommand(AuthzExport, env, 'authz:export', [
        '--out',
        file,
        '--json',
      ]);
      expect(exported.exitCode ?? 0).toBe(0);

      // 把库改回导入之前的样子：授权被清空，赋权被取掉。
      const sets = authorization(env).permissionSets;
      const qualityManager = await sets.get('quality_manager');
      expect(qualityManager).toBeDefined();
      await sets.update(
        'quality_manager',
        {
          key: 'quality_manager',
          title: qualityManager!.title,
          grants: [],
        },
        qualityManager!.revision,
      );
      const assignment = (await sets.listAssignments()).find(
        (entry) =>
          entry.subject.type === 'user' &&
          entry.subject.id === userId &&
          entry.permissionSet === 'quality_manager',
      );
      expect(assignment).toBeDefined();
      await sets.revoke(assignment!.id);

      const first = await runCommand(AuthzImport, env, 'authz:import', [
        '--file',
        file,
        '--json',
      ]);
      expect(first.exitCode ?? 0).toBe(0);
      const afterFirst = await snapshot(env);

      const second = await runCommand(AuthzImport, env, 'authz:import', [
        '--file',
        file,
        '--json',
      ]);
      expect(second.exitCode ?? 0).toBe(0);
      expect(await snapshot(env)).toEqual(afterFirst);

      const restored = (await sets.listAssignments()).filter(
        (entry) =>
          entry.subject.type === 'user' &&
          entry.subject.id === userId &&
          entry.permissionSet === 'quality_manager',
      );
      expect(restored).toHaveLength(1);
    } finally {
      await env.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'R-013: a permission set the target does not have yet is created and assigned',
  { timeout: TEST_TIMEOUT },
  async () => {
    const directory = await temporaryDirectory();
    const env = await openEnvironment();
    try {
      const userId = await createUser(env, 'imported');
      const title = {
        key: 'permissionSets.imported',
        ns: 'app-local',
      };
      const grants = [
        {
          resource: { type: 'page', id: 'quality' },
          actions: [{ action: 'access' }],
        },
      ];
      const file = path.join(directory, 'new-role.json');
      await writeFile(
        file,
        `${JSON.stringify(
          minimalDocument({
            permissionSets: [
              {
                key: 'imported_role',
                revision: 'from-elsewhere',
                title,
                grants,
              },
            ],
            assignments: [
              {
                subject: { type: 'user', username: 'imported' },
                permissionSet: 'imported_role',
              },
            ],
          }),
          null,
          2,
        )}\n`,
      );

      const imported = await runCommand(AuthzImport, env, 'authz:import', [
        '--file',
        file,
        '--json',
      ]);
      expect(imported.error).toBeUndefined();
      expect(imported.exitCode ?? 0).toBe(0);

      const sets = authorization(env).permissionSets;
      const created = await sets.get('imported_role');
      expect(created).toMatchObject({ key: 'imported_role', title, grants });
      expect(
        (await sets.listAssignments()).some(
          (entry) =>
            entry.subject.type === 'user' &&
            entry.subject.id === userId &&
            entry.permissionSet === 'imported_role',
        ),
      ).toBe(true);
    } finally {
      await env.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'R-013: the export file uses usernames, carries revisions and always holds all four parts',
  { timeout: TEST_TIMEOUT },
  async () => {
    const directory = await temporaryDirectory();
    const env = await openEnvironment();
    try {
      const userId = await createUser(env, 'tester');
      await authorization(env).permissionSets.assign({
        subject: { type: 'user', id: userId },
        permissionSet: 'dept_manager',
      });

      const file = path.join(directory, 'authorization.json');
      const exported = await runCommand(AuthzExport, env, 'authz:export', [
        '--out',
        file,
      ]);
      expect(exported.error).toBeUndefined();
      expect(exported.exitCode ?? 0).toBe(0);

      const text = await readFile(file, 'utf8');
      const document = JSON.parse(text);
      expect(document.format).toBe(1);
      expect(Number.isNaN(Date.parse(document.exportedAt))).toBe(false);

      expect(
        document.permissionSets.map((set: { key: string }) => set.key),
      ).toEqual([
        'dept_manager',
        'member',
        'purchase',
        'quality_inspector',
        'quality_manager',
        'root',
        'sales',
        'staff',
        'warehouse',
      ]);
      for (const set of document.permissionSets) {
        expect(typeof set.revision).toBe('string');
        expect(set.revision.length).toBeGreaterThan(0);
      }

      expect(document.assignments).toContainEqual({
        subject: { type: 'user', username: 'tester' },
        permissionSet: 'dept_manager',
      });
      expect(text.includes(userId)).toBe(false);

      expect(Array.isArray(document.rules.defaultAccess)).toBe(true);
      expect(Array.isArray(document.rules.sharing)).toBe(true);
      expect(Array.isArray(document.rules.restriction)).toBe(true);
      expect(document.rules).toEqual({
        defaultAccess: [],
        sharing: [],
        restriction: [],
      });

      const protectedKeys = document.protected.map(
        (entry: { key: string }) => entry.key,
      );
      expect(protectedKeys).toContain('root');
      expect(protectedKeys).toContain('member');
      expect(protectedKeys).not.toContain('staff');
      const root = document.protected.find(
        (entry: { key: string }) => entry.key === 'root',
      );
      expect(root.protection.unrestricted).toBe(true);

      expect(exported.stdout).toContain(
        `Exported ${document.permissionSets.length} permission sets`,
      );
      expect(exported.stdout).toContain(file);
    } finally {
      await env.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'R-013: a write that fails halfway lists what was written and what was not',
  { timeout: TEST_TIMEOUT },
  async () => {
    const directory = await temporaryDirectory();
    const env = await openEnvironment();
    try {
      await createUser(env, 'firsttarget');
      await createUser(env, 'secondtarget');
      await createUser(env, 'thirdtarget');
      const sets = authorization(env).permissionSets;

      const file = path.join(directory, 'three-assignments.json');
      await writeFile(
        file,
        `${JSON.stringify(
          minimalDocument({
            assignments: [
              {
                subject: { type: 'user', username: 'firsttarget' },
                permissionSet: 'quality_inspector',
              },
              {
                subject: { type: 'user', username: 'secondtarget' },
                permissionSet: 'dept_manager',
              },
              {
                subject: { type: 'user', username: 'thirdtarget' },
                permissionSet: 'quality_manager',
              },
            ],
          }),
          null,
          2,
        )}\n`,
      );

      const originalAssign = sets.assign.bind(sets);
      let calls = 0;
      vi.spyOn(sets, 'assign').mockImplementation(async (input) => {
        calls += 1;
        if (calls === 2) {
          throw new Error('injected write failure');
        }
        return originalAssign(input);
      });

      const imported = await runCommand(AuthzImport, env, 'authz:import', [
        '--file',
        file,
        '--json',
      ]);
      vi.restoreAllMocks();

      expect(imported.exitCode).toBe(1);
      const document = imported.json();
      expect(document.ok).toBe(false);
      expect(document.error?.code).toBe('IMPORT_WRITE_FAILED');
      const details = document.error?.details as {
        written?: string[];
        failed?: string[];
        notWritten?: string[];
      };
      expect(
        details.written!.some((entry) => entry.includes('firsttarget')),
      ).toBe(true);
      expect(
        details.failed!.some((entry) => entry.includes('secondtarget')),
      ).toBe(true);
      expect(
        details.notWritten!.some((entry) => entry.includes('secondtarget')),
      ).toBe(false);
      // 失败项后面还有一条没写：它必须出现在 notWritten 里，而不是被漏掉。
      expect(details.notWritten).toHaveLength(1);
      expect(
        details.notWritten!.some((entry) => entry.includes('thirdtarget')),
      ).toBe(true);

      const assignments = await sets.listAssignments();
      expect(
        assignments.some(
          (entry) =>
            entry.subject.type === 'user' &&
            entry.permissionSet === 'quality_inspector',
        ),
      ).toBe(true);
      expect(
        assignments.some((entry) => entry.permissionSet === 'dept_manager'),
      ).toBe(false);
      expect(
        assignments.some((entry) => entry.permissionSet === 'quality_manager'),
      ).toBe(false);
    } finally {
      vi.restoreAllMocks();
      await env.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
