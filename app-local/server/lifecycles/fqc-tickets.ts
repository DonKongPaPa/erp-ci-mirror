import {
  defineLifecycle,
  type JsonObject,
  type Lifecycle,
  type LifecycleRecord,
} from '@nocobase/lifecycle';

import { inTicketScope, type TicketScope } from '../ticket-scope.js';

/**
 * R-003 S5：工单的 lifecycle 定义。
 *
 * `name` 必须是 `fqcTickets`：迁移 202611260003 把存量工单的 `lifecycleDefinition`
 * 回填成了这个 name，运行时 `checkBinding` 拿记录上的值与 `lifecycle.name` 比，
 * 对不上直接抛 `DEFINITION_MISMATCH`（`plan.js:105-124`）。`key` / `version` 不写进
 * 这一列。五个状态都有出路，所以一个终态都不标（框架允许）。
 *
 * 状态仍在工单自己的 `state` 列：`stateField: 'state'`，changedAt 与 version 用默认
 * 名 `statusChangedAt` / `lifecycleVersion`，与 S1 迁移一致。**没有 `dueAt` 字段、
 * 没有 `triggers`**：验收 15 的不做时限由这里钉住。
 *
 * guard 是业务规则不是权限：端点仍要先按「处理工单」授权并按数据范围取到工单，
 * 范围外的行与不存在同形（404）。这里的 guard 只管「指派给别人时谁能点」与转派的
 * 目标部门是否合法；失败码由端点映射成设计里的状态码。
 */
export type FqcTicketState =
  | 'open'
  | 'in_progress'
  | 'resolved'
  | 'reopened'
  | 'closed';

export interface FqcTicket extends LifecycleRecord {
  readonly state: FqcTicketState;
  readonly departmentId: string | null;
  readonly assigneeId: string | null;
  readonly resolution: string | null;
  readonly reopenCount: number;
}

export interface FqcTicketServices {
  /** 脱离请求按主体授权，解析调用者在工单表上的部门范围。 */
  scopeOf(actorId: string): Promise<TicketScope | null>;
  departmentActive(departmentId: string): Promise<boolean>;
  memberOf(departmentId: string, userId: string): Promise<boolean>;
}

export interface FqcTicketTypes {
  record: FqcTicket;
  state: FqcTicketState;
  parameters: Record<string, never>;
  services: FqcTicketServices;
}

/** 已经指派给别人时，只有那个人能受理或解决；没有经办人时任何人。 */
const assigneeMayAct = (record: FqcTicket, actorId: string) =>
  record.assigneeId === null ||
  record.assigneeId === undefined ||
  record.assigneeId === actorId ||
  {
    code: 'ASSIGNED_TO_OTHER',
    message: 'This ticket is assigned to someone else.',
  };

const nonEmpty = (input: JsonObject, field: string) =>
  typeof input[field] === 'string' && input[field].trim().length > 0;

/** 从 input 安全取字符串：形状校验只认字符串，别把 Object 串成 [object Object]。 */
const textOf = (input: JsonObject, field: string): string => {
  const value = input[field];
  return typeof value === 'string' ? value : '';
};

export const fqcTicketsLifecycle: Lifecycle<FqcTicketTypes> =
  defineLifecycle<FqcTicketTypes>({
    name: 'fqcTickets',
    key: 'fqcTickets',
    version: 1,
    definitionField: 'lifecycleDefinition',
    stateField: 'state',
    initial: 'open',
    states: ['open', 'in_progress', 'resolved', 'reopened', 'closed'],
    transitions: {
      accept: {
        from: ['open', 'reopened'],
        to: 'in_progress',
        // 「可以带经办人，不带就是自己」。经办人只走 set：先收敛成非空字符串，
        // 再校验他是责任部门成员。不能用 accept: ['assigneeId'] —— 框架会把 input
        // 原样写列（'' / 123 / true 分别落成 '' / '123' / 'true'），绕过校验且卡死
        // 后续 resolve。带了非法值时这里拒绝（422），不带才回落到受理人自己。
        guard: async ({ record, actor, input, services }) => {
          const mayAct = assigneeMayAct(record, actor.id);
          if (mayAct !== true) return mayAct;
          if (Object.prototype.hasOwnProperty.call(input, 'assigneeId')) {
            if (!nonEmpty(input, 'assigneeId')) {
              return {
                code: 'ASSIGNEE_NOT_DEPARTMENT_MEMBER',
                message: 'The assignee must be a non-empty user id.',
              };
            }
            const assigneeId = textOf(input, 'assigneeId');
            const departmentId = record.departmentId ?? '';
            if (!(await services.memberOf(departmentId, assigneeId))) {
              return {
                code: 'ASSIGNEE_NOT_DEPARTMENT_MEMBER',
                message: 'The assignee is not a member of the responsible department.',
              };
            }
          }
          return true;
        },
        set: ({ input, actor }) => ({
          assigneeId: nonEmpty(input, 'assigneeId')
            ? textOf(input, 'assigneeId')
            : actor.id,
        }),
      },
      resolve: {
        from: 'in_progress',
        to: 'resolved',
        guard: ({ record, actor }) => assigneeMayAct(record, actor.id),
        validate: (input) =>
          nonEmpty(input, 'resolution')
            ? null
            : [{ field: 'resolution', message: 'A processing note is required.' }],
        accept: ['resolution'],
      },
      close: {
        from: 'resolved',
        to: 'closed',
        // 「可以带一句备注」只落在流转日志的 input 里，工单没有备注列。
        set: () => ({ closedAt: new Date() }),
      },
      reopen: {
        from: ['resolved', 'closed'],
        to: 'reopened',
        validate: (input) =>
          nonEmpty(input, 'reason')
            ? null
            : [{ field: 'reason', message: 'A reopen reason is required.' }],
        // 原因留在流转日志的 input 里；工单只记次数与关闭时间的复位。
        set: ({ record }) => ({
          reopenCount: (Number(record.reopenCount) || 0) + 1,
          closedAt: null,
        }),
      },
      reassign: {
        from: ['open', 'in_progress'],
        to: ['open', 'in_progress'],
        // 原地自转移：route 选回原状态，version 前进一行、留一条日志、也能挡并发。
        route: ({ record }) => record.state,
        validate: (input) =>
          nonEmpty(input, 'departmentId')
            ? null
            : [{ field: 'departmentId', message: 'A new department is required.' }],
        guard: async ({ record, actor, input, services }) => {
          const departmentId = textOf(input, 'departmentId');
          if (record.state !== 'open' && record.state !== 'in_progress') {
            return {
              code: 'INVALID_TRANSITION',
              message: 'This ticket cannot be reassigned in its current state.',
            };
          }
          const scope = await services.scopeOf(actor.id);
          if (!inTicketScope(scope, departmentId)) {
            return {
              code: 'DEPARTMENT_OUT_OF_SCOPE',
              message: 'The target department is outside your ticket scope.',
            };
          }
          if (!(await services.departmentActive(departmentId))) {
            return {
              code: 'DEPARTMENT_DISABLED',
              message: 'The target department is disabled.',
            };
          }
          const assigneeId = nonEmpty(input, 'assigneeId')
            ? textOf(input, 'assigneeId')
            : null;
          if (
            assigneeId !== null &&
            !(await services.memberOf(departmentId, assigneeId))
          ) {
            return {
              code: 'ASSIGNEE_NOT_DEPARTMENT_MEMBER',
              message: 'The assignee is not a member of the new department.',
            };
          }
          return true;
        },
        set: ({ input }) => {
          const values: Record<string, unknown> = {
            departmentId: textOf(input, 'departmentId'),
          };
          if (nonEmpty(input, 'assigneeId')) {
            values.assigneeId = textOf(input, 'assigneeId');
          }
          return values;
        },
      },
    },
  });
