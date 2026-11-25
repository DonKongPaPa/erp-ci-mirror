// @vitest-environment node
import { randomUUID } from 'node:crypto';

import { agentsToken } from '@nocobase/app-plugin-agents/server/tokens';
import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
  type SignInTarget,
  type TestSession,
} from '@nocobase/app-plugin-authentication/testing';
import { authorizationToken } from '@nocobase/app-plugin-authorization';
import { createAppTest } from '../helpers/test-app.js';
import type { Application } from '@nocobase/app-server/application';
import type { DatabaseConnection } from '@nocobase/db';
import { expect } from 'vitest';

import { createStandaloneServer } from '../../server/standalone.js';

/**
 * R-045「AI 接口的守卫」的验收测试。
 *
 * 全部打真实挂载路径（`createAppTest` + 进程内服务器 + 登录拿 cookie），不测守卫函数本身。
 * 三件要钉住的事：
 *
 * 1. 凭用户会话调 `/api/agents/*`，没有任何 AI 授权 → 403 `AI_ACCESS_REQUIRED`；
 *    持一项就照旧放行（各接口自己还有更细的检查）。
 * 2. 发注册令牌、或把自己的机器改成「团队」，还另外要 `agents.runners` 的 manage ——
 *    这是框架漏掉的那一处，收紧它等于把「让一台机器进来」整件事收到同一项权限。
 * 3. 机器与运行的通道（公开安装脚本、注册令牌换 runner key、runner key 心跳与领活、
 *    run token）不受影响：判据是凭据形态，不是路径白名单。
 *
 * 身份三类：没有任何 AI 授权的登录用户（建用户时显式 `roleScopes: { app: [] }`）、
 * 只持页面 `agents` access 的用户、root（`DEFAULT_ADMIN_CREDENTIALS`）。
 *
 * 凭据形态两条线都钉：会话 cookie，以及 `Authorization: Bearer <会话令牌>`（浏览器命令行走
 * Bearer，设备授权换来的也是它）。后者要是认不出来，非 root 就能用这条形态绕过守卫。
 */

const PASSWORD = 'R045-guard-123!';
/** `@nocobase/agent-protocol` 的 PROTOCOL_VERSION：应用里没有这个包的直接依赖，写常量。 */
const RUNNER_PROTOCOL_VERSION = 18;

const PAGE_AGENTS_ACCESS = {
  resource: { type: 'page', id: 'agents' },
  actions: [{ action: 'access' }],
};
const RUNNERS_MANAGE = {
  resource: { type: 'settings', id: 'agents.runners' },
  actions: [{ action: 'manage' }],
};

const test = createAppTest({
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

interface ApiErrorBody {
  error: {
    status: string;
    reason: string;
    domain: string;
    message: string;
  };
}

const json = (body: unknown, method = 'POST') => ({
  method,
  headers: {
    'content-type': 'application/json',
    origin: 'http://localhost',
    'Idempotency-Key': `${Date.now()}.${randomUUID()}`,
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

const expectError = async (
  response: Response,
  status: number,
): Promise<ApiErrorBody['error']> =>
  ((await expectJson(response, status)) as ApiErrorBody).error;

/** 守卫的拒绝：状态、原因码、域都要是应用现有的形状。 */
/** 状态码断言，失败时把响应体带进消息里。 */
const expectStatus = async (
  response: Response,
  status: number,
): Promise<void> => {
  const text = await response.clone().text();
  expect(response.status, `${text}`).toBe(status);
};

const expectGuardDenial = async (
  response: Response,
  reason: string,
  what: string,
): Promise<void> => {
  const text = await response.clone().text();
  expect(response.status, `${what}: ${text}`).toBe(403);
  const error = ((await response.json()) as ApiErrorBody).error;
  expect(error.status, `${what} 的状态`).toBe('PERMISSION_DENIED');
  expect(error.reason, `${what} 的原因码`).toBe(reason);
  expect(error.domain, `${what} 的 domain`).toBeTruthy();
  expect(error.message, `${what} 的 message`).toBeTruthy();
};

interface Identity {
  readonly id: string;
  readonly username: string;
  readonly session: TestSession;
}

const createUser = async (
  admin: TestSession,
  username: string,
  roles: readonly string[],
): Promise<{ id: string }> => {
  const response = await admin.fetch(
    '/users',
    json({
      name: username,
      username,
      email: `${username}@example.test`,
      password: PASSWORD,
      roleScopes: { app: [...roles] },
    }),
  );
  const text = await response.text();
  expect(response.status, `${text}`).toBe(201);
  return (JSON.parse(text) as { data: { id: string } }).data;
};

const signInAs = async (
  testApp: Parameters<typeof signIn>[0],
  username: string,
): Promise<TestSession> =>
  await signIn(testApp, { username, password: PASSWORD });

/** 三个身份：没有任何 AI 授权、只持页面 `agents`、持 `agents.runners` manage。 */
const setupIdentities = async (
  testApp: Parameters<typeof signIn>[0],
  app: Application,
  tag: string,
) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const sets = app.container.resolve(authorizationToken).permissionSets;
  const pageSet = `ai_page_${tag}`;
  const manageSet = `ai_manage_${tag}`;
  await sets.create({ key: pageSet, grants: [PAGE_AGENTS_ACCESS] });
  await sets.create({ key: manageSet, grants: [RUNNERS_MANAGE] });

  const make = async (
    name: string,
    roles: readonly string[],
  ): Promise<Identity> => {
    const username = `${name}_${tag}`;
    const user = await createUser(admin, username, roles);
    return { ...user, username, session: await signInAs(testApp, username) };
  };
  return {
    admin,
    nobody: await make('noai', []),
    pageReader: await make('pagereader', [pageSet]),
    runnerManager: await make('runnermgr', [manageSet]),
  };
};

/** 一台属于 `ownerUserId` 的机器：直接调服务，绕开 HTTP 上的授权（夹具，不是被测对象）。 */
const createRunner = async (
  app: Application,
  ownerUserId: string,
  name: string,
): Promise<{ runnerId: string; runnerKey: string }> => {
  const services = app.container.resolve(agentsToken);
  const token = await services.runners.createRegistrationToken(ownerUserId, {});
  const registered = await services.runners.register({
    registrationToken: token.token,
    name,
    hostname: `${name}-host`,
    os: 'linux',
    arch: 'x64',
    version: '0.0.0-r045',
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    features: [],
    tools: [],
  });
  return {
    runnerId: registered.runnerId,
    runnerKey: registered.runnerKey,
  };
};

/** 一个 agent 行：`/agents` 与 `/agents/:id` 要读得到。 */
const createAgent = async (
  connection: DatabaseConnection,
  id: string,
  ownerUserId: string,
): Promise<void> => {
  const now = new Date().toISOString();
  await connection.repository('agAgents').createOne({
    values: {
      id,
      name: `R-045 ${id}`,
      type: 'runner',
      modelEntries: [],
      ownerUserId,
      createdAt: now,
      updatedAt: now,
    },
  });
};

/** 登录并取回会话令牌：`signIn` 只留 cookie，Bearer 用的是响应体里的 `token`。 */
const sessionTokenOf = async (
  testApp: SignInTarget,
  username: string,
  password: string = PASSWORD,
): Promise<string> => {
  const response = await testApp.fetch(
    new Request(
      `http://localhost${testApp.publicBasePath}/api/auth/sign-in/username`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
      },
    ),
  );
  const text = await response.text();
  expect(response.status, `${text}`).toBe(200);
  return (JSON.parse(text) as { token: string }).token;
};

/**
 * 设备授权换来的 Bearer 令牌（`/auth/device/code` → 登录的人认领并批准 → `/auth/device/token`）：
 * 命令行就是这么登录的，7 天有效。守卫必须按用户会话判它。
 */
const deviceTokenFor = async (
  testApp: SignInTarget,
  session: TestSession,
): Promise<string> => {
  const base = `http://localhost${testApp.publicBasePath}/api/auth/device`;
  const codeResponse = await testApp.fetch(
    new Request(`${base}/code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: 'nocobase-cli' }),
    }),
  );
  const codeText = await codeResponse.text();
  expect(codeResponse.status, `${codeText}`).toBe(200);
  const code = JSON.parse(codeText) as {
    device_code: string;
    user_code: string;
  };
  // 先由登录的人认领这个代码，再批准（设备授权的两步都是这样）。
  const claimed = await testApp.fetch(
    new Request(`${base}?user_code=${encodeURIComponent(code.user_code)}`, {
      headers: { cookie: session.cookie },
    }),
  );
  expect(claimed.status, `${await claimed.clone().text()}`).toBe(200);
  const approved = await testApp.fetch(
    new Request(`${base}/approve`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://localhost',
        cookie: session.cookie,
      },
      body: JSON.stringify({ userCode: code.user_code }),
    }),
  );
  expect(approved.status, `${await approved.clone().text()}`).toBe(200);
  const tokenResponse = await testApp.fetch(
    new Request(`${base}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: code.device_code,
        client_id: 'nocobase-cli',
      }),
    }),
  );
  const tokenText = await tokenResponse.text();
  expect(tokenResponse.status, `${tokenText}`).toBe(200);
  return (JSON.parse(tokenText) as { access_token: string }).access_token;
};

/** 一台机器自己的请求：runner key 走 `x-nocobase-runner-key`。 */
const runnerRequest = (
  testApp: { request: (path: string, init?: RequestInit) => Promise<Response> },
  path: string,
  init: RequestInit,
): Promise<Response> => testApp.request(path, init);

test('R-045 1: a signed-in user with no AI grant gets 403 AI_ACCESS_REQUIRED on every person endpoint', async ({
  testApp,
  app,
  connection,
}) => {
  const { nobody, admin } = await setupIdentities(testApp, app, 'e1');
  const agentId = 'r045-e1-agent';
  await createAgent(connection, agentId, admin.user.id);
  const ownRunner = await createRunner(app, nobody.id, 'r045-e1-runner');
  const endpoints: readonly [string, string, RequestInit | undefined][] = [
    ['GET', '/agents', undefined],
    ['GET', `/agents/${agentId}`, undefined],
    ['GET', '/agents/agentNames', undefined],
    ['GET', '/agents/vocabulary', undefined],
    ['GET', '/agents/models?kind=chat', undefined],
    ['GET', '/agents/chatSettings', undefined],
    ['GET', '/agents/chatAgents', undefined],
    ['GET', '/agents/available', undefined],
    ['GET', '/agents/runs', undefined],
    ['GET', '/agents/runRequests', undefined],
    ['GET', '/agents/conversations', undefined],
    ['GET', '/agents/runners', undefined],
    ['GET', '/agents/runners/registrationTokens', undefined],
    ['POST', '/agents/conversations', json({})],
    ['POST', '/agents/runners/registrationTokens', json({})],
    [
      'PATCH',
      `/agents/runners/${ownRunner.runnerId}`,
      json({ trust: 'team' }, 'PATCH'),
    ],
  ];
  for (const [method, path, init] of endpoints) {
    await expectGuardDenial(
      await nobody.session.fetch(path, init),
      'AI_ACCESS_REQUIRED',
      `${method} /api${path}（没有任何 AI 授权）`,
    );
  }
  // 没登录照旧 401：守卫不该把「没登录」改成 403。三条规则的入口各钉一次。
  const anonymous = await testApp.request('/agents');
  expect(anonymous.status, '匿名 GET /api/agents 应当是 401').toBe(401);
  expect(((await anonymous.json()) as ApiErrorBody).error.reason).toBe(
    'AUTHENTICATION_REQUIRED',
  );
  for (const [method, path, init] of [
    ['POST', '/agents/runners/registrationTokens', json({})],
    [
      'PATCH',
      `/agents/runners/${ownRunner.runnerId}`,
      json({ trust: 'team' }, 'PATCH'),
    ],
  ] as const) {
    const refused = await testApp.request(path, init as RequestInit);
    expect(refused.status, `匿名 ${method} /api${path} 应当是 401`).toBe(401);
    expect(
      ((await refused.json()) as ApiErrorBody).error.reason,
      `匿名 ${method} /api${path} 的原因码`,
    ).toBe('AUTHENTICATION_REQUIRED');
  }
});

test('R-045 2: holding one AI grant passes the baseline, and only the baseline', async ({
  testApp,
  app,
  connection,
}) => {
  const { pageReader, runnerManager, admin } = await setupIdentities(
    testApp,
    app,
    'e2',
  );
  const agentId = 'r045-e2-agent';
  await createAgent(connection, agentId, admin.user.id);

  const list = await pageReader.session.fetch('/agents');
  expect(list.status, `${await list.clone().text()}`).toBe(200);
  expect(Array.isArray(((await list.json()) as { data: unknown[] }).data)).toBe(
    true,
  );
  expect((await pageReader.session.fetch('/agents/chatAgents')).status).toBe(
    200,
  );

  // 一项设置项授权也算「持一项」：底线放行，之后是该接口自己的检查。
  expect((await runnerManager.session.fetch('/agents')).status).toBe(200);

  // 只持页面 access 仍然改不动 agent：这是框架自己的检查，不是守卫的原因码。
  const editAgent = await pageReader.session.fetch(
    `/agents/${agentId}`,
    json({ description: 'changed by a page reader' }, 'PATCH'),
  );
  const editError = await expectError(editAgent, 403);
  expect(editError.reason, '改 agent 应当还是框架的 FORBIDDEN').toBe(
    'FORBIDDEN',
  );
  expect(
    ['AI_ACCESS_REQUIRED', 'RUNNER_TRUST_FORBIDDEN'].includes(editError.reason),
    '改 agent 不该被守卫拦',
  ).toBe(false);
});

test('R-045 3: root keeps every management endpoint', async ({
  testApp,
  connection,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const agentId = 'r045-e3-agent';
  await createAgent(connection, agentId, admin.user.id);

  const list = await expectJson(await admin.fetch('/agents'), 200);
  expect(
    (list as { data: { id: string }[] }).data.some(
      (agent) => agent.id === agentId,
    ),
  ).toBe(true);
  const single = await expectJson(await admin.fetch(`/agents/${agentId}`), 200);
  expect((single as { data: { id: string } }).data.id).toBe(agentId);
  expect((await admin.fetch('/agents/models?kind=chat')).status).toBe(200);
  expect((await admin.fetch('/agents/services')).status).toBe(200);
  expect((await admin.fetch('/agents/runners')).status).toBe(200);
  const createdToken = await expectJson(
    await admin.fetch('/agents/runners/registrationTokens', json({})),
    201,
  );
  expect(
    (createdToken as { data: { token: string } }).data.token,
    'root 发令牌的响应应当带一次性令牌',
  ).toMatch(/^[A-Za-z0-9_-]+$/);
});

test('R-045 4: issuing a registration token needs agents.runners manage and leaves no row behind', async ({
  testApp,
  app,
  connection,
}) => {
  const { pageReader, runnerManager } = await setupIdentities(
    testApp,
    app,
    'e4',
  );
  const tokens = connection.repository('agRegistrationTokens');
  const rowsOf = (userId: string) =>
    tokens.count({ filter: { createdById: userId } });

  expect(await rowsOf(pageReader.id), '起点该是 0 行').toBe(0);
  await expectGuardDenial(
    await pageReader.session.fetch(
      '/agents/runners/registrationTokens',
      json({}),
    ),
    'RUNNER_REGISTRATION_FORBIDDEN',
    'POST /api/agents/runners/registrationTokens（只持页面 agents）',
  );
  expect(await rowsOf(pageReader.id), '被拒之后库里不该多出令牌行').toBe(0);

  const created = await expectJson(
    await runnerManager.session.fetch(
      '/agents/runners/registrationTokens',
      json({}),
    ),
    201,
  );
  expect((created as { data: { token: string } }).data.token).toBeTruthy();
  expect(await rowsOf(runnerManager.id), '持 manage 的人应当建出令牌').toBe(1);
});

test('R-045 5: making a runner team needs agents.runners manage; other edits stay with the owner', async ({
  testApp,
  app,
  connection,
}) => {
  const { pageReader, runnerManager } = await setupIdentities(
    testApp,
    app,
    'e5',
  );
  const own = await createRunner(app, pageReader.id, 'r045-e5-runner');
  const runners = connection.repository('agRunners');
  const trustOf = async (runnerId: string): Promise<string> =>
    String((await runners.findOne({ filter: { id: runnerId } }))?.trust);

  expect(await trustOf(own.runnerId), '注册出来的机器是「只跑本人的活」').toBe(
    'ownerOnly',
  );
  // 这条就是调研源码推出的越权路径：主人可以把机器改成「团队」，进入接所有人活的池子。
  await expectGuardDenial(
    await pageReader.session.fetch(
      `/agents/runners/${own.runnerId}`,
      json({ trust: 'team' }, 'PATCH'),
    ),
    'RUNNER_TRUST_FORBIDDEN',
    'PATCH /api/agents/runners/:id { trust: team }（只持页面 agents）',
  );
  expect(await trustOf(own.runnerId), '被拒之后库里的信任级别不该变').toBe(
    'ownerOnly',
  );

  // 改名称、槽位，或改回「只跑本人的活」，仍是主人的事。
  const renamed = await pageReader.session.fetch(
    `/agents/runners/${own.runnerId}`,
    json({ name: 'r045-e5-renamed' }, 'PATCH'),
  );
  expect(renamed.status, `${await renamed.clone().text()}`).toBe(200);
  const slots = await pageReader.session.fetch(
    `/agents/runners/${own.runnerId}`,
    json({ slots: 4 }, 'PATCH'),
  );
  expect(slots.status, `${await slots.clone().text()}`).toBe(200);
  const backToOwnerOnly = await pageReader.session.fetch(
    `/agents/runners/${own.runnerId}`,
    json({ trust: 'ownerOnly' }, 'PATCH'),
  );
  await expectStatus(backToOwnerOnly, 200);

  // 持 manage 的人对自己的机器改成团队：放行，并且真的写进库。
  const managed = await createRunner(app, runnerManager.id, 'r045-e5-managed');
  const toTeam = await runnerManager.session.fetch(
    `/agents/runners/${managed.runnerId}`,
    json({ trust: 'team' }, 'PATCH'),
  );
  expect(toTeam.status, `${await toTeam.clone().text()}`).toBe(200);
  expect(await trustOf(managed.runnerId)).toBe('team');
});

test('R-045 6: the runner and run channels are untouched; a request with both credentials counts as a session', async ({
  testApp,
  app,
}) => {
  // 公开的安装脚本：匿名可取。
  const script = await testApp.request('/agents/dist/installScript');
  const scriptText = await script.text();
  expect(script.status, `${scriptText.slice(0, 200)}`).toBe(200);
  expect(scriptText).toContain('#!/bin/sh');

  // 注册令牌换 runner key：匿名、只凭令牌。
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const created = await expectJson(
    await admin.fetch('/agents/runners/registrationTokens', json({})),
    201,
  );
  const registrationToken = (created as { data: { token: string } }).data.token;
  const register = await testApp.request(
    '/agents/runners/register',
    json({
      registrationToken,
      name: 'r045-e6-runner',
      hostname: 'r045-e6-host',
      os: 'linux',
      arch: 'x64',
      version: '0.0.0-r045',
      protocolVersion: RUNNER_PROTOCOL_VERSION,
      features: [],
      tools: [],
    }),
  );
  const registerText = await register.text();
  expect(register.status, `${registerText.slice(0, 300)}`).toBe(200);
  const runnerKey = (
    JSON.parse(registerText) as { data: { runnerKey: string } }
  ).data.runnerKey;

  // runner key 心跳与领活。
  const heartbeat = await runnerRequest(testApp, '/agents/runners/heartbeat', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'http://localhost',
      'x-nocobase-runner-key': runnerKey,
      'x-nocobase-protocol': String(RUNNER_PROTOCOL_VERSION),
    },
    body: JSON.stringify({
      version: '0.0.0-r045',
      features: [],
      tools: [],
      active: [],
      load: { slots: 3, free: 3 },
    }),
  });
  const heartbeatText = await heartbeat.text();
  expect(heartbeat.status, `${heartbeatText.slice(0, 300)}`).toBe(200);
  const claim = await runnerRequest(testApp, '/agents/runners/claim', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'http://localhost',
      'x-nocobase-runner-key': runnerKey,
      'x-nocobase-protocol': String(RUNNER_PROTOCOL_VERSION),
    },
    body: JSON.stringify({ free: 1 }),
  });
  const claimText = await claim.text();
  expect(claim.status, `${claimText.slice(0, 300)}`).toBe(200);
  expect(
    Array.isArray(
      (JSON.parse(claimText) as { data: { runs: unknown[] } }).data.runs,
    ),
  ).toBe(true);

  // 运行令牌：守卫不该拦，交给框架自己的凭据检查。伪造的令牌得到框架自己的 401
  // `RUN_TOKEN_INVALID`（不是守卫的 403 `AI_ACCESS_REQUIRED`）——这一条只做到「没被
  // 守卫拒」：真实的 run token 要在测试里造出来得有在线机器、模型与启用的 agent，这里
  // 造不出，没有把它写成验过。
  const runToken = await testApp.request('/agents/runs/current', {
    method: 'GET',
    headers: { 'x-nocobase-run-token': 'fgr_r045-not-a-real-token' },
  });
  const runTokenText = await runToken.clone().text();
  expect(runToken.status, `${runTokenText}`).toBe(401);
  const runTokenError = (JSON.parse(runTokenText) as ApiErrorBody).error;
  expect(runTokenError.reason, '运行令牌路径应当落到框架自己的检查').toBe(
    'RUN_TOKEN_INVALID',
  );

  // 同时带 cookie 与机器凭据：按用户会话算，所以没授权的人被守卫拦。
  // 这台机器与这份心跳是有效的：不加守卫时它会被当作机器请求照常 200（下面先钉住这一点）。
  const { nobody } = await setupIdentities(testApp, app, 'e6');
  const heartbeatBody = JSON.stringify({
    version: '0.0.0-r045',
    features: [],
    tools: [],
    active: [],
    load: { slots: 3, free: 3 },
  });
  const asMachine = await runnerRequest(testApp, '/agents/runners/heartbeat', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'http://localhost',
      'x-nocobase-runner-key': runnerKey,
      'x-nocobase-protocol': String(RUNNER_PROTOCOL_VERSION),
    },
    body: heartbeatBody,
  });
  expect(asMachine.status, 'runner key 一个都不带 cookie 时是机器').toBe(200);
  await expectGuardDenial(
    await nobody.session.fetch('/agents/runners/heartbeat', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-nocobase-runner-key': runnerKey,
        'x-nocobase-protocol': String(RUNNER_PROTOCOL_VERSION),
      },
      body: heartbeatBody,
    }),
    'AI_ACCESS_REQUIRED',
    'cookie + runner key 同时存在时按会话判',
  );
});

test('R-045 8: path variants are judged the same, and a refused write leaves the database unchanged', async ({
  testApp,
  app,
  connection,
}) => {
  const { nobody } = await setupIdentities(testApp, app, 'e8');
  const raw = (path: string, init: RequestInit = {}): Promise<Response> =>
    testApp.fetch(
      new Request(`http://localhost${testApp.publicBasePath}${path}`, {
        ...init,
        headers: {
          ...(init.headers as Record<string, string> | undefined),
          cookie: nobody.session.cookie,
        },
      }),
    );

  // 不带尾斜杠、多一个斜杠、点段、查询串：同一个判法。
  for (const [label, path, init] of [
    ['不带尾斜杠', '/api/agents', {}],
    ['多一个尾斜杠', '/api/agents/', {}],
    ['双斜杠', '/api/agents//agentNames', {}],
    ['点段', '/api/agents/./agentNames', {}],
    ['查询串里带路径', '/api/agents/agentNames?next=/agents/agentNames', {}],
    [
      '写接口的双斜杠',
      '/api/agents//conversations',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'http://localhost',
        },
        body: JSON.stringify({}),
      },
    ],
  ] as const) {
    await expectGuardDenial(
      await raw(path, init as RequestInit),
      'AI_ACCESS_REQUIRED',
      `${label}：${path}`,
    );
  }

  // 被拒的请求不落到框架的处理器上：会话表里没有多出这个人的行。
  expect(
    await connection.repository('agConversations').count(),
    '被拒的写请求不该在库里留下会话',
  ).toBe(0);

  // 前缀之外不受影响：`/api/agentsx` 不是 `/api/agents` 这一段。
  const outside = await raw('/api/agentsx');
  expect(outside.status).toBe(404);
});

test('R-045: 会话令牌走 Authorization: Bearer 时判法相同（含设备授权换来的令牌）', async ({
  testApp,
  app,
}) => {
  const { nobody, pageReader } = await setupIdentities(testApp, app, 'b1');
  const ownRunner = await createRunner(app, nobody.id, 'r045-b1-runner');
  const pageRunner = await createRunner(
    app,
    pageReader.id,
    'r045-b1-page-runner',
  );

  const bearer = (
    token: string,
    path: string,
    init: RequestInit = {},
  ): Promise<Response> =>
    testApp.fetch(
      new Request(`http://localhost${testApp.publicBasePath}/api${path}`, {
        ...init,
        headers: {
          ...(init.headers as Record<string, string> | undefined),
          authorization: `Bearer ${token}`,
        },
      }),
    );

  // 没有 AI 授权的人：三条规则入口与带 cookie 时同样被拒，原因码相同。
  const noAiToken = await sessionTokenOf(testApp, nobody.username);
  for (const [method, path, init] of [
    ['GET', '/agents', undefined],
    ['POST', '/agents/runners/registrationTokens', json({})],
    [
      'PATCH',
      `/agents/runners/${ownRunner.runnerId}`,
      json({ trust: 'team' }, 'PATCH'),
    ],
  ] as const) {
    await expectGuardDenial(
      await bearer(noAiToken, path, init as RequestInit),
      'AI_ACCESS_REQUIRED',
      `Bearer：${method} /api${path}（没有任何 AI 授权）`,
    );
  }

  // 只持页面 agents：底线放行，规则 2、3 仍然被拒。
  const pageToken = await sessionTokenOf(testApp, pageReader.username);
  const list = await bearer(pageToken, '/agents');
  expect(list.status, `${await list.clone().text()}`).toBe(200);
  await expectGuardDenial(
    await bearer(pageToken, '/agents/runners/registrationTokens', json({})),
    'RUNNER_REGISTRATION_FORBIDDEN',
    'Bearer：POST /api/agents/runners/registrationTokens（只持页面 agents）',
  );
  await expectGuardDenial(
    await bearer(
      pageToken,
      `/agents/runners/${pageRunner.runnerId}`,
      json({ trust: 'team' }, 'PATCH'),
    ),
    'RUNNER_TRUST_FORBIDDEN',
    'Bearer：PATCH /api/agents/runners/:id { trust: team }（只持页面 agents）',
  );

  // 设备授权换来的令牌（7 天有效）同样是人的会话。
  const deviceToken = await deviceTokenFor(testApp, nobody.session);
  await expectGuardDenial(
    await bearer(deviceToken, '/agents'),
    'AI_ACCESS_REQUIRED',
    '设备授权令牌：GET /api/agents（没有任何 AI 授权）',
  );

  // 认不出的 Bearer：不放行（放行等于把「认证在我们之后才认出它」的情形漏掉）。
  await expectGuardDenial(
    await bearer('r045-not-a-session-token', '/agents'),
    'AI_ACCESS_REQUIRED',
    '认不出的 Bearer：GET /api/agents',
  );

  // root 带 Bearer 照常。
  const rootToken = await sessionTokenOf(
    testApp,
    DEFAULT_ADMIN_CREDENTIALS.username,
    DEFAULT_ADMIN_CREDENTIALS.password,
  );
  expect((await bearer(rootToken, '/agents')).status).toBe(200);
  expect(
    (await bearer(rootToken, '/agents/runners/registrationTokens', json({})))
      .status,
  ).toBe(201);
});
