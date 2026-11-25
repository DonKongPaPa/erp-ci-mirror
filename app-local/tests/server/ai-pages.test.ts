// @vitest-environment node
import { randomBytes, randomUUID } from 'node:crypto';

import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
} from '@nocobase/app-plugin-authentication/testing';
import { createAppTest } from '../helpers/test-app.js';
import { expect } from 'vitest';

import { createStandaloneServer } from '../../server/standalone.js';

/**
 * R-042 第 4、5 条的服务端一半。
 *
 * 第 4 条：一个没有任何 AI 授权的登录用户，`/authorization/permissions` 的快照里没有 AI 的页面与设置项，
 * 直接调 `/models` 与 `/agents` 背后的接口被拒。页面授权由客户端路由守卫按这份快照判定（客户端那一半在
 * `tests/client/ai-navigation.test.ts`）；`/agents` 页面本身是 Agent 插件的接口，插件设计上允许任何登录用户
 * 读取，所以这里钉的是它那条页面授权的判定结果，而不是 `GET /agents` 的响应。
 *
 * 第 5 条：新建模型服务不联网（`POST /services` 只校验并落库，「测连接」「取模型列表」是另外的端点），
 * 所以可以用假密钥建一条，断言读接口只回 `apiKeySet`、库里那一列不是明文。
 * 密钥主键在这个文件里生成，不写死、不提交。
 */

const SECRETS_KEY = randomBytes(32).toString('hex');
const test = createAppTest({
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
    secrets: { keys: [{ version: 1, key: SECRETS_KEY }] },
  },
});

const PASSWORD = 'R042-ai-pages-123!';
/** 一眼看得出是假值的密钥。 */
const FAKE_API_KEY = `test-${randomBytes(24).toString('hex')}`;
const SERVICE_TITLE = 'R-042 test service';
const SERVICE_BASE_URL = 'http://127.0.0.1:1/v1';

interface ApiErrorBody {
  error: {
    status: string;
    reason: string;
    domain: string;
    message: string;
  };
}

const operationKey = () => `${Date.now()}.${randomUUID()}`;

const json = (body: unknown, method = 'POST') => ({
  method,
  headers: {
    'content-type': 'application/json',
    origin: 'http://localhost',
    'Idempotency-Key': operationKey(),
  },
  body: JSON.stringify(body),
});

const expectJson = async (
  response: Response,
  status: number,
): Promise<unknown> => {
  const text = await response.text();
  expect(response.status, `${text}`).toBe(status);
  return JSON.parse(text) as unknown;
};

const expectDenied = async (
  response: Response,
  what: string,
): Promise<ApiErrorBody['error']> => {
  const error = (await expectJson(response, 403)) as ApiErrorBody;
  expect(error.error.status, `${what} 应当是 PERMISSION_DENIED`).toBe(
    'PERMISSION_DENIED',
  );
  return error.error;
};

const createUserWithoutRoles = async (
  admin: Awaited<ReturnType<typeof signIn>>,
): Promise<{ id: string; username: string }> => {
  const username = 'r042noai';
  const response = await admin.fetch(
    '/users',
    json({
      name: username,
      username,
      email: `${username}@example.test`,
      password: PASSWORD,
      roleScopes: { app: [] },
    }),
  );
  const text = await response.text();
  expect(response.status, `${text}`).toBe(201);
  return (JSON.parse(text) as { data: { id: string } }).data;
};

const AI_GRANTS = [
  { resource: { type: 'settings', id: 'agents.services' }, action: 'read' },
  { resource: { type: 'page', id: 'agents' }, action: 'access' },
  { resource: { type: 'page', id: 'runtimes' }, action: 'access' },
  { resource: { type: 'page', id: 'skills' }, action: 'access' },
  { resource: { type: 'page', id: 'usage' }, action: 'access' },
] as const;

test('R-042 4: a signed-in user without AI grants is refused the AI pages', async ({
  testApp,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const nobody = await createUserWithoutRoles(admin);
  const session = await signIn(testApp, {
    username: nobody.username,
    password: PASSWORD,
  });

  const snapshotResponse = await session.fetch('/authorization/permissions');
  expect(snapshotResponse.status).toBe(200);
  const { data: snapshot } = (await snapshotResponse.json()) as {
    data: {
      unrestricted: boolean;
      permissions: {
        resource: { type: string; id: string };
        actions: string[];
      }[];
    };
  };
  expect(snapshot.unrestricted, '这个用户不该有不受限的授权').toBe(false);
  // 导航就是拿这份快照过滤的：五项一个都不在里面，AI 分组就不会出现。
  for (const grant of AI_GRANTS) {
    expect(
      snapshot.permissions.some(
        (permission) =>
          permission.resource.type === grant.resource.type &&
          (permission.resource.id === '*' ||
            permission.resource.id === grant.resource.id) &&
          permission.actions.includes(grant.action),
      ),
      `${grant.resource.type}:${grant.resource.id} ${grant.action} 不该出现在快照里`,
    ).toBe(false);
  }

  // 直接打开 `/models`（设置项 agents.services 的 read）与 `/agents`（页面授权）时，守卫问的是这两种判定。
  const decide = async (
    resource: { type: string; id: string },
    action: string,
  ) => {
    const response = await admin.fetch(
      '/authorization/inspector/decide',
      json({ subject: { type: 'user', id: nobody.id }, resource, action }),
    );
    const { data } = (await expectJson(response, 200)) as {
      data: { effect: string };
    };
    return data.effect;
  };
  await expect(
    decide({ type: 'settings', id: 'agents.services' }, 'read'),
    '/models 的授权判定应当是拒绝',
  ).resolves.toBe('deny');
  await expect(
    decide({ type: 'page', id: 'agents' }, 'access'),
    '/agents 的授权判定应当是拒绝',
  ).resolves.toBe('deny');

  // `/models` 页面的接口：列服务与建设服务都要求 agents.services。R-045 之后这里先被
  // 应用自己的守卫拦住（没有任何 AI 授权 → 403 AI_ACCESS_REQUIRED），比接口自己的
  // `FORBIDDEN` 更早一层；原因码照新的契约钉死，不放宽成「403 都行」。
  const listError = await expectDenied(
    await session.fetch('/agents/services'),
    'GET /agents/services',
  );
  expect(listError.reason, 'GET /agents/services 的原因码').toBe(
    'AI_ACCESS_REQUIRED',
  );
  await expectDenied(
    await session.fetch(
      '/agents/services',
      json({
        title: 'R-042 denied service',
        provider: 'openai-compatible',
        baseUrl: SERVICE_BASE_URL,
        apiKey: FAKE_API_KEY,
      }),
    ),
    'POST /agents/services',
  );

  // `/usage` 的接口在服务端查页面授权；R-045 的守卫同样先一步拒掉没有 AI 授权的人。
  const usageError = await expectDenied(
    await session.fetch('/agents/usage'),
    'GET /agents/usage',
  );
  expect(usageError.reason, 'GET /agents/usage 的原因码').toBe(
    'AI_ACCESS_REQUIRED',
  );

  // `/skills` 页面的接口要 agents.agents 读；没有角色的用户同样被拒。
  await expectDenied(
    await session.fetch('/agents/skills'),
    'GET /agents/skills',
  );
});

test('R-042 5: a model service keeps its key sealed and never answers it', async ({
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);

  const created = await expectJson(
    await admin.fetch(
      '/agents/services',
      json({
        title: SERVICE_TITLE,
        provider: 'openai-compatible',
        baseUrl: SERVICE_BASE_URL,
        apiKey: FAKE_API_KEY,
        models: [{ value: 'test-chat', label: 'Test chat', kind: 'chat' }],
      }),
    ),
    201,
  );
  const createBody = JSON.stringify(created);
  expect(createBody).not.toContain(FAKE_API_KEY);
  const service = (
    created as {
      data: {
        name: string;
        apiKeySet: boolean;
        apiKey?: unknown;
        apiKeyEncrypted?: unknown;
      };
    }
  ).data;
  expect(service.apiKeySet, '新建的响应应当只说密钥已设置').toBe(true);
  expect(service).not.toHaveProperty('apiKey');
  expect(service).not.toHaveProperty('apiKeyEncrypted');

  // 列表接口只有 apiKeySet；模型目录连密钥是否存在都不说。两者都不能出现明文。
  const listed = await admin.fetch('/agents/services');
  const listedText = await listed.text();
  expect(listed.status, `${listedText}`).toBe(200);
  expect(listedText, '服务列表的响应里出现了明文密钥').not.toContain(
    FAKE_API_KEY,
  );
  expect(listedText).toContain('apiKeySet');

  const catalog = await admin.fetch('/agents/models?kind=chat');
  const catalogText = await catalog.text();
  expect(catalog.status, `${catalogText}`).toBe(200);
  expect(catalogText, '模型目录的响应里出现了明文密钥').not.toContain(
    FAKE_API_KEY,
  );
  const updated = await admin.fetch(
    `/agents/services/${encodeURIComponent(service.name)}`,
    json({ title: 'R-042 test service renamed' }, 'PATCH'),
  );
  const updatedText = await updated.text();
  expect(updated.status, `${updatedText}`).toBe(200);
  expect(updatedText).not.toContain(FAKE_API_KEY);
  expect(updatedText).toContain('apiKeySet');

  // 库里那一列不是明文：既不是密钥本身，也不包含它。
  const row = await connection.repository('agModelServices').findOne({
    filter: { name: service.name },
  });
  expect(row, '新建的模型服务没有落库').toBeTruthy();
  const sealed = String(row!.apiKeyEncrypted);
  expect(sealed, '库里存的是明文密钥').not.toBe(FAKE_API_KEY);
  expect(sealed, '库里存的值包含明文密钥').not.toContain(FAKE_API_KEY);
  expect(sealed.length, '密文不比明文长，肯定不是密封过的').toBeGreaterThan(
    FAKE_API_KEY.length,
  );
});
