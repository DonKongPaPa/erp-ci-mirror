import { rm } from 'node:fs/promises';

import {
  createTestApp as createFrameworkTestApp,
  type CreateTestAppOptions,
  type TestApp,
  type TestAppConfig,
} from '@nocobase/app-testing/server';
import { expectCollection } from '@nocobase/app-testing/server';
import {
  createDatabaseManager,
  type AnyConnectionConfig,
  type DatabaseManager,
} from '@nocobase/db';
import type { Knex } from 'knex';
import { test } from 'vitest';

/**
 * R-046：测试应用的收尾。
 *
 * 框架的 `TestApp.close()` 只做「关应用 → 丢测试库」。`server.close()` 关掉的是应用自己
 * 管理的资源（含连接池），并不能覆盖直接调用 `server.fetch()` 的在途请求：客户端测试
 * 点了提交就往下走，请求还在服务端的事务里，收尾的 `drop schema … cascade` 就会与它
 * 争锁。这里在框架之外补三步：先等在途请求落地，再关应用；关完再看一眼测试库的锁；
 * 最后按 Postgres 的方言重建 drop，遇到死锁、锁不可用、对象被占用时只结束持有该
 * schema 内对象锁的会话并重试。
 *
 * 框架缺口（不在这里打补丁，靠上面的重试兜住）：realtime 的会话校验定时器由框架的
 * `setInterval` 驱动，不随 `server.close()` 等待；调度器里正在执行的 job 回调也没有被
 * `ScheduleExecutor.shutdown()` 等到。应用自己的定时清理任务在
 * `server/providers/submission.ts` 的 `shutdown()` 里等了。
 */

const RETRYABLE_DROP_CODES = new Set([
  // deadlock detected
  '40P01',
  // lock not available
  '55P03',
  // object in use
  '55006',
]);
const MAX_DROP_ATTEMPTS = 5;
const DROP_LOCK_TIMEOUT = '3s';
const IN_FLIGHT_TIMEOUT_MS = 10_000;
const SCHEMA_QUIESCE_TIMEOUT_MS = 2_000;
const SCHEMA_QUIESCE_INTERVAL_MS = 100;

type AnyError = { code?: unknown; cause?: unknown; errors?: unknown };

function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  const candidate = error as AnyError;
  if (typeof candidate.code === 'string') return candidate.code;
  for (const nested of [
    candidate.cause,
    ...(Array.isArray(candidate.errors) ? candidate.errors : []),
  ]) {
    const code = errorCode(nested);
    if (code) return code;
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms).unref());

/**
 * A `TestApp` whose `close()` waits for in-flight requests and drops its Postgres
 * schemas with a bounded retry, ending only the sessions that hold locks inside
 * those schemas.
 */
export function stabilizeTestApp(
  app: TestApp,
  options: { readonly drop?: () => Promise<void> } = {},
): TestApp {
  const pending = new Set<Promise<unknown>>();
  let inFlight = 0;

  const track = (response: Promise<Response>): Promise<Response> => {
    inFlight += 1;
    const settled = response
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        inFlight -= 1;
        pending.delete(settled);
      });
    pending.add(settled);
    return response;
  };

  const fetch = (request: Request) =>
    track(Promise.resolve(app.fetch(request)));
  const apiRoot = `http://localhost${app.publicBasePath.replace(/\/$/u, '')}/api`;
  const request = (path: string, init?: RequestInit) =>
    fetch(new Request(path.startsWith('/') ? `${apiRoot}${path}` : path, init));

  const close = async (): Promise<void> => {
    await settleInFlight(pending, () => inFlight);
    try {
      await app.server.close();
    } finally {
      if (options.drop) {
        // 假应用夹具没有数据库：用它自带的 drop 记录收尾顺序，不连库。
        await options.drop();
        await rm(app.config.directory, { recursive: true, force: true });
      } else {
        await disposeTestDatabases(app.config);
      }
    }
  };

  return { ...app, fetch, request, close };
}

export async function createTestApp(
  options: CreateTestAppOptions,
): Promise<TestApp> {
  return stabilizeTestApp(await createFrameworkTestApp(options));
}

/** The Postgres schemas this test application owns. */
export function testDatabaseSchemaNames(app: TestApp): readonly string[] {
  return schemaNames(app.config);
}

/**
 * Opens the administrative connection the teardown itself uses, for a test that
 * needs to hold a lock in the application's schema or inspect it after the drop.
 */
export async function openTestDatabaseAdmin(app: TestApp): Promise<{
  readonly client: Knex;
  close(): Promise<void>;
}> {
  const admin = await createAdmin(app.config);
  return {
    client: await admin.connection().client(),
    close: () => admin.destroy(),
  };
}

/**
 * The same fixture `@nocobase/app-testing/server` exports, on the stable teardown.
 * Kept in the application so that every test application in `tests/` closes the
 * same way.
 */
export function createAppTest(
  options: CreateTestAppOptions & { readonly scope?: 'file' | 'test' },
) {
  const { scope = 'file', ...appOptions } = options;
  return test.extend({
    testApp: [
      // Vitest reads a fixture's dependencies from this destructuring pattern; this one has none.
      // eslint-disable-next-line no-empty-pattern
      async ({}, provide: (value: TestApp) => Promise<void>) => {
        const testApp = await createTestApp(appOptions);
        try {
          await provide(testApp);
        } finally {
          await testApp.close();
        }
      },
      { scope },
    ],
    app: async (
      { testApp },
      provide: (value: TestApp['application']) => Promise<void>,
    ) => provide(testApp.application),
    fetch: async (
      { testApp },
      provide: (value: TestApp['fetch']) => Promise<void>,
    ) => provide(testApp.fetch),
    request: async (
      { testApp },
      provide: (value: TestApp['request']) => Promise<void>,
    ) => provide(testApp.request),
    database: async (
      { testApp },
      provide: (value: TestApp['database']) => Promise<void>,
    ) => provide(testApp.database),
    connection: async (
      { testApp },
      provide: (value: TestApp['connection']) => Promise<void>,
    ) => provide(testApp.connection),
    expectCollection: async (
      { testApp },
      provide: (value: (name: string) => unknown) => Promise<void>,
    ) => provide((name: string) => expectCollection(testApp.connection, name)),
  });
}

async function settleInFlight(
  pending: Set<Promise<unknown>>,
  inFlight: () => number,
): Promise<void> {
  if (pending.size === 0) return;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), IN_FLIGHT_TIMEOUT_MS);
    timer.unref();
  });
  const settled = (async () => {
    while (pending.size > 0) {
      await Promise.all([...pending]);
    }
    return 'settled' as const;
  })();
  const outcome = await Promise.race([settled, timeout]);
  if (timer) clearTimeout(timer);
  if (outcome === 'timeout') {
    console.warn(
      `[r046] ${inFlight()} in-flight request(s) did not finish within ${IN_FLIGHT_TIMEOUT_MS}ms; closing the test application anyway.`,
    );
  }
}

async function disposeTestDatabases(config: TestAppConfig): Promise<void> {
  try {
    // 测试只连 Postgres：没有 SQLite else 分支，真实应用一律走带重试的 schema drop。
    await dropPostgresSchemas(config);
  } finally {
    await rm(config.directory, { recursive: true, force: true });
  }
}

function schemaNames(config: TestAppConfig): readonly string[] {
  return config.testDatabases.connections.flatMap((name) => {
    const connection = config.testDatabases.connectionConfig(
      name,
    ) as AnyConnectionConfig & { readonly schema?: string | readonly string[] };
    const schema = connection.schema;
    if (typeof schema === 'string') return [schema];
    if (Array.isArray(schema)) return [...schema];
    throw new Error(`The test database "${name}" has no schema to drop.`);
  });
}

async function createAdmin(config: TestAppConfig): Promise<DatabaseManager> {
  const name = config.testDatabases.connections[0];
  if (name === undefined) {
    throw new Error('The test app has no database connection.');
  }
  const { schema: _schema, ...connection } =
    config.testDatabases.connectionConfig(name) as AnyConnectionConfig & {
      readonly schema?: unknown;
    };
  return createDatabaseManager({
    connections: { main: connection as AnyConnectionConfig },
  });
}

async function dropPostgresSchemas(config: TestAppConfig): Promise<void> {
  const names = schemaNames(config);
  const admin = await createAdmin(config);
  try {
    const client = await admin.connection().client();
    await client.raw(`set lock_timeout = '${DROP_LOCK_TIMEOUT}'`);
    await quiesceSchemaLocks(client, names);
    for (let attempt = 1; ; attempt += 1) {
      try {
        for (const name of names) {
          await client.raw('drop schema if exists ?? cascade', [name]);
        }
        return;
      } catch (error) {
        const code = errorCode(error);
        if (
          attempt >= MAX_DROP_ATTEMPTS ||
          code === undefined ||
          !RETRYABLE_DROP_CODES.has(code)
        ) {
          throw error;
        }
        const terminated = await terminateSchemaLockHolders(client, names);
        console.warn(
          `[r046] drop schema ${names.join(', ')} failed (${code}: ${errorMessage(error)}); terminated ${terminated.length} lock-holding session(s)${terminated.length > 0 ? ` (${terminated.join(', ')})` : ''}; retry ${attempt}/${MAX_DROP_ATTEMPTS - 1} in ${retryDelay(attempt)}ms.`,
        );
        await sleep(retryDelay(attempt));
      }
    }
  } finally {
    await admin.destroy();
  }
}

function retryDelay(attempt: number): number {
  return 100 * 2 ** (attempt - 1);
}

/**
 * Gives work that is still releasing the schema a moment to finish before the
 * drop starts. A session that never finishes is left to the drop's lock
 * timeout and the cleanup below, so a stuck transaction cannot extend the wait
 * without bound.
 */
async function quiesceSchemaLocks(
  client: Knex,
  names: readonly string[],
): Promise<void> {
  const deadline = Date.now() + SCHEMA_QUIESCE_TIMEOUT_MS;
  let holders = await schemaLockHolders(client, names);
  if (holders.length === 0) return;
  while (holders.length > 0 && Date.now() < deadline) {
    await sleep(SCHEMA_QUIESCE_INTERVAL_MS);
    holders = await schemaLockHolders(client, names);
  }
  if (holders.length > 0) {
    console.warn(
      `[r046] schema ${names.join(', ')} still has ${holders.length} lock-holding session(s) (${holders.map((holder) => holder.pid).join(', ')}) after ${SCHEMA_QUIESCE_TIMEOUT_MS}ms; the drop retry will end them if the lock does not clear.`,
    );
  }
}

interface LockHolder {
  readonly pid: number;
  readonly state: string | null;
  readonly query: string | null;
}

async function schemaLockHolders(
  client: Knex,
  names: readonly string[],
): Promise<readonly LockHolder[]> {
  const rows = await client.raw(
    `select distinct a.pid, a.state, a.query
       from pg_locks l
       join pg_stat_activity a on a.pid = l.pid
      where a.pid <> pg_backend_pid()
        and (
          l.relation in (
            select c.oid
              from pg_class c
              join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = any(?)
          )
          or (
            l.locktype = 'object'
            and l.classid = 'pg_namespace'::regclass::oid
            and l.objid in (select oid from pg_namespace where nspname = any(?))
          )
        )`,
    [names, names],
  );
  return (rows.rows ?? rows) as readonly LockHolder[];
}

async function terminateSchemaLockHolders(
  client: Knex,
  names: readonly string[],
): Promise<readonly number[]> {
  const holders = await schemaLockHolders(client, names);
  const pids = [...new Set(holders.map((holder) => holder.pid))];
  const terminated: number[] = [];
  for (const pid of pids) {
    const rows = await client.raw(
      'select pg_terminate_backend(?) as terminated',
      [pid],
    );
    const row = (rows.rows ?? rows)[0] as { terminated?: boolean } | undefined;
    if (row?.terminated === true) terminated.push(pid);
  }
  return terminated;
}
