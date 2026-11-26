import { defineMigration, type MigrationDefinition } from '@nocobase/db';

/**
 * R-003 S5：lifecycle 运行时层的两张全局日志表。
 *
 * 包 `@nocobase/lifecycle@0.1.0-beta.6` 自己不带迁移，仓库 store 读写
 * `lifecycleTransitions` / `lifecycleEffectRuns` 这两张表，字段由包里的
 * `TransitionEntry` 与 `EffectRun` 决定。列清单逐字取自框架自己的迁移：
 * `app-local/tests/fixtures/submission/migration.ts:17-32`（transitions）与
 * `:33-52`（effectRuns）—— 连索引一起，不凭印象手写。
 *
 * 只建这两张表；不碰业务表、不改已执行过的迁移。一个应用只有这一份日志表，
 * 所有生命周期（本条只有 `fqcTickets`）共用。`down` 只删这两张表。
 */
const migration: MigrationDefinition = defineMigration({
  name: '202611260005_create_lifecycle_logs',
  async up({ builder }) {
    await builder.createCollection('lifecycleTransitions', (c) => {
      c.bigInt('id').primary().autoIncrement().notNull();
      c.string('lifecycle').notNull();
      c.string('recordId').notNull();
      c.string('transition').notNull();
      c.string('from').nullable();
      c.string('to').notNull();
      c.string('actorId').notNull();
      c.json('input').notNull();
      c.datetimeTz('at').notNull();
      c.integer('version').notNull();
      c.string('requestId').nullable();
      c.string('requestKey').notNull();
      c.unique(['lifecycle', 'recordId', 'version']);
      c.unique(['lifecycle', 'recordId', 'requestKey']);
    });
    await builder.createCollection('lifecycleEffectRuns', (c) => {
      c.bigInt('id').primary().autoIncrement().notNull();
      c.bigInt('transitionId').notNull();
      c.string('lifecycle').notNull();
      c.string('recordId').notNull();
      c.string('effect').notNull();
      c.boolean('stayBound').notNull();
      c.string('status').notNull();
      c.integer('attempts').notNull();
      c.integer('maxAttempts').notNull();
      c.json('result').nullable();
      c.text('error').nullable();
      c.datetimeTz('createdAt').notNull();
      c.datetimeTz('updatedAt').notNull();
      c.datetimeTz('claimedAt').nullable();
      c.datetimeTz('runAfter').nullable();
      c.json('continuation').nullable();
      c.datetimeTz('continuationDueAt').nullable();
      c.datetimeTz('continuationAbandonedAt').nullable();
    });
  },
  async down({ builder }) {
    await builder.dropCollection('lifecycleEffectRuns');
    await builder.dropCollection('lifecycleTransitions');
  },
});

export default migration;
