import path from 'node:path';
import { describeMigration } from '@nocobase/app-testing/server';
import { describe, expect } from 'vitest';

/**
 * R-026 验收34：反馈单的迁移。
 *
 * 一条新迁移做五件事：消息表加十列、初筛表加 `ownerId`、新建附件表与提醒记录表、
 * 把存量 `status` 的 `screened` 改成 `open`、清掉重复的 `(channel, externalId)` 之后
 * 加唯一约束。字段的类型、长度与可空性逐项钉在这里（消息表二十一个字段、初筛表
 * 二十个字段），照 `fqc-drafting-migration.test.ts` 的写法。
 *
 * 唯一约束对空值的行为在两种方言上都验：`externalId` 为空的行可以并存，同一个
 * 非空标识写第二行被数据库拒绝。存量重复按「只保留最早的一行」清，别的列不动。
 */
const sources = [
  {
    packageName: 'fqc-feedback-migration-test',
    directory: path.resolve(
      import.meta.dirname,
      '../../database/main/migrations',
    ),
  },
];

const MESSAGE_FIELDS = [
  'attachmentIds',
  'batchNo',
  'channel',
  'content',
  'createdAt',
  'customerName',
  'discardReason',
  'discardedAt',
  'discardedBy',
  'externalId',
  'id',
  'model',
  'note',
  'ownerId',
  'productName',
  'rawContentType',
  'receivedAt',
  'senderContact',
  'senderName',
  'status',
  'updatedAt',
];

const SCREENING_FIELDS = [
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
  'ownerId',
  'promptVersion',
  'redacted',
  'reviewId',
  'severity',
  'suggestedOwner',
  'summary',
  'updatedAt',
];

const FILE_FIELDS = [
  'createdAt',
  'disk',
  'ext',
  'feedbackId',
  'filename',
  'id',
  'key',
  'mimeType',
  'ownerId',
  'size',
  'updatedAt',
];

const REMINDER_FIELDS = [
  'attempts',
  'createdAt',
  'feedbackId',
  'id',
  'lastKey',
  'notifiedAt',
  'updatedAt',
];

const legacyMessage = (
  id: string,
  externalId: string | null,
  createdAt: string,
  status = 'screened',
) => ({
  id,
  channel: 'wx',
  externalId,
  senderName: null,
  senderContact: null,
  content: `存量消息 ${id}`,
  rawContentType: 'text',
  receivedAt: createdAt,
  status,
  createdAt,
  updatedAt: createdAt,
});

describe('R-026 验收34：反馈单加的列、存量迁移与两张新表', () => {
  describeMigration('202611260002_fqc_feedback', {
    sources,
    before: async ({ connection }) => {
      // 存量消息：两组重复的 (channel, externalId)、一组创建时间并列的、两行外部标识
      // 为空的、一行已丢弃之前的 status 取值。迁移只改 status = screened 的行，别的行不动。
      await connection.query
        .insertInto('fqcMessages')
        .values([
          legacyMessage('r026-dup-a', 'dup-1', '2026-11-01T00:00:00.000'),
          legacyMessage('r026-dup-b', 'dup-1', '2026-11-02T00:00:00.000'),
          legacyMessage('r026-dup-c', 'dup-2', '2026-11-03T00:00:00.000'),
          legacyMessage('r026-dup-d', 'dup-2', '2026-11-04T00:00:00.000'),
          // 创建时间相同：按标识升序保留，插入顺序反过来，证明不看插入顺序。
          legacyMessage('r026-tie-b', 'dup-tie', '2026-11-08T00:00:00.000'),
          legacyMessage('r026-tie-a', 'dup-tie', '2026-11-08T00:00:00.000'),
          legacyMessage('r026-null-a', null, '2026-11-05T00:00:00.000'),
          legacyMessage('r026-null-b', null, '2026-11-06T00:00:00.000'),
          legacyMessage('r026-open', 'already-open', '2026-11-07T00:00:00.000', 'open'),
        ])
        .execute();

      // 存量初筛：迁移之前的行，加列之后 ownerId 应当为空。
      await connection.query
        .insertInto('fqcScreenings')
        .values({
          id: 'r026-legacy-screening',
          messageId: 'r026-dup-a',
          category: 'dimension',
          severity: 'minor',
          suggestedOwner: 'quality-dimension',
          summary: '存量草稿',
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
      const messages = await expectCollection('fqcMessages').toExist();
      expect(messages.primaryKey).toEqual(['id']);
      expect(Object.keys(messages.fields).sort()).toEqual(MESSAGE_FIELDS);

      await expectCollection('fqcMessages').toHaveField('ownerId', {
        type: 'string',
        length: 64,
        nullable: true,
      });
      await expectCollection('fqcMessages').toHaveField('customerName', {
        type: 'string',
        length: 128,
        nullable: true,
      });
      await expectCollection('fqcMessages').toHaveField('productName', {
        type: 'string',
        length: 128,
        nullable: true,
      });
      await expectCollection('fqcMessages').toHaveField('model', {
        type: 'string',
        length: 128,
        nullable: true,
      });
      await expectCollection('fqcMessages').toHaveField('batchNo', {
        type: 'string',
        length: 64,
        nullable: true,
      });
      await expectCollection('fqcMessages').toHaveField('attachmentIds', {
        type: 'json',
        nullable: true,
      });
      await expectCollection('fqcMessages').toHaveField('note', {
        type: 'text',
        nullable: true,
      });
      await expectCollection('fqcMessages').toHaveField('discardedAt', {
        type: 'datetime',
        nullable: true,
      });
      await expectCollection('fqcMessages').toHaveField('discardedBy', {
        type: 'string',
        length: 64,
        nullable: true,
      });
      await expectCollection('fqcMessages').toHaveField('discardReason', {
        type: 'string',
        length: 32,
        nullable: true,
      });
      await expectCollection('fqcMessages').toHaveIndex(['ownerId']);
      // (channel, externalId) 唯一：空值互不相等，非空标识不能重复。
      await expectCollection('fqcMessages').toHaveIndex(
        ['channel', 'externalId'],
        { unique: true },
      );

      const rows = await connection.query
        .selectFrom('fqcMessages')
        .selectAll()
        .orderBy('id', 'asc')
        .execute();
      expect(rows.length, '存量消息的行数变了').toBe(9);
      const byId = new Map(rows.map((row) => [String(row.id), row]));

      // 存量 status：screened 改成 open；本来就是 open 的不动。
      expect(byId.get('r026-dup-a')?.status).toBe('open');
      expect(byId.get('r026-open')?.status).toBe('open');

      // 重复只保留最早的一行，其余的 externalId 置空，别的列不动。
      expect(byId.get('r026-dup-a')?.externalId).toBe('dup-1');
      expect(byId.get('r026-dup-b')?.externalId).toBeNull();
      expect(byId.get('r026-dup-c')?.externalId).toBe('dup-2');
      expect(byId.get('r026-dup-d')?.externalId).toBeNull();
      expect(byId.get('r026-dup-b')?.content).toBe('存量消息 r026-dup-b');

      // 创建时间并列时按标识升序：a 留下，b 置空。设计只写「最早」，并列规则在这里钉住。
      expect(byId.get('r026-tie-a')?.externalId).toBe('dup-tie');
      expect(byId.get('r026-tie-b')?.externalId).toBeNull();

      // 外部标识为空的行不受约束限制，可以并存。
      expect(byId.get('r026-null-a')?.externalId).toBeNull();
      expect(byId.get('r026-null-b')?.externalId).toBeNull();

      // 新列在存量行上为空。
      const legacy = byId.get('r026-dup-a');
      for (const column of [
        'ownerId',
        'customerName',
        'productName',
        'model',
        'batchNo',
        'attachmentIds',
        'note',
        'discardedAt',
        'discardedBy',
        'discardReason',
      ]) {
        expect(legacy?.[column], `存量行的 ${column} 应当为空`).toBeNull();
      }

      // 约束真的在库里生效：同一个非空标识再写一行被拒绝。
      await expect(
        connection.query
          .insertInto('fqcMessages')
          .values(legacyMessage('r026-duplicate-insert', 'dup-1', '2026-11-08T00:00:00.000'))
          .execute(),
        '重复的 (channel, externalId) 没有被数据库拒绝',
      ).rejects.toThrow();

      const screenings = await expectCollection('fqcScreenings').toExist();
      expect(screenings.primaryKey).toEqual(['id']);
      expect(Object.keys(screenings.fields).sort()).toEqual(SCREENING_FIELDS);
      await expectCollection('fqcScreenings').toHaveField('ownerId', {
        type: 'string',
        length: 64,
        nullable: true,
      });
      await expectCollection('fqcScreenings').toHaveIndex(['ownerId']);
      const legacyScreening = await connection.query
        .selectFrom('fqcScreenings')
        .selectAll()
        .where('id', '=', 'r026-legacy-screening')
        .executeTakeFirst();
      expect(legacyScreening, '迁移之前的存量初筛不见了').toBeDefined();
      expect(
        legacyScreening?.ownerId,
        '存量初筛行的 ownerId 应当留空，不回填',
      ).toBeNull();

      const files = await expectCollection('fqcFeedbackFiles').toExist();
      expect(files.primaryKey).toEqual(['id']);
      expect(Object.keys(files.fields).sort()).toEqual(FILE_FIELDS);
      await expectCollection('fqcFeedbackFiles').toHaveField('id', {
        type: 'string',
        length: 64,
        nullable: false,
      });
      await expectCollection('fqcFeedbackFiles').toHaveField('disk', {
        type: 'string',
        length: 255,
        nullable: false,
      });
      await expectCollection('fqcFeedbackFiles').toHaveField('key', {
        type: 'text',
        nullable: false,
      });
      await expectCollection('fqcFeedbackFiles').toHaveField('filename', {
        type: 'text',
        nullable: false,
      });
      await expectCollection('fqcFeedbackFiles').toHaveField('ext', {
        type: 'string',
        length: 32,
        nullable: false,
      });
      await expectCollection('fqcFeedbackFiles').toHaveField('mimeType', {
        type: 'string',
        length: 255,
        nullable: false,
      });
      await expectCollection('fqcFeedbackFiles').toHaveField('size', {
        type: 'integer',
        nullable: false,
      });
      await expectCollection('fqcFeedbackFiles').toHaveField('ownerId', {
        type: 'string',
        length: 64,
        nullable: true,
      });
      await expectCollection('fqcFeedbackFiles').toHaveField('feedbackId', {
        type: 'string',
        length: 64,
        nullable: true,
      });
      await expectCollection('fqcFeedbackFiles').toHaveField('createdAt', {
        type: 'datetime',
        nullable: false,
      });
      await expectCollection('fqcFeedbackFiles').toHaveField('updatedAt', {
        type: 'datetime',
        nullable: false,
      });
      await expectCollection('fqcFeedbackFiles').toHaveIndex(['ownerId']);
      await expectCollection('fqcFeedbackFiles').toHaveIndex(['feedbackId']);

      const reminders = await expectCollection('fqcFeedbackReminders').toExist();
      expect(reminders.primaryKey).toEqual(['id']);
      expect(Object.keys(reminders.fields).sort()).toEqual(REMINDER_FIELDS);
      await expectCollection('fqcFeedbackReminders').toHaveField('feedbackId', {
        type: 'string',
        length: 64,
        nullable: false,
      });
      await expectCollection('fqcFeedbackReminders').toHaveField('attempts', {
        type: 'integer',
        nullable: false,
      });
      await expectCollection('fqcFeedbackReminders').toHaveField('lastKey', {
        type: 'string',
        length: 191,
        nullable: true,
      });
      await expectCollection('fqcFeedbackReminders').toHaveField('notifiedAt', {
        type: 'datetime',
        nullable: true,
      });
      await expectCollection('fqcFeedbackReminders').toHaveIndex(
        ['feedbackId'],
        { unique: true },
      );

      // attempts 的默认值是 0：不给这一列也能插进去，读回来是 0。
      await connection.query
        .insertInto('fqcFeedbackReminders')
        .values({
          id: 'r026-reminder-1',
          feedbackId: 'r026-dup-a',
          createdAt: '2026-11-09T00:00:00.000',
          updatedAt: '2026-11-09T00:00:00.000',
        })
        .execute();
      const reminder = await connection.query
        .selectFrom('fqcFeedbackReminders')
        .selectAll()
        .where('id', '=', 'r026-reminder-1')
        .executeTakeFirst();
      expect(Number(reminder?.attempts), 'attempts 的默认值应当是 0').toBe(0);
      expect(reminder?.lastKey).toBeNull();
      expect(reminder?.notifiedAt).toBeNull();

      // 一张单至多一行提醒记录。
      await expect(
        connection.query
          .insertInto('fqcFeedbackReminders')
          .values({
            id: 'r026-reminder-2',
            feedbackId: 'r026-dup-a',
            createdAt: '2026-11-10T00:00:00.000',
            updatedAt: '2026-11-10T00:00:00.000',
          })
          .execute(),
        '同一张单写进了第二行提醒记录',
      ).rejects.toThrow();
    },
    down: async ({ connection, expectCollection }) => {
      await expectCollection('fqcFeedbackFiles').not.toExist();
      await expectCollection('fqcFeedbackReminders').not.toExist();
      for (const field of [
        'ownerId',
        'customerName',
        'productName',
        'model',
        'batchNo',
        'attachmentIds',
        'note',
        'discardedAt',
        'discardedBy',
        'discardReason',
      ]) {
        await expectCollection('fqcMessages').not.toHaveField(field);
      }
      await expectCollection('fqcMessages').not.toHaveIndex([
        'channel',
        'externalId',
      ]);
      await expectCollection('fqcScreenings').not.toHaveField('ownerId');

      // down 不回写 status：up 把 screened 改成 open 的存量行，回滚后仍是 open。
      // 中间可能已经丢弃过，写回 screened 会丢掉「已经记下来」这个事实。
      const afterDown = await connection.query
        .selectFrom('fqcMessages')
        .select(['id', 'status'])
        .where('id', 'in', [
          'r026-dup-a',
          'r026-dup-b',
          'r026-dup-c',
          'r026-dup-d',
          'r026-tie-a',
          'r026-tie-b',
          'r026-null-a',
          'r026-null-b',
          'r026-open',
        ])
        .orderBy('id', 'asc')
        .execute();
      expect(afterDown, '回滚后存量消息应当都还在').toHaveLength(9);
      for (const row of afterDown) {
        expect(
          row.status,
          `${row.id} 回滚后不该被写回 screened`,
        ).toBe('open');
      }
    },
  });
});
