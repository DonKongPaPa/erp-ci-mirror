import {
  authenticationToken,
  userAdministrationServiceToken,
  type AdministratedUser,
  type AuthEnv,
} from '@nocobase/app-plugin-authentication';
import {
  requireSignInSession,
  scopedApiKeysToken,
  toApiKeysApiError,
} from '@nocobase/app-plugin-api-keys/server';
import {
  authorizationToken,
  type AuthorizationEnv,
} from '@nocobase/app-plugin-authorization/server';
import type {
  PermissionSet,
  PermissionSetsApi,
} from '@nocobase/authorization/permission-sets';
import type { Application } from '@nocobase/app-server/application';
import {
  ApiError,
  apiErrorHandler,
  apiErrorResponse,
  apiValidator,
  dataResponse,
  defineApiRoutes,
  describeRoute,
  emptyResponse,
  executeIdempotentMutation,
  listResponse,
  mutationDigest,
  mutationReceiptCollection,
  mutationRetryWindowMs,
  repositoryIdempotencyToken,
  type AppApiRouteContribution,
} from '@nocobase/app-server/router';
import { databaseManagerToken, type DatabaseConnection } from '@nocobase/db';
import { Hono, type Context } from 'hono';

import {
  ApplicationApiKeySchema,
  CreateServiceAccountBody,
  CreatedApplicationApiKeySchema,
  IssueApplicationApiKeyBody,
  ReplaceServiceAccountRolesBody,
  ServiceAccountRolesSchema,
  ServiceAccountSchema,
} from './schemas.js';

/**
 * R-032「应用 API 密钥」的六个服务端端点。
 *
 * 插件能在服务端给任意用户签发密钥，但没有「给别人的服务账号签发」的 HTTP 接口，
 * 所以这一组由应用自己写。三条规矩：
 *
 * 1. 只认登录会话，逐个请求核对页面授权 `application.api-keys`（照质量端点的顺序：
 *    先登录、再授权、最后碰请求体）。
 * 2. 应用密钥代表服务账号，不代表签发它的管理员：签发时显式指定目标 userId，
 *    目标不是服务账号就 404，一把密钥都不建。
 * 3. 明文只在签发与轮换的响应里出现一次；列表永远不带，也不写日志。幂等重放
 *    不再带明文（明文不落收据表），丢了的密钥只能轮换。
 */

const DOMAIN = 'applicationApiKeys';
/** 页面授权资源。它不进任何角色的 seed，所以默认只有 root 能进。 */
const PAGE_ACCESS = {
  resource: { type: 'page', id: 'application.api-keys' },
  action: 'access',
} as const;

const accountNotFound = (userId: string): ApiError =>
  new ApiError({
    status: 'NOT_FOUND',
    reason: 'SERVICE_ACCOUNT_NOT_FOUND',
    domain: DOMAIN,
    message: `Service account ${userId} was not found.`,
  });

/** 响应里的服务账号：标识、名称、是否已停用。 */
function accountView(user: AdministratedUser) {
  return {
    id: user.id,
    name: user.name,
    disabledAt: user.disabledAt,
  };
}

/**
 * 响应里的权限集：只回标识与名称。名称照库里存的形状给（字符串或 `{ key, ns }`），
 * 由页面按自己的语言翻译，服务端不猜用户的语言。
 */
interface ServiceAccountRoleView {
  key: string;
  title: string | { readonly key: string; readonly ns: string } | null;
}

function roleView(set: PermissionSet): ServiceAccountRoleView {
  return {
    key: set.key,
    title: set.title ?? null,
  };
}

/**
 * 一次幂等写的结果。`data` 是收据里的那份、重放时原样返回；`live` 只属于实际
 * 执行了这一次调用的请求（签发与轮换的明文），重放与并发输家一律是 `undefined`。
 * 明文不进收据，也就不会从重放里被带出来 —— 由这个结构保证，调用处不用自己清变量。
 */
interface RecordedOnce<T, TLive> {
  data: T;
  replayed: boolean;
  live: TLive | undefined;
}

/** `execute` 交回的两部分：进收据的结果，与只回给这一次调用的字段。 */
interface ExecutedOnce<T, TLive> {
  /** 进收据、重放时原样返回的部分；不得含明文。 */
  data: T;
  /** 只回给这一次调用的部分，例如明文。 */
  live?: TLive;
}

/**
 * 轮换同一把密钥的进程内互斥：以 `(userId, keyId)` 为键，把整个 `recordOnce` 串起来。
 * 同一个幂等键的并发请求因此只有第一个真的轮换，其余读到收据、按重放答复。
 *
 * 只在本进程内有效：多实例部署时两个实例仍可能同时轮换同一把密钥（各自换一次、
 * 后写的覆盖先写的），那时要换成数据库级的锁。这一条写进交付说明。
 */
const rotationLocks = new Map<string, Promise<void>>();

const serializeRotation = async <T>(
  userId: string,
  keyId: string,
  run: () => Promise<T>,
): Promise<T> => {
  const lockKey = `${userId}:${keyId}`;
  const previous = rotationLocks.get(lockKey) ?? Promise.resolve();
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => released);
  rotationLocks.set(lockKey, tail);
  await previous;
  try {
    return await run();
  } finally {
    release();
    // 只有排在最后的那一个负责清掉这条记录；前面的还在等它的下一次调用。
    if (rotationLocks.get(lockKey) === tail) rotationLocks.delete(lockKey);
  }
};

export const apiRoutes: AppApiRouteContribution<Application> = defineApiRoutes(
  (app) => {
    const routes = new Hono<AuthEnv & AuthorizationEnv>();
    const auth = app.container.resolve(authenticationToken);
    const authz = app.container.resolve(authorizationToken);
    const users = app.container.resolve(userAdministrationServiceToken);
    const keys = app.container.resolve(scopedApiKeysToken);
    const database = app.container.resolve(databaseManagerToken);

    routes.onError((error, context) =>
      apiErrorHandler(toApiKeysApiError(error), context),
    );

    // 管理密钥只能从登录会话发起：任何密钥（含服务账号的）调这里一律被拒。
    routes.use(
      '/application-api-keys',
      auth.required(),
      requireSignInSession(),
      authz.middleware(),
    );
    routes.use(
      '/application-api-keys/*',
      auth.required(),
      requireSignInSession(),
      authz.middleware(),
    );
    // 逐个请求核对页面授权。先授权再读入参，被拒的人拿不到参数校验的细节。
    routes.use('/application-api-keys', async (context, next) => {
      await context.get('authz').require(PAGE_ACCESS);
      await next();
    });
    routes.use('/application-api-keys/*', async (context, next) => {
      await context.get('authz').require(PAGE_ACCESS);
      await next();
    });

    const requireServiceAccount = async (
      userId: string,
    ): Promise<AdministratedUser> => {
      const user = await users.get(userId);
      if (!user || user.kind !== 'service') {
        throw accountNotFound(userId);
      }
      return user;
    };

    /**
     * 这一页能给服务账号的权限集：不含 root，也不含任何不受限制的权限集。
     * 「不受限制」不认死键名，读授权插件的保护声明（root 集由它声明）；同时尊重
     * 保护声明里的可分配主体类型，不给出分配时会立刻被拒的选项。
     */
    const assignableRole = (key: string): boolean => {
      const protection = authz.permissionSets.protection(key);
      if (!protection) return true;
      if (protection.unrestricted) return false;
      return (
        protection.assignableTo === undefined ||
        protection.assignableTo.includes('user')
      );
    };

    /** 请求体里出现了给不出去的权限集：整个替换都不做。 */
    const roleNotAssignable = (key: string): ApiError =>
      new ApiError({
        status: 'FAILED_PRECONDITION',
        httpStatus: 422,
        reason: 'PERMISSION_SET_NOT_ASSIGNABLE',
        domain: DOMAIN,
        message: `Permission Set ${key} cannot be given to a service account.`,
      });

    /** 服务账号持有的权限集（直接分配给它的，不含 authenticated 的公共授予）。 */
    const rolesOf = async (
      permissionSets: PermissionSetsApi<DatabaseConnection>,
      userId: string,
    ): Promise<ServiceAccountRoleView[]> => {
      const sets = await permissionSets.getEffective({
        principal: { type: 'user', id: userId },
      });
      return sets.map(roleView).sort((a, b) => a.key.localeCompare(b.key));
    };

    /** 可以给它的权限集清单，由服务端给，页面不自己拼。 */
    const roleOptionsOf = async (
      permissionSets: PermissionSetsApi<DatabaseConnection>,
    ): Promise<ServiceAccountRoleView[]> => {
      const sets = await permissionSets.list();
      return sets
        .filter((set) => assignableRole(set.key))
        .map(roleView)
        .sort((a, b) => a.key.localeCompare(b.key));
    };

    /**
     * 建服务账号：收据与业务写在同一个事务里。
     *
     * 用户服务可以绑定到外部事务（`withConnection`），照 users 端点的写法。
     * 密钥服务不能这样绑，所以签发、轮换、吊销走下面的 `recordOnce`。
     */
    const protection = app.container.resolve(repositoryIdempotencyToken);

    const idempotentOnce = async <T>(
      context: Context<AuthEnv & AuthorizationEnv>,
      input: unknown,
      execute: (transaction: DatabaseConnection) => Promise<T>,
    ): Promise<{ data: T; replayed: boolean }> => {
      const key = context.req.header('Idempotency-Key');
      if (!key) {
        throw new ApiError({
          status: 'INVALID_ARGUMENT',
          reason: 'OPERATION_KEY_REQUIRED',
          domain: DOMAIN,
          message:
            'Application API key writes require an Idempotency-Key header.',
        });
      }
      const principal = await protection.principal(context);
      if (!principal) {
        throw new ApiError({
          status: 'PERMISSION_DENIED',
          reason: 'PRINCIPAL_REQUIRED',
          domain: DOMAIN,
          message: 'An authenticated principal is required.',
        });
      }
      return executeIdempotentMutation({
        connection: database.connection(),
        key,
        principal,
        operation: `${context.req.method} ${new URL(context.req.url).pathname}`,
        input,
        // 中间件已经逐个请求核对过页面授权，重放同样经过它。
        authorize: () => undefined,
        authorizeReplay: () => undefined,
        execute,
      });
    };

    /**
     * 密钥的签发、轮换、吊销走这里：先查收据，命中就按第一次的结果答复；没命中才
     * 调密钥服务，成功后记一条收据。密钥服务写自己的连接，收据写主连接，两者不能
     * 放进同一个事务（SQLite 的连接池只有一个连接，会互相等）。
     *
     * `execute` 把「进收据的结果」与「只回给这一次调用的明文」分开交；收据里不含
     * 明文，重放也就带不出明文。并发请求可能都未命中收据而各签一把：唯一键冲突时
     * 后到的一方读回先到的结果，并吊销自己多签的那把。收据因为别的原因没写成时，
     * 刚签出（或刚轮换出）的密钥同样吊销，再抛出原来的错误 —— 不能让库里留下一把
     * 调用方没拿到明文的有效密钥。
     */
    const recordOnce = async <T, TLive = never>(
      context: Context<AuthEnv & AuthorizationEnv>,
      input: unknown,
      execute: () => Promise<ExecutedOnce<T, TLive>>,
      discard?: (data: T) => Promise<void>,
    ): Promise<RecordedOnce<T, TLive>> => {
      const key = context.req.header('Idempotency-Key');
      if (!key) {
        throw new ApiError({
          status: 'INVALID_ARGUMENT',
          reason: 'OPERATION_KEY_REQUIRED',
          domain: DOMAIN,
          message:
            'Application API key writes require an Idempotency-Key header.',
        });
      }
      const principal = await protection.principal(context);
      if (!principal) {
        throw new ApiError({
          status: 'PERMISSION_DENIED',
          reason: 'PRINCIPAL_REQUIRED',
          domain: DOMAIN,
          message: 'An authenticated principal is required.',
        });
      }
      const connection = database.connection();
      const operation = `${context.req.method} ${new URL(context.req.url).pathname}`;
      const id = mutationDigest([principal, operation, key]);
      const digest = mutationDigest(input);
      type ReceiptRow = { digest: string; result: unknown };
      const read = async (): Promise<ReceiptRow | undefined> =>
        await connection.query
          .selectFrom(mutationReceiptCollection)
          .selectAll()
          .where('id', '=', id)
          .executeTakeFirst<ReceiptRow>();
      const replay = async (
        row: ReceiptRow,
      ): Promise<RecordedOnce<T, TLive>> => {
        if (row.digest !== digest) {
          throw new ApiError({
            status: 'ALREADY_EXISTS',
            reason: 'OPERATION_CONFLICT',
            domain: DOMAIN,
            message: 'This operation key belongs to a different request.',
          });
        }
        return {
          data: (typeof row.result === 'string'
            ? JSON.parse(row.result)
            : row.result) as T,
          replayed: true,
          live: undefined,
        };
      };

      const existing = await read();
      if (existing) return replay(existing);

      const { data, live } = await execute();
      try {
        await connection.query
          .insertInto(mutationReceiptCollection)
          .values({
            id,
            digest,
            result: JSON.stringify(data),
            expiresAt: new Date(Date.now() + mutationRetryWindowMs),
          })
          .execute();
      } catch (error) {
        let winner: ReceiptRow | undefined;
        try {
          winner = await read();
        } catch {
          // 连收据都读不回来也要吊销：不能留下调用方没拿到明文的有效密钥。
        }
        // 收据没写成，这次调用拿到的明文就不能留在库里。唯一键冲突时赢家的收据
        // 已经写进去了，按重放答复；其它原因没有赢家，吊销后抛出原来的错误。
        await discard?.(data);
        if (winner) return replay(winner);
        throw error;
      }
      return { data, replayed: false, live };
    };

    routes.get(
      '/application-api-keys/accounts',
      describeRoute({
        tags: ['ApiKeys'],
        summary: 'List service accounts',
        operationId: 'applicationApiKeysListAccounts',
        responses: {
          '200': listResponse(ServiceAccountSchema),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '500': apiErrorResponse(500),
        },
      }),
      async (context) => {
        const page = await users.list({ kind: 'service', pageSize: 100 });
        return context.json({
          data: page.items.map(accountView),
          meta: { total: page.total },
        });
      },
    );

    routes.post(
      '/application-api-keys/accounts',
      describeRoute({
        tags: ['ApiKeys'],
        summary: 'Create a service account',
        operationId: 'applicationApiKeysCreateAccount',
        responses: {
          '201': dataResponse(ServiceAccountSchema),
          '400': apiErrorResponse(400),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('json', CreateServiceAccountBody),
      async (context) => {
        const body = context.req.valid('json');
        const result = await idempotentOnce(
          context,
          body,
          async (transaction) => {
            const created = await users
              .withConnection(transaction)
              .createServiceAccount({ name: body.name });
            return accountView(created);
          },
        );
        context.header('Idempotency-Replayed', String(result.replayed));
        return context.json({ data: result.data }, 201);
      },
    );

    routes.get(
      '/application-api-keys/accounts/:userId/roles',
      describeRoute({
        tags: ['ApiKeys'],
        summary: "List a service account's roles and the roles it may be given",
        operationId: 'applicationApiKeysListAccountRoles',
        description:
          'The Permission Sets assigned to the service account, and the ones this page may assign. The root set and any other unrestricted set is never among the options.',
        responses: {
          '200': dataResponse(ServiceAccountRolesSchema),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '404': apiErrorResponse(404),
          '500': apiErrorResponse(500),
        },
      }),
      async (context) => {
        const userId = context.req.param('userId');
        await requireServiceAccount(userId);
        const [roles, options] = await Promise.all([
          rolesOf(authz.permissionSets, userId),
          roleOptionsOf(authz.permissionSets),
        ]);
        return context.json({ data: { roles, options } });
      },
    );

    routes.put(
      '/application-api-keys/accounts/:userId/roles',
      describeRoute({
        tags: ['ApiKeys'],
        summary: "Replace a service account's roles",
        operationId: 'applicationApiKeysReplaceAccountRoles',
        description:
          'Replaces every Permission Set the service account holds; an empty list removes them all. Keys already issued to it act with the new roles at once. The root set and any other unrestricted set answer 422 and change nothing.',
        responses: {
          '200': dataResponse(ServiceAccountRolesSchema),
          '400': apiErrorResponse(400),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '404': apiErrorResponse(404),
          '422': {
            // 422 不在框架的标准状态表里，照 dev-account-switcher 的写法显式声明。
            description:
              'The list names the root Permission Set or another unrestricted set (`PERMISSION_SET_NOT_ASSIGNABLE`); nothing was changed.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ApiErrorBody' },
              },
            },
          },
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('json', ReplaceServiceAccountRolesBody),
      async (context) => {
        const userId = context.req.param('userId');
        const body = context.req.valid('json');
        await requireServiceAccount(userId);

        const all = await authz.permissionSets.list();
        const known = new Set(all.map((set) => set.key));
        const keys = [...new Set(body.keys)].sort();
        // 先整份校验，再写：清单里有一个给不出去的，整个替换都不做。
        for (const key of keys) {
          if (!known.has(key) || !assignableRole(key)) {
            throw roleNotAssignable(key);
          }
        }

        const result = await idempotentOnce(
          context,
          body,
          async (transaction) => {
            const bound = authz.permissionSets.withTransaction(transaction);
            await bound.replaceSubjectAssignments({
              subject: { type: 'user', id: userId },
              // 整体替换：不在入参里的权限集从这个服务账号身上撤掉。
              managedPermissionSets: all.map((set) => set.key),
              permissionSets: keys,
            });
            return {
              roles: await rolesOf(bound, userId),
              options: await roleOptionsOf(bound),
            };
          },
        );
        context.header('Idempotency-Replayed', String(result.replayed));
        return context.json({ data: result.data });
      },
    );

    routes.get(
      '/application-api-keys/accounts/:userId/keys',
      describeRoute({
        tags: ['ApiKeys'],
        summary: "List a service account's API keys",
        operationId: 'applicationApiKeysListKeys',
        description: 'Never returns a key secret.',
        responses: {
          '200': listResponse(ApplicationApiKeySchema),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '404': apiErrorResponse(404),
          '500': apiErrorResponse(500),
        },
      }),
      async (context) => {
        const userId = context.req.param('userId');
        await requireServiceAccount(userId);
        const data = await keys.list(userId);
        return context.json({ data, meta: { total: data.length } });
      },
    );

    routes.post(
      '/application-api-keys/accounts/:userId/keys',
      describeRoute({
        tags: ['ApiKeys'],
        summary: "Issue a service account's API key",
        operationId: 'applicationApiKeysIssueKey',
        description:
          'The key expires within 1 to 365 days. The secret is in this response only; a replay of the same Idempotency-Key omits it.',
        responses: {
          '201': dataResponse(CreatedApplicationApiKeySchema),
          '400': apiErrorResponse(400),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '404': apiErrorResponse(404),
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('json', IssueApplicationApiKeyBody),
      async (context) => {
        const userId = context.req.param('userId');
        const body = context.req.valid('json');
        await requireServiceAccount(userId);

        const result = await recordOnce(
          context,
          body,
          async () => {
            const checked = await keys.check(
              body,
              await keys.identityOf(userId),
            );
            const created = await keys.issueChecked(userId, checked);
            return { data: created.key, live: created.secret };
          },
          async (key) => keys.revoke(userId, key.id),
        );
        context.header('Idempotency-Replayed', String(result.replayed));
        context.header('Cache-Control', 'no-store');
        return context.json(
          {
            data: {
              key: result.data,
              ...(result.replayed ? {} : { secret: result.live }),
            },
          },
          201,
        );
      },
    );

    routes.post(
      '/application-api-keys/accounts/:userId/keys/:keyId/rotate',
      describeRoute({
        tags: ['ApiKeys'],
        summary: "Rotate a service account's API key",
        operationId: 'applicationApiKeysRotateKey',
        description:
          'The old secret stops working at once. The new secret is in this response only; a replay of the same Idempotency-Key omits it.',
        responses: {
          '200': dataResponse(CreatedApplicationApiKeySchema),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '404': apiErrorResponse(404),
          '500': apiErrorResponse(500),
        },
      }),
      async (context) => {
        const userId = context.req.param('userId');
        const keyId = context.req.param('keyId');
        await requireServiceAccount(userId);

        const result = await serializeRotation(userId, keyId, () =>
          recordOnce(
            context,
            { userId, keyId },
            async () => {
              const rotated = await keys.rotate(userId, keyId);
              // `keys.rotate` 把新明文写回原 keyId 那一行（新建的一行随即删掉），
              // 所以吊销 `key.id` 就是吊销刚轮换出的那一把。
              return { data: rotated.key, live: rotated.secret };
            },
            async (key) => keys.revoke(userId, key.id),
          ),
        );
        context.header('Idempotency-Replayed', String(result.replayed));
        context.header('Cache-Control', 'no-store');
        return context.json({
          data: {
            key: result.data,
            ...(result.replayed ? {} : { secret: result.live }),
          },
        });
      },
    );

    routes.delete(
      '/application-api-keys/accounts/:userId/keys/:keyId',
      describeRoute({
        tags: ['ApiKeys'],
        summary: "Revoke a service account's API key",
        operationId: 'applicationApiKeysRevokeKey',
        responses: {
          '204': emptyResponse('The key was revoked.'),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '404': apiErrorResponse(404),
          '500': apiErrorResponse(500),
        },
      }),
      async (context) => {
        const userId = context.req.param('userId');
        const keyId = context.req.param('keyId');
        await requireServiceAccount(userId);
        await recordOnce(context, { userId, keyId }, async () => {
          await keys.revoke(userId, keyId);
          return { data: { revoked: keyId } };
        });
        return context.body(null, 204);
      },
    );

    return new Hono().route('/', routes);
  },
);
