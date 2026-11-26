import path from 'node:path';
import { describeMigration } from '@nocobase/app-testing/server';
import { describe, expect } from 'vitest';

/**
 * R-011 验收17：四张员工表由一条迁移建出，列逐项钉在物理结构上。
 *
 * 一条新迁移建 employees、employeeChanges、positions、jobGrades，照设计
 * R-011.md:58-109。字段的类型、长度、可空性逐项断言（含三列日期是 date，
 * 没有时分秒）；默认值靠真插一行读回来钉住，因为 expectCollection 不读默认值。
 * 唯一约束与索引也逐项钉：userId、employeeNo 各唯一，reportsToUserId 与
 * employeeChanges.userId 各一个普通索引，字典表没有索引。
 *
 * 档案表不存姓名、用户名、邮箱、停用状态：字段清单里没有这些列，全部字段
 * 都在下面列出，多一列也会红。四张表都不建外键。
 *
 * describeMigration 会按名字顺序先应用 0001～0003 再应用本迁移，因此这条用例
 * 同时钉住迁移链 0001→0004 依次应用无冲突；down 之后四张表连约束索引一起消失。
 */
const sources = [
  {
    packageName: 'employees-migration-test',
    directory: path.resolve(
      import.meta.dirname,
      '../../database/main/migrations',
    ),
  },
];

const EMPLOYEE_FIELDS = [
  'createdAt',
  'employeeNo',
  'gradeId',
  'hiredOn',
  'id',
  'leftOn',
  'positionId',
  'reportsToUserId',
  'status',
  'updatedAt',
  'userId',
];

const CHANGE_FIELDS = [
  'actorId',
  'createdAt',
  'fromValue',
  'id',
  'kind',
  'note',
  'occurredOn',
  'toValue',
  'userId',
];

const POSITION_FIELDS = [
  'active',
  'createdAt',
  'id',
  'sortOrder',
  'title',
  'updatedAt',
];

const GRADE_FIELDS = [
  'active',
  'createdAt',
  'id',
  'rank',
  'title',
  'updatedAt',
];

/** 员工档案一行：工号、入职日期与在职状态必填，上级与岗位职级可空。 */
const employee = (id: string, userId: string, employeeNo: string) => ({
  id,
  userId,
  employeeNo,
  positionId: null,
  gradeId: null,
  reportsToUserId: null,
  hiredOn: '2026-11-20',
  leftOn: null,
  status: 'active',
  createdAt: '2026-11-20T09:00:00.000',
  updatedAt: '2026-11-20T09:00:00.000',
});

describe('R-011 验收17：员工档案、变动记录与两本字典的迁移', () => {
  describeMigration('202611260004_create_employees', {
    sources,
    up: async ({ connection, expectCollection }) => {
      const employees = await expectCollection('employees').toExist();
      expect(employees.primaryKey).toEqual(['id']);
      expect(Object.keys(employees.fields).sort()).toEqual(EMPLOYEE_FIELDS);
      await expectCollection('employees').toHaveField('id', {
        type: 'string',
        length: 64,
        nullable: false,
      });
      await expectCollection('employees').toHaveField('userId', {
        type: 'string',
        length: 64,
        nullable: false,
      });
      await expectCollection('employees').toHaveField('employeeNo', {
        type: 'string',
        length: 16,
        nullable: false,
      });
      await expectCollection('employees').toHaveField('positionId', {
        type: 'string',
        length: 64,
        nullable: true,
      });
      await expectCollection('employees').toHaveField('gradeId', {
        type: 'string',
        length: 32,
        nullable: true,
      });
      await expectCollection('employees').toHaveField('reportsToUserId', {
        type: 'string',
        length: 64,
        nullable: true,
      });
      // 三列日期是 date，不是 datetime：只到日，不带时分秒。
      await expectCollection('employees').toHaveField('hiredOn', {
        type: 'date',
        nullable: false,
      });
      await expectCollection('employees').toHaveField('leftOn', {
        type: 'date',
        nullable: true,
      });
      await expectCollection('employees').toHaveField('status', {
        type: 'string',
        length: 16,
        nullable: false,
      });
      await expectCollection('employees').toHaveField('createdAt', {
        type: 'datetime',
        nullable: false,
      });
      await expectCollection('employees').toHaveField('updatedAt', {
        type: 'datetime',
        nullable: false,
      });
      await expectCollection('employees').toHaveIndex(['userId'], {
        unique: true,
      });
      await expectCollection('employees').toHaveIndex(['employeeNo'], {
        unique: true,
      });
      await expectCollection('employees').toHaveIndex(['reportsToUserId']);
      expect(employees.indexes).toHaveLength(3);
      expect(employees.foreignKeys).toHaveLength(0);

      const changes = await expectCollection('employeeChanges').toExist();
      expect(changes.primaryKey).toEqual(['id']);
      expect(Object.keys(changes.fields).sort()).toEqual(CHANGE_FIELDS);
      await expectCollection('employeeChanges').toHaveField('id', {
        type: 'string',
        length: 64,
        nullable: false,
      });
      await expectCollection('employeeChanges').toHaveField('userId', {
        type: 'string',
        length: 64,
        nullable: false,
      });
      await expectCollection('employeeChanges').toHaveField('kind', {
        type: 'string',
        length: 32,
        nullable: false,
      });
      await expectCollection('employeeChanges').toHaveField('fromValue', {
        type: 'string',
        length: 128,
        nullable: true,
      });
      await expectCollection('employeeChanges').toHaveField('toValue', {
        type: 'string',
        length: 128,
        nullable: true,
      });
      await expectCollection('employeeChanges').toHaveField('occurredOn', {
        type: 'date',
        nullable: false,
      });
      await expectCollection('employeeChanges').toHaveField('note', {
        type: 'string',
        length: 500,
        nullable: true,
      });
      await expectCollection('employeeChanges').toHaveField('actorId', {
        type: 'string',
        length: 64,
        nullable: false,
      });
      await expectCollection('employeeChanges').toHaveField('createdAt', {
        type: 'datetime',
        nullable: false,
      });
      await expectCollection('employeeChanges').toHaveIndex(['userId']);
      expect(changes.indexes).toHaveLength(1);
      expect(changes.foreignKeys).toHaveLength(0);

      const positions = await expectCollection('positions').toExist();
      expect(positions.primaryKey).toEqual(['id']);
      expect(Object.keys(positions.fields).sort()).toEqual(POSITION_FIELDS);
      await expectCollection('positions').toHaveField('id', {
        type: 'string',
        length: 64,
        nullable: false,
      });
      await expectCollection('positions').toHaveField('title', {
        type: 'string',
        length: 128,
        nullable: false,
      });
      await expectCollection('positions').toHaveField('active', {
        type: 'boolean',
        nullable: false,
      });
      await expectCollection('positions').toHaveField('sortOrder', {
        type: 'integer',
        nullable: false,
      });
      await expectCollection('positions').toHaveField('createdAt', {
        type: 'datetime',
        nullable: false,
      });
      await expectCollection('positions').toHaveField('updatedAt', {
        type: 'datetime',
        nullable: false,
      });
      expect(positions.indexes).toHaveLength(0);
      expect(positions.foreignKeys).toHaveLength(0);

      const grades = await expectCollection('jobGrades').toExist();
      expect(grades.primaryKey).toEqual(['id']);
      expect(Object.keys(grades.fields).sort()).toEqual(GRADE_FIELDS);
      await expectCollection('jobGrades').toHaveField('id', {
        type: 'string',
        length: 32,
        nullable: false,
      });
      await expectCollection('jobGrades').toHaveField('title', {
        type: 'string',
        length: 128,
        nullable: false,
      });
      await expectCollection('jobGrades').toHaveField('rank', {
        type: 'integer',
        nullable: false,
      });
      await expectCollection('jobGrades').toHaveField('active', {
        type: 'boolean',
        nullable: false,
      });
      await expectCollection('jobGrades').toHaveField('createdAt', {
        type: 'datetime',
        nullable: false,
      });
      await expectCollection('jobGrades').toHaveField('updatedAt', {
        type: 'datetime',
        nullable: false,
      });
      expect(grades.indexes).toHaveLength(0);
      expect(grades.foreignKeys).toHaveLength(0);

      // 默认值靠真插一行读回来：status 默认 active，字典默认启用、排序为 0。
      await connection.query
        .insertInto('employees')
        .values({
          id: 'r011-employee-1',
          userId: 'r011-user-1',
          employeeNo: 'E000001',
          hiredOn: '2026-11-20',
          leftOn: null,
          createdAt: '2026-11-20T09:00:00.000',
          updatedAt: '2026-11-20T09:00:00.000',
        })
        .execute();
      const first = await connection.query
        .selectFrom('employees')
        .selectAll()
        .where('id', '=', 'r011-employee-1')
        .executeTakeFirst();
      expect(first?.status, 'status 的默认值应当是 active').toBe('active');
      expect(first?.positionId).toBeNull();
      expect(first?.gradeId).toBeNull();
      expect(first?.reportsToUserId).toBeNull();
      expect(String(first?.hiredOn)).toMatch(
        /^\d{4}-\d{2}-\d{2}$/,
        'hiredOn 只到日，不带时分秒',
      );

      // 同一个账号的第二份档案、重复的工号都要被数据库拒绝。
      await expect(
        connection.query
          .insertInto('employees')
          .values(employee('r011-employee-2', 'r011-user-1', 'E000002'))
          .execute(),
        '同一个账号写进了第二份档案',
      ).rejects.toThrow();
      await expect(
        connection.query
          .insertInto('employees')
          .values(employee('r011-employee-3', 'r011-user-2', 'E000001'))
          .execute(),
        '重复的工号写进了第二份档案',
      ).rejects.toThrow();

      await connection.query
        .insertInto('positions')
        .values({
          id: 'quality',
          title: '质量部',
          createdAt: '2026-11-20T09:00:00.000',
          updatedAt: '2026-11-20T09:00:00.000',
        })
        .execute();
      const position = await connection.query
        .selectFrom('positions')
        .selectAll()
        .where('id', '=', 'quality')
        .executeTakeFirst();
      expect(position?.active, 'active 的默认值应当是真').toBe(true);
      expect(Number(position?.sortOrder), 'sortOrder 的默认值应当是 0').toBe(0);

      await connection.query
        .insertInto('jobGrades')
        .values({
          id: 'g7',
          title: '七级',
          createdAt: '2026-11-20T09:00:00.000',
          updatedAt: '2026-11-20T09:00:00.000',
        })
        .execute();
      const grade = await connection.query
        .selectFrom('jobGrades')
        .selectAll()
        .where('id', '=', 'g7')
        .executeTakeFirst();
      expect(grade?.active, 'active 的默认值应当是真').toBe(true);
      expect(Number(grade?.rank), 'rank 的默认值应当是 0').toBe(0);

      await connection.query
        .insertInto('employeeChanges')
        .values({
          id: 'r011-change-1',
          userId: 'r011-user-1',
          kind: 'hired',
          fromValue: null,
          toValue: null,
          occurredOn: '2026-11-20',
          note: null,
          actorId: 'r011-admin',
          createdAt: '2026-11-20T09:00:00.000',
        })
        .execute();
      const change = await connection.query
        .selectFrom('employeeChanges')
        .selectAll()
        .where('id', '=', 'r011-change-1')
        .executeTakeFirst();
      expect(String(change?.occurredOn)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(change?.fromValue).toBeNull();
      expect(change?.note).toBeNull();
    },
    down: async ({ expectCollection }) => {
      await expectCollection('employees').not.toExist();
      await expectCollection('employeeChanges').not.toExist();
      await expectCollection('positions').not.toExist();
      await expectCollection('jobGrades').not.toExist();
    },
  });
});
