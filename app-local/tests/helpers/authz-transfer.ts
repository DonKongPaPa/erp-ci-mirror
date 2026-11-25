// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { authorizationToken } from '@nocobase/app-plugin-authorization/server';
import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
} from '@nocobase/app-plugin-authentication/testing';
import type { Application } from '@nocobase/app-server/application';
import {
  bindAppCommand,
  createTestAppConfig,
  runAppCommand,
  type TestAppConfig,
} from '@nocobase/app-testing/cli';

import AuthzExport from '../../cli/authz/export.js';
import AuthzImport from '../../cli/authz/import.js';
import type { AuthorizationApis } from '../../cli/authz/transfer.js';
import { createStandaloneServer } from '../../server/standalone.js';

/**
 * R-013 导出/导入测试共用的夹具。
 *
 * 命令不靠子进程：应用由 `createStandaloneServer()` 按 `createTestAppConfig()` 的隔离库
 * 拉起；`bindAppCommand()` 把命令钉在这个已经起好的应用上，`runAppCommand()` 按真实
 * oclif runner 的方式跑它并收下 JSON 信封、退出码与 stdout。
 */
export const appRoot = fileURLToPath(new URL('../../', import.meta.url));
export const TEST_TIMEOUT = 180_000;
export const authConfig = {
  app: { publicOrigin: 'http://localhost' },
  auth: { secret: 'test-auth-secret-at-least-32-characters' },
};

export interface Environment {
  readonly config: TestAppConfig;
  readonly app: Application;
  readonly publicBasePath: string;
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
}

/** 起一个隔离环境，库已按应用自己的迁移与 seed 安装好。 */
export async function openEnvironment(): Promise<Environment> {
  const config = await createTestAppConfig({ config: authConfig });
  try {
    const server = await createStandaloneServer({
      viteDevUrl: false,
      configPath: config.path,
      env: { APP_STORAGE_DIR: path.join(config.directory, 'storage') },
    });
    const app = server.application;
    return {
      config,
      app,
      publicBasePath: app.publicBasePath,
      fetch: (request) => server.fetch(request),
      close: async () => {
        try {
          await server.close();
        } finally {
          await config.dispose();
        }
      },
    };
  } catch (error) {
    await config.dispose();
    throw error;
  }
}

/**
 * 应用已经起好，命令不要再创建、也不要关掉它：`withApp()` 会调用 `shutdown()`，
 * 这里换成空操作，其余成员原样转发。
 */
function pinApplication(app: Environment['app']): Environment['app'] {
  return new Proxy(app, {
    get(target, property) {
      if (property === 'shutdown') {
        return async () => undefined;
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export async function runCommand(
  command: typeof AuthzExport | typeof AuthzImport,
  env: Environment,
  id: string,
  argv: readonly string[],
) {
  const Bound = bindAppCommand(command, {
    rootDir: appRoot,
    id,
    loadRuntime: async () =>
      ({ env: {}, scope: { destroy: async () => undefined } }) as never,
    createApp: () => pinApplication(env.app),
  });
  return runAppCommand(Bound, argv);
}

export function idempotencyHeaders(): Record<string, string> {
  return {
    'content-type': 'application/json',
    origin: 'http://localhost',
    'Idempotency-Key': `${Date.now()}.${randomUUID()}`,
  };
}

/** 建一个测试用户，返回它的 id。 */
export async function createUser(
  env: Environment,
  username: string,
): Promise<string> {
  const admin = await signIn(env, DEFAULT_ADMIN_CREDENTIALS);
  const response = await admin.fetch('/users', {
    method: 'POST',
    headers: idempotencyHeaders(),
    body: JSON.stringify({
      name: username,
      username,
      email: `${username}@example.test`,
      password: 'Roundtrip-test-123!',
    }),
  });
  if (response.status !== 201) {
    throw new Error(
      `Creating user "${username}" failed with ${response.status}: ${await response.text()}`,
    );
  }
  return (await response.json()).data.id;
}

export function authorization(env: Environment): AuthorizationApis {
  return env.app.container.resolve(
    authorizationToken,
  ) as unknown as AuthorizationApis;
}

export async function configuredAccess(
  env: Environment,
  userId: string,
): Promise<unknown> {
  const admin = await signIn(env, DEFAULT_ADMIN_CREDENTIALS);
  const response = await admin.fetch(
    `/authorization/inspector/configuredAccess?subjectType=user&subjectId=${encodeURIComponent(userId)}`,
  );
  if (response.status !== 200) {
    throw new Error(
      `configuredAccess for ${userId} failed with ${response.status}: ${await response.text()}`,
    );
  }
  const body = await response.json();
  // 用户 id 每个环境不同，其余部分应当逐项相等。
  return JSON.parse(JSON.stringify(body.data).split(userId).join('<user>'));
}

/** 服务层的有效权限：权限集与授权本身，不含环境相关的 id。 */
export async function effectivePermissionSets(
  env: Environment,
  userId: string,
) {
  const sets = await authorization(env).permissionSets.getEffective({
    principal: { type: 'user', id: userId },
  });
  return sets
    .map((set) => ({
      key: set.key,
      title: set.title ?? null,
      grants: set.grants,
    }))
    .sort((left, right) => left.key.localeCompare(right.key));
}

/** 库里与导入有关的全部行，含版本号。导入前后各取一次，用来证明「一行没变」。 */
export async function snapshot(env: Environment) {
  const authz = authorization(env);
  const [sets, assignments, defaultAccess, sharing, restriction] =
    await Promise.all([
      authz.permissionSets.list(),
      authz.permissionSets.listAssignments(),
      authz.defaultAccess.list(),
      authz.sharingRules.list(),
      authz.restrictionRules.list(),
    ]);
  return {
    permissionSets: sets.map((set) => ({
      key: set.key,
      title: set.title ?? null,
      grants: set.grants,
      revision: set.revision ?? null,
    })),
    assignments: assignments
      .map((assignment) => ({
        subjectType: assignment.subject.type,
        subjectId: assignment.subject.id,
        permissionSet: assignment.permissionSet,
      }))
      .sort((left, right) =>
        `${left.permissionSet}:${left.subjectType}:${left.subjectId}`.localeCompare(
          `${right.permissionSet}:${right.subjectType}:${right.subjectId}`,
        ),
      ),
    rules: {
      defaultAccess: [...defaultAccess].sort((left, right) =>
        left.key.localeCompare(right.key),
      ),
      sharing: [...sharing].sort((left, right) =>
        left.key.localeCompare(right.key),
      ),
      restriction: [...restriction].sort((left, right) =>
        left.key.localeCompare(right.key),
      ),
    },
  };
}

export async function temporaryDirectory(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'authz-transfer-test-'));
}

export function minimalDocument(overrides: Record<string, unknown> = {}) {
  return {
    format: 1,
    exportedAt: new Date().toISOString(),
    permissionSets: [],
    assignments: [],
    rules: { defaultAccess: [], sharing: [], restriction: [] },
    protected: [],
    ...overrides,
  };
}
