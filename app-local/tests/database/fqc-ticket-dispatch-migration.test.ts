import path from 'node:path';
import {
  createDatabaseTest,
  describeMigration,
} from '@nocobase/app-testing/server';
import { describe, expect } from 'vitest';

import ticketDispatchMigration from '../../database/main/migrations/202611260003_fqc_ticket_dispatch.js';

/**
 * R-003 S1 验收16 与验收3（库约束部分）：工单加七列、派单规则表、存量回填与唯一约束。
 *
 * 字段的类型、长度与可空性逐项钉在 `toHaveField`。默认值不在 Collection 快照里，
 * 读物理列定义逐个比对 —— SQLite 不强制默认值，把迁移里的 `defaultTo` 删掉时只有
 * 这一步会红；再插一行不给这两列、读回来是 0，证明默认值真的落在行上。
 *
 * 存量数据：迁移之前建的工单仍在、状态 open、`lifecycleDefinition` 被回填成定义的
 * `name`（`fqcTickets`，不是空串）；存量初筛的 `auto` 变成 `suggested`，别的取值不动。
 * `screeningId` 的唯一约束由数据库裁决：同一份草稿写第二张单被拒，空值可以并存。
 *
 * `down` 有独立断言：新表不见、七列不见、两个索引不见、字段集合回到迁移前的十五列。
 */
const sources = [
  {
    packageName: 'fqc-ticket-dispatch-migration-test',
    directory: path.resolve(
      import.meta.dirname,
      '../../database/main/migrations',
    ),
  },
];

/** 生命周期定义的 name。回填值必须是它，留空会在第一次流转时抛 DEFINITION_MISMATCH。 */
const DEFINITION_NAME = 'fqcTickets';

const LEGACY_TICKET_ID = 'r003-legacy-ticket';
const LEGACY_AUTO_SCREENING = 'r003-legacy-auto';
const LEGACY_REVIEW_SCREENING = 'r003-legacy-review';

/** 迁移前的十五列。`down` 之后必须恰好回到这个集合。 */
const ORIGINAL_TICKET_FIELDS = [
  'assigneeId',
  'category',
  'closedAt',
  'code',
  'createdAt',
  'description',
  'dueAt',
  'id',
  'ownerDepartment',
  'screeningId',
  'severity',
  'sourceMessageId',
  'state',
  'title',
  'updatedAt',
];

const NEW_TICKET_FIELDS = [
  'createdBy',
  'departmentId',
  'lifecycleDefinition',
  'lifecycleVersion',
  'reopenCount',
  'resolution',
  'statusChangedAt',
];

const TICKET_FIELDS = [...ORIGINAL_TICKET_FIELDS, ...NEW_TICKET_FIELDS].sort();

const ROUTING_FIELDS = ['category', 'departmentId', 'updatedAt', 'updatedBy'];

/** SQLite 把整数默认值报成字符串 '0'，Postgres 报成 0 / '0'。缺默认值时是 undefined。 */
const asNumber = (value: unknown): number =>
  typeof value === 'number' ? value : Number(value);

const screening = (id: string, outcome: string) => ({
  id,
  messageId: `msg-${id}`,
  category: 'dimension',
  severity: 'minor',
  suggestedOwner: 'quality-dimension',
  summary: `存量草稿 ${id}`,
  confidence: '0.4500',
  evidence: ['尺寸'],
  modelName: 'rule-baseline',
  outcome,
  createdAt: '2026-11-01T00:00:00.000',
  updatedAt: '2026-11-01T00:00:00.000',
});

const ticket = (id: string, screeningId: string | null) => ({
  id,
  code: `T-${id}`,
  title: `存量工单 ${id}`,
  description: null,
  sourceMessageId: null,
  screeningId,
  category: 'dimension',
  severity: 'minor',
  ownerDepartment: 'quality-dimension',
  assigneeId: null,
  state: 'open',
  dueAt: null,
  closedAt: null,
  createdAt: '2026-11-01T00:00:00.000',
  updatedAt: '2026-11-01T00:00:00.000',
});

describe('R-003 验收16/3：工单七列、派单规则表、存量回填与唯一约束', () => {
  describeMigration('202611260003_fqc_ticket_dispatch', {
    sources,
    before: async ({ connection }) => {
      // 迁移之前的草稿：`auto` 要改成 `suggested`，别的取值不动。
      await connection.query
        .insertInto('fqcScreenings')
        .values([
          screening(LEGACY_AUTO_SCREENING, 'auto'),
          screening(LEGACY_REVIEW_SCREENING, 'needs-review'),
        ])
        .execute();

      // 迁移之前的工单：只有旧列，`lifecycleDefinition` 这一列还不存在。
      await connection.query
        .insertInto('fqcTickets')
        .values(ticket(LEGACY_TICKET_ID, LEGACY_AUTO_SCREENING))
        .execute();
    },
    up: async ({ connection, expectCollection }) => {
      const tickets = await expectCollection('fqcTickets').toExist();
      expect(tickets.primaryKey).toEqual(['id']);
      expect(Object.keys(tickets.fields).sort(), '工单的列集合不对').toEqual(
        TICKET_FIELDS,
      );

      await expectCollection('fqcTickets').toHaveField('departmentId', {
        type: 'string',
        length: 64,
        nullable: true,
      });
      await expectCollection('fqcTickets').toHaveField('createdBy', {
        type: 'string',
        length: 64,
        nullable: true,
      });
      await expectCollection('fqcTickets').toHaveField('resolution', {
        type: 'text',
        nullable: true,
      });
      await expectCollection('fqcTickets').toHaveField('reopenCount', {
        type: 'integer',
        nullable: false,
      });
      await expectCollection('fqcTickets').toHaveField('statusChangedAt', {
        type: 'datetimeTz',
        nullable: true,
      });
      await expectCollection('fqcTickets').toHaveField('lifecycleVersion', {
        type: 'integer',
        nullable: false,
      });
      await expectCollection('fqcTickets').toHaveField('lifecycleDefinition', {
        type: 'string',
        length: 64,
        nullable: true,
      });
      await expectCollection('fqcTickets').toHaveIndex(['departmentId']);
      await expectCollection('fqcTickets').toHaveIndex(['screeningId'], {
        unique: true,
      });

      // 默认值在物理列上，Collection 快照看不到。
      const physicalTicket = await connection.schemaInspector.getPhysicalCollection({
        tableName: 'fqc_tickets',
      });
      expect(physicalTicket, 'fqc_tickets 表不在').toBeDefined();
      const column = (name: string) =>
        physicalTicket?.columns.find((entry) => entry.columnName === name);
      expect(
        asNumber(column('reopen_count')?.default?.value),
        'reopenCount 的默认值应当是 0',
      ).toBe(0);
      expect(
        asNumber(column('lifecycle_version')?.default?.value),
        'lifecycleVersion 的默认值应当是 0',
      ).toBe(0);

      const legacy = await connection.query
        .selectFrom('fqcTickets')
        .selectAll()
        .where('id', '=', LEGACY_TICKET_ID)
        .executeTakeFirst();
      expect(legacy, '迁移之前的存量工单不见了').toBeDefined();
      expect(legacy?.state, '存量工单保持 open').toBe('open');
      expect(
        legacy?.lifecycleDefinition,
        '存量工单的 lifecycleDefinition 必须回填成定义的 name，不能留空',
      ).toBe(DEFINITION_NAME);
      expect(asNumber(legacy?.reopenCount), '存量工单的 reopenCount 是 0').toBe(0);
      expect(
        asNumber(legacy?.lifecycleVersion),
        '存量工单的 lifecycleVersion 是 0',
      ).toBe(0);
      for (const field of [
        'departmentId',
        'createdBy',
        'resolution',
        'statusChangedAt',
      ]) {
        expect(legacy?.[field], `存量工单的 ${field} 应当为空`).toBeNull();
      }

      const auto = await connection.query
        .selectFrom('fqcScreenings')
        .selectAll()
        .where('id', '=', LEGACY_AUTO_SCREENING)
        .executeTakeFirst();
      expect(auto?.outcome, '存量 auto 应当改成 suggested').toBe('suggested');
      const review = await connection.query
        .selectFrom('fqcScreenings')
        .selectAll()
        .where('id', '=', LEGACY_REVIEW_SCREENING)
        .executeTakeFirst();
      expect(review?.outcome, 'needs-review 不该被改动').toBe('needs-review');

      // `up` 在回滚再应用后会再跑一次（describeMigration 的行为），先清掉本用例
      // 自己插的行，保证两次执行都从同一状态开始。
      await connection.query
        .deleteFrom('fqcTickets')
        .where('id', 'in', ['r003-defaults', 'r003-null-a', 'r003-null-b'])
        .execute();

      // 不给两个整数列，读回来应是默认值 0。
      await connection.query
        .insertInto('fqcTickets')
        .values(ticket('r003-defaults', null))
        .execute();
      const defaults = await connection.query
        .selectFrom('fqcTickets')
        .selectAll()
        .where('id', '=', 'r003-defaults')
        .executeTakeFirst();
      expect(
        asNumber(defaults?.reopenCount),
        '新行的 reopenCount 默认值应当是 0',
      ).toBe(0);
      expect(
        asNumber(defaults?.lifecycleVersion),
        '新行的 lifecycleVersion 默认值应当是 0',
      ).toBe(0);

      // 空值互不相等，两个空 screeningId 可以并存。
      await expect(
        connection.query
          .insertInto('fqcTickets')
          .values([
            ticket('r003-null-a', null),
            ticket('r003-null-b', null),
          ])
          .execute(),
        'screeningId 为空的两张单应当能并存',
      ).resolves.toBeDefined();

      // 唯一约束真的在库里生效：同一份草稿写第二张单被拒。
      await expect(
        connection.query
          .insertInto('fqcTickets')
          .values(ticket('r003-duplicate', LEGACY_AUTO_SCREENING))
          .execute(),
        '同一份草稿的第二张工单没有被数据库拒绝',
      ).rejects.toThrow();

      const routing = await expectCollection('fqcRoutingRules').toExist();
      expect(routing.primaryKey, '派单规则以 category 为主键').toEqual([
        'category',
      ]);
      expect(Object.keys(routing.fields).sort(), '派单规则的列集合不对').toEqual(
        ROUTING_FIELDS,
      );
      await expectCollection('fqcRoutingRules').toHaveField('category', {
        type: 'string',
        length: 64,
        nullable: false,
      });
      await expectCollection('fqcRoutingRules').toHaveField('departmentId', {
        type: 'string',
        length: 64,
        nullable: false,
      });
      await expectCollection('fqcRoutingRules').toHaveField('updatedAt', {
        type: 'datetime',
        nullable: false,
      });
      await expectCollection('fqcRoutingRules').toHaveField('updatedBy', {
        type: 'string',
        length: 64,
        nullable: false,
      });
    },
    down: async ({ expectCollection }) => {
      await expectCollection('fqcRoutingRules').not.toExist();
      for (const field of NEW_TICKET_FIELDS) {
        await expectCollection('fqcTickets').not.toHaveField(field);
      }
      await expectCollection('fqcTickets').not.toHaveIndex(['departmentId']);
      await expectCollection('fqcTickets').not.toHaveIndex(['screeningId']);
      const tickets = await expectCollection('fqcTickets').toExist();
      expect(
        Object.keys(tickets.fields).sort(),
        'down 之后工单应当回到迁移前的十五列',
      ).toEqual(ORIGINAL_TICKET_FIELDS);
    },
  });
});

/**
 * 回填的 `where lifecycleDefinition is null` 只有在「列已存在、且已有非空值」时才与
 * 无条件更新有区别。正常迁移里这一列是同一次 `up` 刚加的，所有存量行都为空，
 * 从这个夹具出发看不出谓词有没有被去掉。所以这里在一张最小库上先把列建好、
 * 预置一行非空值与一行空值，再直接跑迁移的 `up`：结构变更用桩 builder 替掉，
 * 数据回填那段 `query` 是真的，跑在真库上。
 */
const test = createDatabaseTest();

test(
  'R-003 验收3：存量回填只填空值，不覆盖已有的非空值',
  async ({ connection }) => {
    await connection.builder.createCollection('fqcScreenings', (collection) => {
      collection.string('id', { length: 64 }).notNull();
      collection.string('outcome', { length: 64 }).nullable();
      collection.primary('id');
    });
    await connection.builder.createCollection('fqcTickets', (collection) => {
      collection.string('id', { length: 64 }).notNull();
      collection.string('lifecycleDefinition', { length: 64 }).nullable();
      collection.primary('id');
    });
    await connection.query
      .insertInto('fqcScreenings')
      .values({ id: 'r003-backfill-screening', outcome: 'auto' })
      .execute();
    await connection.query
      .insertInto('fqcTickets')
      .values([
        {
          id: 'r003-custom-definition',
          lifecycleDefinition: 'customDefinition',
        },
        { id: 'r003-empty-definition', lifecycleDefinition: null },
      ])
      .execute();

    // 只让回填那一段跑真 query：结构变更交给桩，不重复加已存在的列。
    const noopBuilder = new Proxy(
      {},
      { get: () => async () => undefined },
    );
    await ticketDispatchMigration.up({
      builder: noopBuilder,
      query: connection.query,
    } as never);

    const rows = await connection.query
      .selectFrom('fqcTickets')
      .select(['id', 'lifecycleDefinition'])
      .where('id', 'in', [
        'r003-custom-definition',
        'r003-empty-definition',
      ])
      .orderBy('id', 'asc')
      .execute();
    const byId = new Map(rows.map((row) => [String(row.id), row]));
    expect(byId.size, '两行存量工单都还在').toBe(2);
    expect(
      byId.get('r003-custom-definition')?.lifecycleDefinition,
      '已有的非空值不该被回填覆盖',
    ).toBe('customDefinition');
    expect(
      byId.get('r003-empty-definition')?.lifecycleDefinition,
      '空值应当回填成生命周期定义的 name',
    ).toBe(DEFINITION_NAME);
  },
);
