import path from 'node:path';
import { describeMigration } from '@nocobase/app-testing/server';
import { describe, expect } from 'vitest';

/**
 * R-002 验收16：初筛表的六列出处与 reviewId，外加确认记录表。
 *
 * 字段的类型、长度与可空性走 `toHaveField`；默认值不在 Collection 快照里，读物理列
 * 定义逐个比对 —— SQLite 不强制默认值，把迁移里的 `defaultTo` 删掉时只有这一步会红。
 * 存量行（迁移之前就有的初筛）在新列上的取值也在这里钉住：设计写明存量行补
 * `engine = rules`、两个布尔为假、`reviewId` 为空。
 */
const sources = [
  {
    packageName: 'fqc-drafting-migration-test',
    directory: path.resolve(
      import.meta.dirname,
      '../../database/main/migrations',
    ),
  },
];

const LEGACY_ID = 'r002-legacy-screening';

/** SQLite 把 boolean 的默认值报成字符串 '0'，Postgres 报成 false / 'false'。 */
const asBoolean = (value: unknown): boolean =>
  value === true || value === 1 || value === '1' || value === 'true';

describe('R-002 验收16：一条新迁移给初筛加七列并建确认记录表', () => {
  describeMigration('202611260001_fqc_drafting_reviews', {
    sources,
    before: async ({ connection }) => {
      // 迁移执行之前的存量初筛：只写旧列，新列由迁移补默认值。
      await connection.query
        .insertInto('fqcScreenings')
        .values({
          id: LEGACY_ID,
          messageId: 'r002-legacy-message',
          category: 'dimension',
          severity: 'minor',
          suggestedOwner: 'quality-dimension',
          summary: '存量行',
          confidence: '0.4500',
          evidence: ['尺寸'],
          modelName: 'rule-baseline',
          outcome: 'needs-review',
          createdAt: '2026-11-01T00:00:00.000',
          updatedAt: '2026-11-01T00:00:00.000',
        })
        .execute();
    },
    up: async ({ connection, expectCollection }) => {
      const screenings = await expectCollection('fqcScreenings').toExist();
      expect(screenings.primaryKey).toEqual(['id']);
      expect(Object.keys(screenings.fields).sort()).toEqual([
        'category',
        'confidence',
        'createdAt',
        'degradeReason',
        'degraded',
        'engine',
        'evidence',
        'id',
        'knowledgeRefs',
        'messageId',
        'modelName',
        'outcome',
        'promptVersion',
        'redacted',
        'reviewId',
        'severity',
        'suggestedOwner',
        'summary',
        'updatedAt',
      ]);

      await expectCollection('fqcScreenings').toHaveField('engine', {
        type: 'string',
        length: 16,
        nullable: false,
      });
      await expectCollection('fqcScreenings').toHaveField('promptVersion', {
        type: 'string',
        length: 32,
        nullable: true,
      });
      await expectCollection('fqcScreenings').toHaveField('degraded', {
        type: 'boolean',
        nullable: false,
      });
      await expectCollection('fqcScreenings').toHaveField('degradeReason', {
        type: 'string',
        length: 32,
        nullable: true,
      });
      await expectCollection('fqcScreenings').toHaveField('knowledgeRefs', {
        type: 'json',
        nullable: true,
      });
      await expectCollection('fqcScreenings').toHaveField('redacted', {
        type: 'boolean',
        nullable: false,
      });
      await expectCollection('fqcScreenings').toHaveField('reviewId', {
        type: 'string',
        length: 64,
        nullable: true,
      });

      // 默认值：engine 是 rules，两个布尔是假。reviewId 与 promptVersion 没有默认值。
      const physicalScreening =
        await connection.schemaInspector.getPhysicalCollection({
          tableName: 'fqc_screenings',
        });
      expect(physicalScreening, 'fqc_screenings 表不在').toBeDefined();
      const column = (name: string) =>
        physicalScreening?.columns.find((entry) => entry.columnName === name);
      expect(
        column('engine')?.default?.value,
        'engine 的默认值应当是 rules',
      ).toBe('rules');
      expect(
        asBoolean(column('degraded')?.default?.value),
        `degraded 的默认值应当是假，实际是 ${String(column('degraded')?.default?.value)}`,
      ).toBe(false);
      expect(
        asBoolean(column('redacted')?.default?.value),
        `redacted 的默认值应当是假，实际是 ${String(column('redacted')?.default?.value)}`,
      ).toBe(false);
      expect(column('review_id')?.default).toBeUndefined();

      // 存量行：新列有默认值，reviewId 为空。
      const legacy = await connection.query
        .selectFrom('fqcScreenings')
        .selectAll()
        .where('id', '=', LEGACY_ID)
        .executeTakeFirst();
      expect(legacy, '迁移之前的存量初筛不见了').toBeDefined();
      expect(legacy?.engine, '存量行的 engine 应当是 rules').toBe('rules');
      expect(asBoolean(legacy?.degraded), '存量行的 degraded 应当是假').toBe(
        false,
      );
      expect(asBoolean(legacy?.redacted), '存量行的 redacted 应当是假').toBe(
        false,
      );
      expect(legacy?.reviewId, '存量行的 reviewId 应当为空').toBeNull();
      expect(
        legacy?.promptVersion,
        '存量行的 promptVersion 应当为空',
      ).toBeNull();

      const reviews = await expectCollection('fqcScreeningReviews').toExist();
      expect(reviews.primaryKey).toEqual(['id']);
      expect(Object.keys(reviews.fields).sort()).toEqual([
        'actorId',
        'category',
        'createdAt',
        'departmentId',
        'id',
        'kind',
        'screeningId',
        'severity',
      ]);
      for (const field of [
        'id',
        'screeningId',
        'kind',
        'category',
        'severity',
        'actorId',
        'createdAt',
      ]) {
        await expectCollection('fqcScreeningReviews').toHaveField(field, {
          nullable: false,
        });
      }
      await expectCollection('fqcScreeningReviews').toHaveField('category', {
        type: 'string',
        length: 64,
      });
      await expectCollection('fqcScreeningReviews').toHaveField('severity', {
        type: 'string',
        length: 16,
      });
      await expectCollection('fqcScreeningReviews').toHaveField(
        'departmentId',
        {
          type: 'string',
          length: 64,
          nullable: true,
        },
      );
      await expectCollection('fqcScreeningReviews').toHaveIndex([
        'screeningId',
      ]);
    },
    down: async ({ expectCollection }) => {
      await expectCollection('fqcScreeningReviews').not.toExist();
      for (const field of [
        'engine',
        'promptVersion',
        'degraded',
        'degradeReason',
        'knowledgeRefs',
        'redacted',
        'reviewId',
      ]) {
        await expectCollection('fqcScreenings').not.toHaveField(field);
      }
    },
  });
});
