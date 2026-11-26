import path from 'node:path';
import { describeMigration } from '@nocobase/app-testing/server';
import { describe, expect } from 'vitest';

/**
 * R-003 S5：lifecycle 运行时层的两张全局日志表，逐字段钉死。
 *
 * 列清单逐字取自 `@nocobase/lifecycle` 自己的迁移参照
 * `app-local/tests/fixtures/submission/migration.ts:17-32`（transitions）与 `:33-52`
 * （effectRuns），不是凭定义反推。已执行的迁移不可改，所以这里把类型、可空性、
 * 主键、两个唯一索引与 down 的干净回滚一次钉住。只在真 Postgres 上跑。
 */
const sources = [
  {
    packageName: 'lifecycle-logs-migration-test',
    directory: path.resolve(
      import.meta.dirname,
      '../../database/main/migrations',
    ),
  },
];

const TRANSITION_FIELDS = [
  'actorId',
  'at',
  'from',
  'id',
  'input',
  'lifecycle',
  'recordId',
  'requestId',
  'requestKey',
  'to',
  'transition',
  'version',
];

const EFFECT_RUN_FIELDS = [
  'attempts',
  'claimedAt',
  'continuation',
  'continuationAbandonedAt',
  'continuationDueAt',
  'createdAt',
  'effect',
  'error',
  'id',
  'lifecycle',
  'maxAttempts',
  'recordId',
  'result',
  'runAfter',
  'status',
  'stayBound',
  'transitionId',
  'updatedAt',
];

describe('R-003 S5：lifecycle 两张日志表的精确列清单', () => {
  describeMigration('202611260005_create_lifecycle_logs', {
    sources,
    up: async ({ expectCollection }) => {
      const transitions = await expectCollection('lifecycleTransitions').toExist();
      expect(transitions.primaryKey).toEqual(['id']);
      expect(Object.keys(transitions.fields).sort()).toEqual(TRANSITION_FIELDS);
      await expectCollection('lifecycleTransitions').toHaveField('id', {
        type: 'bigInt',
        nullable: false,
      });
      for (const field of [
        'lifecycle',
        'recordId',
        'transition',
        'to',
        'actorId',
        'input',
        'at',
        'version',
        'requestKey',
      ] as const) {
        const type =
          field === 'input' ? 'json' : field === 'at' ? 'datetimeTz' : field === 'version' ? 'integer' : 'string';
        await expectCollection('lifecycleTransitions').toHaveField(field, {
          type,
          nullable: false,
        });
      }
      for (const field of ['from', 'requestId'] as const) {
        await expectCollection('lifecycleTransitions').toHaveField(field, {
          type: 'string',
          nullable: true,
        });
      }
      await expectCollection('lifecycleTransitions').toHaveIndex(
        ['lifecycle', 'recordId', 'version'],
        { unique: true },
      );
      await expectCollection('lifecycleTransitions').toHaveIndex(
        ['lifecycle', 'recordId', 'requestKey'],
        { unique: true },
      );

      const runs = await expectCollection('lifecycleEffectRuns').toExist();
      expect(runs.primaryKey).toEqual(['id']);
      expect(Object.keys(runs.fields).sort()).toEqual(EFFECT_RUN_FIELDS);
      for (const field of [
        'transitionId',
        'lifecycle',
        'recordId',
        'effect',
        'stayBound',
        'status',
        'attempts',
        'maxAttempts',
        'createdAt',
        'updatedAt',
      ] as const) {
        const type =
          field === 'transitionId'
            ? 'bigInt'
            : field === 'attempts' || field === 'maxAttempts'
              ? 'integer'
            : field === 'stayBound'
              ? 'boolean'
              : field === 'createdAt' || field === 'updatedAt'
                ? 'datetimeTz'
                : 'string';
        await expectCollection('lifecycleEffectRuns').toHaveField(field, {
          type,
          nullable: false,
        });
      }
      for (const field of [
        'result',
        'continuation',
      ] as const) {
        await expectCollection('lifecycleEffectRuns').toHaveField(field, {
          type: 'json',
          nullable: true,
        });
      }
      await expectCollection('lifecycleEffectRuns').toHaveField('error', {
        type: 'text',
        nullable: true,
      });
      for (const field of [
        'claimedAt',
        'runAfter',
        'continuationDueAt',
        'continuationAbandonedAt',
      ] as const) {
        await expectCollection('lifecycleEffectRuns').toHaveField(field, {
          type: 'datetimeTz',
          nullable: true,
        });
      }
    },
    down: async ({ expectCollection }) => {
      await expectCollection('lifecycleEffectRuns').not.toExist();
      await expectCollection('lifecycleTransitions').not.toExist();
    },
  });
});
