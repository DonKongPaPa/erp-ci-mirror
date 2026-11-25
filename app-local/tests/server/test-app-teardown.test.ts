// @vitest-environment node
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { TestApp } from '@nocobase/app-testing/server';
import { describe, expect, it, vi } from 'vitest';

import { createStandaloneServer } from '../../server/standalone.js';
import {
  createTestApp,
  openTestDatabaseAdmin,
  stabilizeTestApp,
  testDatabaseSchemaNames,
} from '../helpers/test-app.js';

/**
 * R-046 验收第 1、3 条：测试应用的收尾。
 *
 * 收尾链在 `tests/helpers/test-app.ts`：先在途请求落地，再关应用；Postgres 上重建
 * drop，遇到死锁、锁不可用、对象被占用时只结束持有该 schema 内对象锁的会话并重试。
 * 下面是它的变异自检：拿掉等待或重试，它们会红。
 *
 * 本机默认 SQLite；`drop schema … cascade` 与 `pg_locks` 只在 Postgres 上有。
 */

const dialect = process.env.NOCOBASE_TEST_DB_DIALECT ?? 'sqlite';
const config = {
  app: { publicOrigin: 'http://localhost' },
  auth: { secret: 'test-auth-secret-at-least-32-characters' },
  logging: { enabled: false },
};

type TestAppInstance = Awaited<ReturnType<typeof createPlainApp>>;

it('finishes an in-flight request before closing the application', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'r046-fake-test-app-'));
  const events: string[] = [];
  const fake = {
    server: {
      close: async () => {
        events.push('server.close');
      },
    },
    fetch: async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      events.push('request');
      return new Response('ok');
    },
    publicBasePath: '',
    config: {
      directory,
      testDatabases: {
        dialect: 'sqlite',
        connections: ['main'],
        connectionConfig: () => ({}),
        drop: async () => {
          events.push('drop');
        },
      },
    },
  } as unknown as TestApp;
  const app = stabilizeTestApp(fake);

  const pending = app.fetch(new Request('http://localhost/in-flight'));
  await app.close();
  await pending;

  expect(events, '请求必须在关应用之前结束').toEqual([
    'request',
    'server.close',
    'drop',
  ]);
});

async function createPlainApp() {
  return createTestApp({
    createServer: createStandaloneServer,
    connections: ['main'],
    config,
  });
}

interface SchemaLock {
  readonly schema: string;
  readonly pid: number;
  readonly close: () => Promise<void>;
}

/** Starts a transaction on another connection and leaves it open, locking a table in the schema. */
async function holdSchemaLock(app: TestAppInstance): Promise<SchemaLock> {
  const [schema] = testDatabaseSchemaNames(app);
  if (schema === undefined) throw new Error('The test app has no schema.');
  const admin = await openTestDatabaseAdmin(app);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: (pid: number) => void;
  const ready = new Promise<number>((resolve) => {
    started = resolve;
  });
  const transaction = admin.client
    .transaction(async (transaction) => {
      await transaction.raw('set local search_path to ??', [schema]);
      const { rows } = await transaction.raw('select pg_backend_pid() as pid');
      const pid = (rows as readonly { pid: number }[])[0]?.pid;
      if (pid === undefined)
        throw new Error('The lock holder has no backend pid.');
      await transaction.raw(
        'select 1 from "__nocobase_collection_metadata" limit 1',
      );
      started(pid);
      await held;
    })
    .catch(() => undefined);
  const pid = await ready;
  return {
    schema,
    pid,
    close: async () => {
      release();
      await transaction;
      await admin.close().catch(() => undefined);
    },
  };
}

async function inspect(
  app: TestAppInstance,
  schema: string,
  pid: number,
): Promise<{ schemaExists: boolean; holderAlive: boolean }> {
  const admin = await openTestDatabaseAdmin(app);
  try {
    const schemaRow = await admin.client.raw(
      'select 1 from pg_namespace where nspname = ?',
      [schema],
    );
    const holderRow = await admin.client.raw(
      'select 1 from pg_stat_activity where pid = ?',
      [pid],
    );
    return {
      schemaExists: (schemaRow.rows as readonly unknown[]).length > 0,
      holderAlive: (holderRow.rows as readonly unknown[]).length > 0,
    };
  } finally {
    await admin.close();
  }
}

describe.skipIf(dialect !== 'postgres')('Postgres test-app teardown', () => {
  it('ends the session that locks its schema and retries the drop', async () => {
    const app = await createPlainApp();
    const lock = await holdSchemaLock(app);
    try {
      const warnings: string[] = [];
      const warn = vi
        .spyOn(console, 'warn')
        .mockImplementation((...values: unknown[]) => {
          warnings.push(values.map(String).join(' '));
        });
      try {
        await app.close();
      } finally {
        warn.mockRestore();
      }

      const output = warnings.join('\n');
      expect(output, 'drop 的重试与结束会话要打到测试输出里').toContain(
        '[r046] drop schema',
      );
      expect(output).toContain('55P03');
      expect(output).toContain('terminated 1 lock-holding session');
      await expect(inspect(app, lock.schema, lock.pid)).resolves.toEqual({
        schemaExists: false,
        holderAlive: false,
      });
    } finally {
      await lock.close();
      await app.close().catch(() => undefined);
    }
  });

  it('ends only the sessions that lock the closing application schema', async () => {
    const closing = await createPlainApp();
    const other = await createPlainApp();
    const closingLock = await holdSchemaLock(closing);
    const otherLock = await holdSchemaLock(other);
    try {
      await closing.close();
      // 另一个应用的会话不在结束范围内：它仍活着，schema 也还在。
      await expect(
        inspect(other, otherLock.schema, otherLock.pid),
      ).resolves.toEqual({
        schemaExists: true,
        holderAlive: true,
      });
    } finally {
      await closingLock.close();
      await otherLock.close();
      await closing.close().catch(() => undefined);
      await other.close().catch(() => undefined);
    }
  });
});
