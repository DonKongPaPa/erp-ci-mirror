import { defineMigration, type MigrationDefinition } from '@nocobase/db';

/**
 * R-002 第一个切片：初筛的出处与人工确认记录。
 *
 * 一条新迁移，不改已经执行过的那条。两件事：
 *
 * - `fqcScreenings` 加七列。人工确认不再原地改写草稿的五列，所以「AI 当初怎么判的」
 *   与「这一份是谁出的、用的哪个模型/提示词、引了哪些知识、发出去之前脱没脱敏」都要
 *   留在行上。`reviewId` 指着最近一次确认记录。
 * - 新建 `fqcScreeningReviews`：只追加的确认记录。本条只写 `confirm`（确认初筛），
 *   R-003 的 `dispatch` / `rejudge` 之后往同一张表写。
 *
 * 存量行由新列的默认值补齐：`engine = rules`、两个布尔为假、`reviewId` 为空。
 * 缺省值写在列上而不是搬迁数据，是因为两种方言都会在加列时把它应用到已有的行。
 *
 * 外键不建：拍平的两张表与本项目其余业务表一致，关联由服务层按标识读。
 */
const migration: MigrationDefinition = defineMigration({
  name: '202611260001_fqc_drafting_reviews',
  async up({ builder }) {
    await builder.alterCollection('fqcScreenings', (collection) => {
      collection.string('engine', { length: 16 }).notNull().defaultTo('rules');
      collection.string('promptVersion', { length: 32 }).nullable();
      collection.boolean('degraded').notNull().defaultTo(false);
      collection.string('degradeReason', { length: 32 }).nullable();
      collection.json('knowledgeRefs').nullable();
      collection.boolean('redacted').notNull().defaultTo(false);
      collection.string('reviewId', { length: 64 }).nullable();
    });

    await builder.createCollection('fqcScreeningReviews', (collection) => {
      collection.string('id', { length: 64 }).notNull();
      collection.string('screeningId', { length: 64 }).notNull();
      collection.string('kind', { length: 16 }).notNull();
      collection.string('category', { length: 64 }).notNull();
      collection.string('severity', { length: 16 }).notNull();
      collection.string('departmentId', { length: 64 }).nullable();
      collection.string('actorId', { length: 64 }).notNull();
      collection.datetime('createdAt').notNull();
      collection.primary('id', { name: 'pk_fqc_screening_reviews' });
      collection.index('screeningId', {
        name: 'ix_fqc_screening_reviews_screening',
      });
    });
  },
  async down({ builder }) {
    await builder.dropCollection('fqcScreeningReviews');
    await builder.alterCollection('fqcScreenings', (collection) => {
      for (const field of [
        'engine',
        'promptVersion',
        'degraded',
        'degradeReason',
        'knowledgeRefs',
        'redacted',
        'reviewId',
      ]) {
        collection.dropField(field);
      }
    });
  },
});

export default migration;
