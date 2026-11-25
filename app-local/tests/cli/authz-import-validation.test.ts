// @vitest-environment node
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { userAdministrationServiceToken } from '@nocobase/app-plugin-authentication';
import { databaseManagerToken } from '@nocobase/db';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import AuthzExport from '../../cli/authz/export.js';
import AuthzImport from '../../cli/authz/import.js';
import {
  authorization,
  createUser,
  minimalDocument,
  openEnvironment,
  runCommand,
  snapshot,
  temporaryDirectory,
  TEST_TIMEOUT,
  type Environment,
} from '../helpers/authz-transfer.js';

/**
 * R-013 查错复查（PR #21）指出的两类问题：
 * ① 规则文件里「读文件就能发现」的问题必须在写入前全部列出，一行都不写；
 * ② 跨环境的主体映射必须覆盖服务账号与规则里的 user 主体，未声明的主体类型不许照写。
 *
 * 每个「坏文件」用例都断言导入前后库快照逐行相等（含版本号）。共享一个已经起好的环境，
 * 用例全部零写入，所以基线在 beforeAll 里取一次即可；最后一个删除用户的用例会写库，
 * 放在最后。
 */

interface ProblemCase {
  name: string;
  file: Record<string, unknown>;
  expected: string;
}

const existingDefaultRule = {
  key: 'existing-default',
  resource: { type: 'database.collection', id: 'fqcTickets' },
  actions: [{ action: 'read', selection: { type: 'all' } }],
};

const emptyRules = { defaultAccess: [], sharing: [], restriction: [] };

describe('R-013: rule and subject file problems are found before any write', () => {
  let env: Environment;
  let baseline: Awaited<ReturnType<typeof snapshot>>;

  beforeAll(async () => {
    env = await openEnvironment();
    // 一条库里已有的默认访问规则，用来验证「文件与库内规则冲突」也在计划阶段拦下。
    await authorization(env).defaultAccess.create(existingDefaultRule);
    baseline = await snapshot(env);
  }, TEST_TIMEOUT);

  afterAll(async () => {
    await env.close();
  }, TEST_TIMEOUT);

  const cases: ProblemCase[] = [
    {
      name: 'an invalid record selection is a file problem',
      file: {
        rules: {
          ...emptyRules,
          defaultAccess: [
            {
              key: 'bad-selection',
              resource: { type: 'page', id: 'quality' },
              actions: [{ action: 'access', selection: { type: 'bogus' } }],
            },
          ],
        },
      },
      expected: 'invalid selection',
    },
    {
      name: 'an action that is not an object is a file problem',
      file: {
        rules: {
          ...emptyRules,
          defaultAccess: [
            {
              key: 'null-action',
              resource: { type: 'page', id: 'quality' },
              actions: [null],
            },
          ],
        },
      },
      expected: 'actions[0]',
    },
    {
      name: 'a repeated action is a file problem',
      file: {
        rules: {
          ...emptyRules,
          defaultAccess: [
            {
              key: 'repeated-action',
              resource: { type: 'page', id: 'quality' },
              actions: [
                { action: 'access', selection: { type: 'all' } },
                { action: 'access', selection: { type: 'all' } },
              ],
            },
          ],
        },
      },
      expected: 'repeats action "access"',
    },
    {
      name: 'a sharing rule without subjects is a file problem',
      file: {
        rules: {
          ...emptyRules,
          sharing: [
            {
              key: 'no-subjects',
              resource: { type: 'database.collection', id: 'fqcTickets' },
              actions: [
                {
                  action: 'read',
                  selection: { type: 'records', ids: ['ticket-1'] },
                },
              ],
            },
          ],
        },
      },
      expected: 'needs a "subjects" array',
    },
    {
      name: 'a sharing rule with a malformed subject is a file problem',
      file: {
        rules: {
          ...emptyRules,
          sharing: [
            {
              key: 'bad-subject',
              resource: { type: 'database.collection', id: 'fqcTickets' },
              actions: [
                {
                  action: 'read',
                  selection: { type: 'records', ids: ['ticket-1'] },
                },
              ],
              subjects: [{ type: 'user' }],
            },
          ],
        },
      },
      expected: 'needs a "username"',
    },
    {
      name: 'two default-access rules for one resource in the file',
      file: {
        rules: {
          ...emptyRules,
          defaultAccess: [
            {
              key: 'file-a',
              resource: { type: 'database.collection', id: 'fqcMessages' },
              actions: [{ action: 'read', selection: { type: 'all' } }],
            },
            {
              key: 'file-b',
              resource: { type: 'database.collection', id: 'fqcMessages' },
              actions: [{ action: 'read', selection: { type: 'all' } }],
            },
          ],
        },
      },
      expected: 'two default-access rules',
    },
    {
      name: 'a default-access rule that collides with an existing one',
      file: {
        rules: {
          ...emptyRules,
          defaultAccess: [
            {
              key: 'file-c',
              resource: { type: 'database.collection', id: 'fqcTickets' },
              actions: [{ action: 'read', selection: { type: 'all' } }],
            },
          ],
        },
      },
      expected: 'already has a default-access rule',
    },
    {
      name: 'an undeclared subject type is a file problem',
      file: {
        assignments: [
          {
            subject: { type: 'ghost', id: 'nobody' },
            permissionSet: 'staff',
          },
        ],
      },
      expected: 'is not declared',
    },
    {
      name: 'an assignment the protected set forbids is a file problem',
      file: {
        assignments: [
          {
            subject: { type: 'authenticated', id: '*' },
            permissionSet: 'member',
          },
        ],
      },
      expected: 'may not be assigned to subject type "authenticated"',
    },
    {
      name: 'a protection marker that differs from the code',
      file: {
        permissionSets: [{ key: 'root', revision: 'x', grants: [] }],
        protected: [
          { key: 'root', protection: { owner: 'someone-else', allow: [] } },
        ],
      },
      expected: 'protection of "root" differs',
    },
    {
      name: 'a protected set whose marker the file omits',
      file: {
        permissionSets: [
          { key: 'root', revision: 'x', grants: [] },
          { key: 'member', revision: 'x', grants: [] },
        ],
        protected: [],
      },
      expected: 'does not record its protection',
    },
    {
      // 前面还有要新建的权限集与要授出的赋权：这条规则若不在计划阶段拦下，
      // 服务层要到写入时才拒绝（sharing 的 allowAll 是 false），那时前两条已经落库。
      name: 'a sharing rule that selects all records is a file problem',
      file: {
        permissionSets: [{ key: 'sharing_role', revision: 'x', grants: [] }],
        assignments: [
          {
            subject: { type: 'authenticated', id: '*' },
            permissionSet: 'sharing_role',
          },
        ],
        rules: {
          ...emptyRules,
          sharing: [
            {
              key: 'share-everything',
              resource: { type: 'database.collection', id: 'fqcTickets' },
              actions: [{ action: 'read', selection: { type: 'all' } }],
              subjects: [{ type: 'authenticated', id: '*' }],
            },
          ],
        },
      },
      expected: 'cannot select all records',
    },
  ];

  test.each(cases)(
    '$name',
    async ({ file, expected }) => {
      const directory = await temporaryDirectory();
      try {
        const target = path.join(directory, 'file.json');
        await writeFile(
          target,
          `${JSON.stringify(minimalDocument(file), null, 2)}\n`,
        );
        const imported = await runCommand(AuthzImport, env, 'authz:import', [
          '--file',
          target,
          '--json',
        ]);

        expect(imported.exitCode).toBe(1);
        const document = imported.json();
        expect(document.ok).toBe(false);
        expect(document.error?.code).toBe('IMPORT_VALIDATION_FAILED');
        const problems =
          (document.error?.details as { problems?: string[] }).problems ?? [];
        expect(
          problems.some((problem) => problem.includes(expected)),
          `problems do not mention "${expected}": ${problems.join(' | ')}`,
        ).toBe(true);
        expect(await snapshot(env)).toEqual(baseline);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT,
  );

  test(
    'R-013: the export error names the assignment left behind by a deleted user',
    { timeout: TEST_TIMEOUT },
    async () => {
      const userId = await createUser(env, 'deleteduser');
      await authorization(env).permissionSets.assign({
        subject: { type: 'user', id: userId },
        permissionSet: 'quality_inspector',
      });
      // 应用没有配置用户删除的处理链；测试直接做软删除，复现「赋权留下来」的状态。
      await env.app.container
        .resolve(databaseManagerToken)
        .connection()
        .query.updateTable('user')
        .set({ deletedAt: new Date() })
        .where('id', '=', userId)
        .execute();

      const directory = await temporaryDirectory();
      try {
        const file = path.join(directory, 'export.json');
        const exported = await runCommand(AuthzExport, env, 'authz:export', [
          '--out',
          file,
          '--json',
        ]);
        expect(exported.exitCode).toBe(1);
        const document = exported.json();
        expect(document.error?.code).toBe('EXPORT_INCOMPLETE');
        const problems =
          (document.error?.details as { problems?: string[] }).problems ?? [];
        expect(
          problems.some((problem) =>
            problem.includes(`user:${userId}:quality_inspector`),
          ),
          `problems do not name the assignment: ${problems.join(' | ')}`,
        ).toBe(true);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});

test(
  'R-013: a restriction rule may select all records',
  { timeout: TEST_TIMEOUT },
  async () => {
    const env = await openEnvironment();
    const directory = await temporaryDirectory();
    try {
      const file = path.join(directory, 'restriction-all.json');
      await writeFile(
        file,
        `${JSON.stringify(
          minimalDocument({
            rules: {
              ...emptyRules,
              restriction: [
                {
                  key: 'restrict-everything',
                  resource: { type: 'database.collection', id: 'fqcTickets' },
                  actions: [{ action: 'read', selection: { type: 'all' } }],
                  subjects: [{ type: 'authenticated', id: '*' }],
                },
              ],
            },
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
      const stored = await authorization(env).restrictionRules.list();
      const rule = stored.find(
        (entry) => entry.key === 'restrict-everything',
      );
      expect(rule).toBeDefined();
      // 限制规则与默认访问规则一样允许「选全部记录」，不能跟着共享规则一起被拦。
      expect(rule?.actions[0]?.selection).toEqual({ type: 'all' });
    } finally {
      await env.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'R-013: a default-access rule the file moves lets a new rule take over its old resource',
  { timeout: TEST_TIMEOUT },
  async () => {
    const env = await openEnvironment();
    const directory = await temporaryDirectory();
    try {
      await authorization(env).defaultAccess.create({
        key: 'zzz-moved',
        resource: { type: 'database.collection', id: 'fqcTickets' },
        actions: [{ action: 'read', selection: { type: 'all' } }],
      });

      // 终态：`zzz-moved` 在 fqcMessages，`aaa-takeover` 在 fqcTickets。
      // 文件里新规则排在前面，导入顺序不能影响这份合法文件的成败。
      const file = path.join(directory, 'moved.json');
      await writeFile(
        file,
        `${JSON.stringify(
          minimalDocument({
            rules: {
              ...emptyRules,
              defaultAccess: [
                {
                  key: 'aaa-takeover',
                  resource: { type: 'database.collection', id: 'fqcTickets' },
                  actions: [{ action: 'read', selection: { type: 'all' } }],
                },
                {
                  key: 'zzz-moved',
                  resource: { type: 'database.collection', id: 'fqcMessages' },
                  actions: [{ action: 'read', selection: { type: 'all' } }],
                },
              ],
            },
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

      const rules = await authorization(env).defaultAccess.list();
      expect(rules).toHaveLength(2);
      expect(rules.find((rule) => rule.key === 'aaa-takeover')?.resource).toEqual(
        { type: 'database.collection', id: 'fqcTickets' },
      );
      expect(rules.find((rule) => rule.key === 'zzz-moved')?.resource).toEqual({
        type: 'database.collection',
        id: 'fqcMessages',
      });
    } finally {
      await env.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'R-013: a rule problem is labelled as that rule, not as a permission set',
  { timeout: TEST_TIMEOUT },
  async () => {
    const env = await openEnvironment();
    const directory = await temporaryDirectory();
    try {
      const file = path.join(directory, 'orphan-rule.json');
      await writeFile(
        file,
        `${JSON.stringify(
          minimalDocument({
            rules: {
              ...emptyRules,
              defaultAccess: [
                {
                  key: 'orphan-rule',
                  resource: { type: 'ghost.type', id: 'nowhere' },
                  actions: [{ action: 'read', selection: { type: 'all' } }],
                },
              ],
            },
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
      expect(document.error?.code).toBe('IMPORT_VALIDATION_FAILED');
      const problems =
        (document.error?.details as { problems?: string[] }).problems ?? [];
      expect(problems).toContain(
        'default-access rule "orphan-rule": resource type "ghost.type" is not registered.',
      );
      // 规则的问题不能挂着权限集的前缀，否则看问题清单时分不清是哪一部分。
      expect(problems.filter((problem) => problem.includes('Permission set'))).toEqual(
        [],
      );
    } finally {
      await env.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'R-013: a username with different case and surrounding spaces resolves to the stored account',
  { timeout: TEST_TIMEOUT },
  async () => {
    const env = await openEnvironment();
    const directory = await temporaryDirectory();
    try {
      const userId = await createUser(env, 'caseuser');
      const file = path.join(directory, 'case.json');
      await writeFile(
        file,
        `${JSON.stringify(
          minimalDocument({
            assignments: [
              {
                subject: { type: 'user', username: '  CaseUser  ' },
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
      expect(imported.exitCode ?? 0).toBe(0);

      const assignments =
        await authorization(env).permissionSets.listAssignments();
      expect(
        assignments.some(
          (assignment) =>
            assignment.subject.type === 'user' &&
            assignment.subject.id === userId &&
            assignment.permissionSet === 'quality_inspector',
        ),
      ).toBe(true);
    } finally {
      await env.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'R-013: a service account exports by name and imports onto the same-named account',
  { timeout: TEST_TIMEOUT },
  async () => {
    const source = await openEnvironment();
    const target = await openEnvironment();
    const directory = await temporaryDirectory();
    try {
      const sourceService = await source.app.container
        .resolve(userAdministrationServiceToken)
        .createServiceAccount({ name: 'fqc-intake-bot' });
      await authorization(source).permissionSets.assign({
        subject: { type: 'user', id: sourceService.id },
        permissionSet: 'quality_inspector',
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
      expect(document.assignments).toContainEqual({
        subject: { type: 'user', kind: 'service', name: 'fqc-intake-bot' },
        permissionSet: 'quality_inspector',
      });

      const targetService = await target.app.container
        .resolve(userAdministrationServiceToken)
        .createServiceAccount({ name: 'fqc-intake-bot' });
      const imported = await runCommand(AuthzImport, target, 'authz:import', [
        '--file',
        file,
        '--json',
      ]);
      expect(imported.exitCode ?? 0).toBe(0);
      const assignments =
        await authorization(target).permissionSets.listAssignments();
      expect(assignments).toContainEqual({
        id: `user:${targetService.id}:quality_inspector`,
        subject: { type: 'user', id: targetService.id },
        permissionSet: 'quality_inspector',
      });

      // 目标环境没有同名的服务账号：列成问题，一行不写。
      const before = await snapshot(target);
      const unknown = path.join(directory, 'unknown-service.json');
      await writeFile(
        unknown,
        `${JSON.stringify(
          minimalDocument({
            assignments: [
              {
                subject: {
                  type: 'user',
                  kind: 'service',
                  name: 'ghost-bot',
                },
                permissionSet: 'staff',
              },
            ],
          }),
          null,
          2,
        )}\n`,
      );
      const refused = await runCommand(AuthzImport, target, 'authz:import', [
        '--file',
        unknown,
        '--json',
      ]);
      expect(refused.exitCode).toBe(1);
      const refusedDocument = refused.json();
      expect(refusedDocument.error?.code).toBe('IMPORT_VALIDATION_FAILED');
      const problems =
        (refusedDocument.error?.details as { problems?: string[] }).problems ??
        [];
      expect(
        problems.some((problem) => problem.includes('ghost-bot')),
        `problems do not mention the service account: ${problems.join(' | ')}`,
      ).toBe(true);
      expect(await snapshot(target)).toEqual(before);
    } finally {
      await source.close();
      await target.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'R-013: user subjects inside rules are exported by username and mapped on import',
  { timeout: TEST_TIMEOUT },
  async () => {
    const source = await openEnvironment();
    const target = await openEnvironment();
    const directory = await temporaryDirectory();
    try {
      const sourceUser = await createUser(source, 'rulesubject');
      await authorization(source).sharingRules.create({
        key: 'share-quality-ticket',
        resource: { type: 'database.collection', id: 'fqcTickets' },
        actions: [
          {
            action: 'read',
            selection: { type: 'records', ids: ['ticket-1'] },
          },
        ],
        subjects: [{ type: 'user', id: sourceUser }],
      });

      const file = path.join(directory, 'authorization.json');
      const exported = await runCommand(AuthzExport, source, 'authz:export', [
        '--out',
        file,
        '--json',
      ]);
      expect(exported.exitCode ?? 0).toBe(0);
      const document = JSON.parse(await readFile(file, 'utf8'));
      const exportedRule = document.rules.sharing.find(
        (rule: { key: string }) => rule.key === 'share-quality-ticket',
      );
      expect(exportedRule).toBeDefined();
      expect(exportedRule.subjects).toEqual([
        { type: 'user', username: 'rulesubject' },
      ]);

      const targetUser = await createUser(target, 'rulesubject');
      const imported = await runCommand(AuthzImport, target, 'authz:import', [
        '--file',
        file,
        '--json',
      ]);
      expect(imported.error).toBeUndefined();
      expect(imported.exitCode ?? 0).toBe(0);
      const stored = await authorization(target).sharingRules.list();
      expect(
        stored.find((rule) => rule.key === 'share-quality-ticket')?.subjects,
      ).toEqual([{ type: 'user', id: targetUser }]);
    } finally {
      await source.close();
      await target.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'R-013: the successful output names every created and updated entry',
  { timeout: TEST_TIMEOUT },
  async () => {
    const env = await openEnvironment();
    const directory = await temporaryDirectory();
    try {
      await createUser(env, 'named');
      const file = path.join(directory, 'named.json');
      await writeFile(
        file,
        `${JSON.stringify(
          minimalDocument({
            permissionSets: [
              {
                key: 'named_role',
                revision: 'x',
                title: { key: 'permissionSets.named', ns: 'app-local' },
                grants: [],
              },
            ],
            assignments: [
              {
                subject: { type: 'user', username: 'named' },
                permissionSet: 'named_role',
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
      ]);
      expect(imported.error).toBeUndefined();
      expect(imported.exitCode ?? 0).toBe(0);
      const result = imported.result as {
        changes: { created: string[]; updated: string[] };
      };
      expect(result.changes.created).toContain('permission set "named_role"');
      expect(result.changes.created).toContain(
        'assignment user "named" → "named_role"',
      );
      expect(imported.stdout).toContain('permission set "named_role"');
      expect(imported.stdout).toContain(
        'assignment user "named" → "named_role"',
      );
    } finally {
      await env.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
