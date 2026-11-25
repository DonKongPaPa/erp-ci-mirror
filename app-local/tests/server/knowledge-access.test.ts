import { randomUUID } from 'node:crypto';

import {
  authorizationToken,
  type AppAuthorization,
} from '@nocobase/app-plugin-authorization';
import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
  type TestSession,
} from '@nocobase/app-plugin-authentication/testing';
import { knowledgeAccessToken } from '@nocobase/app-plugin-knowledge/server/tokens';
import type { SpaceRef } from '@nocobase/app-plugin-knowledge/shared/knowledge';
import { createAppTest } from '../helpers/test-app.js';
import { expect } from 'vitest';

import { createStandaloneServer } from '../../server/standalone.js';

/**
 * R-002 验收11：质量知识库只有一个空间，解析器取最高档再展开。
 *
 * 逐动作独立问会让只持 `manage.related` 的人得到 `read = false`，所以这里逐个档位
 * 钉住四项展开的结果：`manage.related` 的四项全真，`read.related` 只有读为真，
 * 什么都没持有全假；`manage.all` 与 `.related` 今天等价（本应用只有一个空间）；
 * 问别的空间回空。另测 `names` 只认 `user:<标识>`、只回姓名，不回邮箱。
 *
 * 「读者不是账号」用一个不存在的用户标识：即便有人把知识库授权挂到
 * `authenticated` 这个通用主体上，它也不该被解析器当成账号。
 */
const test = createAppTest({
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

const PASSWORD = 'R002-knowledge-123!';
const SPACE: SpaceRef = { scope: 'quality', scopeId: 'standards' };

const json = (body: unknown, method = 'POST') => ({
  method,
  headers: {
    'content-type': 'application/json',
    origin: 'http://localhost',
    'Idempotency-Key': `${Date.now()}.${randomUUID()}`,
  },
  body: JSON.stringify(body),
});

const createUser = async (
  admin: TestSession,
  name: string,
  roleScopes: Record<string, string[]>,
): Promise<{ id: string }> => {
  const response = await admin.fetch(
    '/users',
    json({
      name,
      username: name,
      email: `${name}@example.test`,
      password: PASSWORD,
      roleScopes,
    }),
  );
  const text = await response.text();
  expect(response.status, `${text}`).toBe(201);
  return (JSON.parse(text) as { data: { id: string } }).data;
};

const grantTo = async (
  authz: AppAuthorization,
  key: string,
  userId: string,
  action: string,
): Promise<void> => {
  await authz.permissionSets.create({
    key,
    grants: [
      {
        resource: { type: 'kb', id: 'kb.knowledge' },
        actions: [{ action }],
      },
    ],
  });
  await authz.permissionSets.assign({
    subject: { type: 'user', id: userId },
    permissionSet: key,
  });
};

test('R-002 11: 只认质量标准这一个空间，没有继承，标题是一个词条', async ({
  app,
}) => {
  const resolver = app.container.resolve(knowledgeAccessToken);
  expect(resolver.space({ scope: 'quality', scopeId: 'standards' })).toEqual(
    SPACE,
  );
  for (const space of [
    { scope: 'quality', scopeId: 'other' },
    { scope: 'project', scopeId: 'standards' },
    { scope: 'quality', scopeId: '' },
  ]) {
    expect(
      resolver.space(space),
      `${JSON.stringify(space)} 不应当被接受`,
    ).toBeNull();
  }
  expect(resolver.inherits(SPACE)).toEqual([]);
  expect(await resolver.title(SPACE)).toBe('质量标准');
});

test('R-002 11: 只持 manage.related 的人得到四项，只持 read.related 的只有读', async ({
  testApp,
  app,
}) => {
  const authz = app.container.resolve(authorizationToken);
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);

  // 知识库的动作已经由插件注册进授权模型；没注册时下面的判定会以
  // RESOURCE_ACTION_NOT_SUPPORTED 被拒，那样的「没有权限」不算数。
  const resourceType = authz.resourceTypes.get('kb');
  const item = resourceType.items?.get('kb.knowledge');
  expect(item, '授权模型里没有 kb.knowledge').toBeDefined();
  const actions = item?.actions.map((action) => action.name) ?? [];
  for (const action of [
    'read.related',
    'read.all',
    'propose.related',
    'manage.related',
    'manage.all',
  ]) {
    expect(actions, `kb.knowledge 没有登记 ${action}`).toContain(action);
  }

  const manager = await createUser(admin, 'r002kbmanager', { app: [] });
  await grantTo(authz, 'r002-kb-manage-related', manager.id, 'manage.related');
  const inspector = await createUser(admin, 'r002kbinspector', { app: [] });
  await grantTo(
    authz,
    'r002-kb-propose-related',
    inspector.id,
    'propose.related',
  );
  const reader = await createUser(admin, 'r002kbreader', { app: [] });
  await grantTo(authz, 'r002-kb-read-related', reader.id, 'read.related');
  const everything = await createUser(admin, 'r002kball', { app: [] });
  await grantTo(authz, 'r002-kb-manage-all', everything.id, 'manage.all');
  const nobody = await createUser(admin, 'r002kbnobody', { app: [] });

  const resolver = app.container.resolve(knowledgeAccessToken);
  const accessOf = (userId: string) =>
    resolver.forReader({ userId }).access(SPACE);

  expect(
    await accessOf(manager.id),
    '只持 manage.related 应当四项全真',
  ).toEqual({
    read: true,
    propose: true,
    edit: true,
    manage: true,
  });
  expect(
    await accessOf(inspector.id),
    'propose.related 应当读与提案为真',
  ).toEqual({
    read: true,
    propose: true,
    edit: false,
    manage: false,
  });
  expect(await accessOf(reader.id), 'read.related 应当只有读为真').toEqual({
    read: true,
    propose: false,
    edit: false,
    manage: false,
  });
  expect(
    await accessOf(everything.id),
    'manage.all 与 .related 今天等价',
  ).toEqual({
    read: true,
    propose: true,
    edit: true,
    manage: true,
  });
  expect(await accessOf(nobody.id), '什么都没持有应当四项全假').toEqual({
    read: false,
    propose: false,
    edit: false,
    manage: false,
  });
  expect(await accessOf(randomUUID()), '读者不是账号时四项都应当是假').toEqual({
    read: false,
    propose: false,
    edit: false,
    manage: false,
  });
});

test('R-002 11: 授权挂到 authenticated 主体上，也不把一个不在库里的标识当成读者', async ({
  testApp,
  app,
}) => {
  const authz = app.container.resolve(authorizationToken);
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  // 把知识库的读挂给所有已登录的主体：真实账号拿得到，不存在的标识不该因此变成账号。
  await authz.permissionSets.create({
    key: 'r002-kb-everyone',
    grants: [
      {
        resource: { type: 'kb', id: 'kb.knowledge' },
        actions: [{ action: 'read.related' }],
      },
    ],
  });
  await authz.permissionSets.assign({
    subject: { type: 'authenticated', id: '*' },
    permissionSet: 'r002-kb-everyone',
  });

  const resolver = app.container.resolve(knowledgeAccessToken);
  const real = await createUser(admin, 'r002kbeveryone', { app: [] });
  expect(
    (await resolver.forReader({ userId: real.id }).access(SPACE)).read,
    '真实账号应当拿到挂给所有登录主体的读',
  ).toBe(true);
  expect(
    (
      await resolver
        .forReader({ userId: randomUUID() })
        .access(SPACE)
    ).read,
    '不在库里的标识不该借 authenticated 那一份授权读知识库',
  ).toBe(false);
});

test('R-002 11: names 只认 user:<标识>，回姓名不回邮箱', async ({
  testApp,
  app,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const first = await createUser(admin, 'r002kbnamea', { app: [] });
  const second = await createUser(admin, 'r002kbnameb', { app: [] });

  const names = await app.container.resolve(knowledgeAccessToken).names([
    { kind: 'user', id: first.id },
    { kind: 'user', id: second.id },
    { kind: 'role', id: first.id },
    { kind: 'user', id: randomUUID() },
  ]);

  expect(names.get(`user:${first.id}`)).toBe('r002kbnamea');
  expect(names.get(`user:${second.id}`)).toBe('r002kbnameb');
  expect(names.has(`role:${first.id}`), '别的类型不该被回答').toBe(false);
  expect(names.size, '未知的个人不该出现在结果里').toBe(2);
  for (const value of names.values()) {
    expect(value).not.toContain('@example.test');
  }
});
