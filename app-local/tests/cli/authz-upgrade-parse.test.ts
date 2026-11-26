// @vitest-environment node
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { bindAppCommand, runAppCommand } from '@nocobase/app-testing/cli';
import { afterEach, describe, expect, it, vi } from 'vitest';

import AuthzUpgradeR002 from '../../cli/authz/upgrade-r002.js';
import AuthzUpgradeR003 from '../../cli/authz/upgrade-r003.js';
import AuthzUpgradeR026 from '../../cli/authz/upgrade-r026.js';

import { appRoot } from '../helpers/authz-transfer.js';

/**
 * `authz upgrade-*` 跑完会在 stderr 打
 * `Command authz upgrade-r003 did not parse its arguments`（代码 UnparsedCommand）。
 * 根因在应用侧：export/import 的 run() 调了 this.parse(...)，三个升级命令没有，
 * oclif 的 Command._run() 收尾看到 parsed 为空就发这条告警。框架文件不能改，
 * 这里在命令侧补上 parse；告警用假应用服务跑真实命令验。
 */

const commands = [
  AuthzUpgradeR002,
  AuthzUpgradeR003,
  AuthzUpgradeR026,
] as const;

const restore: Array<() => void> = [];
afterEach(() => {
  for (const undo of restore.splice(0)) undo();
});

/** 只满足升级命令的读取路径：权限集为空、没有可指派的人，所以不会写库。 */
function fakeApp() {
  const services = {
    permissionSets: {
      list: async () => [],
      get: async () => undefined,
    },
    compositeResources: {
      getAction: () => undefined,
      validateGrant: () => undefined,
    },
    connection: () => ({
      query: {
        selectFrom: () => {
          throw new Error('空权限集不该查用户表');
        },
      },
    }),
  };
  return {
    start: async () => undefined,
    shutdown: async () => undefined,
    container: { resolve: () => services },
  };
}

function run(command: (typeof commands)[number], argv: readonly string[]) {
  const Bound = bindAppCommand(command, {
    rootDir: appRoot,
    id: `authz:${command.name.replace('AuthzUpgrade', 'upgrade-').toLowerCase()}`,
    loadRuntime: async () => ({ scope: { destroy: async () => undefined } }),
    createApp: async () => fakeApp(),
  } as Parameters<typeof bindAppCommand>[1]);
  return runAppCommand(Bound, [...argv]);
}

describe('authz 升级命令的参数解析告警', () => {
  for (const [name, source, marker] of [
    ['upgrade-r002', 'upgrade-r002.ts', '[r002-review-scope] quality_manager: not found; skipped'],
    ['upgrade-r003', 'upgrade-r003.ts', '[r003] === role grants ==='],
    ['upgrade-r026', 'upgrade-r026.ts', '[r026] === role grants ==='],
  ] as const) {
    it(`${name} 的 run() 调用 this.parse，不再触发 UnparsedCommand`, async () => {
      const command = commands.find(
        (entry) => entry.name.toLowerCase().endsWith(name.replace('-', '')),
      );
      expect(command, `${name} 命令类没找到`).toBeDefined();

      // 真实 oclif 收尾：parsed 为假才会 emitWarning，这里直接看它有没有发。
      const warn = vi
        .spyOn(process, 'emitWarning')
        .mockImplementation(() => undefined);
      restore.push(() => warn.mockRestore());
      const result = await run(command!, []);
      expect(result.error).toBeUndefined();
      expect(result.exitCode ?? 0).toBe(0);
      // 升级命令原有的输出行一个不少。
      expect(result.stdout).toContain(marker);
      const unparsed = warn.mock.calls.filter((args) =>
        (args as unknown[]).some(
          (arg) =>
            typeof arg === 'object' &&
            arg !== null &&
            'code' in arg &&
            (arg as { code?: unknown }).code === 'UnparsedCommand',
        ),
      );
      expect(unparsed, '命令跑完不该再发 UnparsedCommand 告警').toEqual([]);
      const text = readFileSync(
        path.join(appRoot, 'cli', 'authz', source),
        'utf8',
      );
      expect(text, `${name} 的 run() 必须先解析参数`).toMatch(
        /async run\(\)[^{]*\{\s*(?:\/\/[^\n]*\n\s*)*await this\.parse\(/u,
      );
    });
  }
});
