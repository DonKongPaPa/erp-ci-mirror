import {
  authenticationToken,
  type AuthEnv,
} from '@nocobase/app-plugin-authentication';
import {
  authorizationToken,
  type AuthorizationEnv,
} from '@nocobase/app-plugin-authorization/server';
import type { Application } from '@nocobase/app-server/application';
import { databaseManagerToken } from '@nocobase/db';
import {
  AuthorizationDeniedError,
  type AuthorizationDecision,
  type CompositeResourceConditions,
} from '@nocobase/authorization/core';
import {
  ApiError,
  apiErrorResponse,
  apiValidator,
  defineApiRoutes,
  describeRoute,
  resolver,
  type ApiErrorStatus,
  type AppApiRouteContribution,
} from '@nocobase/app-server/router';
import {
  getRequestLocale,
  getRequestTranslator,
  type Translator,
} from '@nocobase/i18n/server';
import { Hono, type Context } from 'hono';
import { z } from 'zod';

import {
  BIZ_DICT_TYPES,
  bizDictReaderToken,
  DICT_TYPE_LABEL_KEYS,
  BizDictRuleError,
  type BizDictRuleCode,
  type BizDictUpdateInput,
} from '../providers/biz-dict.js';
import { departmentServiceToken } from '../providers/departments.js';
import {
  employeeServiceToken,
  type PersonOption,
} from '../providers/employee-service.js';

type BizDictAction = 'view' | 'manage';
type BizContext = Context<AuthEnv & AuthorizationEnv>;
type BizDecision = AuthorizationDecision<CompositeResourceConditions>;

/** 422 不在框架状态表里，照 R-012/R-020 用 httpStatus 显式指定。 */
const RULE_STATUS: Readonly<
  Record<BizDictRuleCode, { readonly status: ApiErrorStatus; readonly httpStatus?: 422 }>
> = {
  'type-invalid': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'code-taken': { status: 'ALREADY_EXISTS' },
  'code-immutable': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'empty-patch': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'field-not-applicable': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'value-invalid': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'code-inactive': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'not-found': { status: 'NOT_FOUND' },
};

/** 规则码逐项写死，任务书点名的是 `DICT_*` 这套名字。 */
const RULE_REASON: Readonly<Record<BizDictRuleCode, string>> = {
  'type-invalid': 'DICT_TYPE_INVALID',
  'code-taken': 'DICT_CODE_TAKEN',
  'code-immutable': 'DICT_CODE_IMMUTABLE',
  'empty-patch': 'DICT_EMPTY_PATCH',
  'field-not-applicable': 'DICT_FIELD_NOT_APPLICABLE',
  'value-invalid': 'DICT_VALUE_INVALID',
  'code-inactive': 'DICT_VALUE_INVALID',
  'not-found': 'DICT_NOT_FOUND',
};

const camelOf = (code: BizDictRuleCode): string =>
  code.replace(/-([a-z])/gu, (_, letter: string) => letter.toUpperCase());

const objectResponse = (schema: Parameters<typeof resolver>[0], description: string) => ({
  description,
  content: { 'application/json': { schema: resolver(schema) } },
});

const unprocessable = objectResponse(
  z.object({ error: z.object({ reason: z.string(), message: z.string() }) }),
  'The request violates a dictionary rule (422).',
);

function bizDictApiError(
  error: unknown,
  translate: Translator,
  locale: string,
): ApiError {
  if (!(error instanceof BizDictRuleError)) throw error;
  const rule = RULE_STATUS[error.code];
  return new ApiError({
    status: rule.status,
    reason: RULE_REASON[error.code],
    domain: 'bizDict',
    message: error.message,
    localizedMessage: {
      locale,
      message: translate(`bizDict.errors.${camelOf(error.code)}`, {
        reason: error.detail ?? '',
        defaultValue: error.message,
      }),
    },
    metadata: error.detail === undefined ? undefined : { reason: error.detail },
    ...(rule.httpStatus === undefined ? {} : { httpStatus: rule.httpStatus }),
    cause: error,
  });
}

const withMappedErrors = async <T>(
  context: BizContext,
  work: () => Promise<T>,
): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    throw bizDictApiError(
      error,
      getRequestTranslator(context),
      getRequestLocale(context) ?? 'zh-CN',
    );
  }
};

/** 一次请求只授权一次；handler 第一行调用，进服务之前就已经结束。 */
async function authorizeBizDict(
  context: BizContext,
  action: BizDictAction,
): Promise<BizDecision> {
  const decision = await context.get('authz').authorize({
    resource: { type: 'composite', id: 'bizDict' },
    action,
  });
  if (decision.effect === 'deny') {
    throw new AuthorizationDeniedError(decision);
  }
  return decision;
}

async function authorizeBizOptions(context: BizContext): Promise<BizDecision> {
  const decision = await context.get('authz').authorize({
    resource: { type: 'composite', id: 'bizOptions' },
    action: 'view',
  });
  if (decision.effect === 'deny') {
    throw new AuthorizationDeniedError(decision);
  }
  return decision;
}

/** 操作人。`auth.required()` 已挡过未登录，这里是类型收窄的兜底。 */
function actorOf(context: BizContext): string {
  const session = context.get('auth');
  if (session === null) {
    throw new ApiError({
      status: 'UNAUTHENTICATED',
      reason: 'AUTHENTICATION_REQUIRED',
      domain: 'bizDict',
      message: 'An authenticated user is required.',
    });
  }
  return session.user.id;
}

const page = z.coerce.number().int().min(1).default(1);
const pageSize = z.coerce.number().int().min(1).max(100).default(20);
const optionPageSize = z.coerce.number().int().min(1).max(20).default(20);
const dictDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
const dictCode = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/u);
const dictStatus = z.enum(['active', 'inactive']);
/** 列表独有的取值：`all` 只表示在用加已停用，不是一行的状态（PATCH 与响应仍只认 dictStatus）。 */
const listStatus = z.enum(['active', 'inactive', 'all']);

export const EntryListQuery = z.object({
  dictType: z.string().min(1).max(32),
  status: listStatus.optional(),
  q: z.string().min(1).max(128).optional(),
  page,
  pageSize,
});

export const CreateEntryBody = z.object({
  dictType: z.string().min(1).max(32),
  code: dictCode,
  name: z.string().min(1).max(128),
  rate: z.number().optional(),
  startDate: dictDate.optional(),
  endDate: dictDate.optional(),
  description: z.string().max(4000).optional(),
  isDefault: z.boolean().optional(),
  sort: z.number().int().optional(),
});

/** passthrough：路由要先看见不可改的 `code`/`dictType`，不能让 zod 静默剥掉。 */
export const UpdateEntryBody = z
  .object({
    name: z.string().min(1).max(128).optional(),
    rate: z.number().nullable().optional(),
    startDate: dictDate.nullable().optional(),
    endDate: dictDate.nullable().optional(),
    description: z.string().max(4000).nullable().optional(),
    isDefault: z.boolean().optional(),
    sort: z.number().int().optional(),
    status: dictStatus.optional(),
  })
  .passthrough();

export const ReorderBody = z.object({
  dictType: z.string().min(1).max(32),
  ids: z.array(z.string().min(1).max(64)),
});

export const PersonOptionsQuery = z.object({
  q: z.string().min(1).max(64).optional(),
  departmentId: z.string().min(1).max(64).optional(),
  page,
  pageSize: optionPageSize,
});

export const DepartmentOptionsQuery = z.object({
  q: z.string().min(1).max(64).optional(),
});

const EntrySchema = z.object({
  id: z.string(),
  dictType: z.string(),
  code: z.string(),
  name: z.string(),
  rate: z.number().nullable(),
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
  description: z.string().nullable(),
  isDefault: z.boolean(),
  sort: z.number(),
  status: dictStatus,
  createdAt: z.string(),
  updatedAt: z.string(),
});

const paged = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    items: z.array(item),
    total: z.number(),
    page: z.number(),
    pageSize: z.number(),
  });

const EntryListSchema = paged(EntrySchema);
const PersonOptionSchema = z.object({
  userId: z.string(),
  name: z.string().nullable(),
  departmentId: z.string().nullable(),
  departmentName: z.string().nullable(),
});
const DepartmentOptionSchema = z.object({ id: z.string(), name: z.string() });
const TypesSchema = z.object({
  items: z.array(z.object({ dictType: z.string(), label: z.string() })),
});

const UPDATE_KEYS = [
  'name', 'rate', 'startDate', 'endDate', 'description',
  'isDefault', 'sort', 'status',
] as const;

const byName = (left: PersonOption, right: PersonOption): number => {
  const a = left.name ?? '';
  const b = right.name ?? '';
  if (a !== b) return a < b ? -1 : 1;
  return left.userId < right.userId ? -1 : left.userId > right.userId ? 1 : 0;
};

/**
 * R-072 的七条端点：字典五条、选项两条。每条都在 handler 第一行授权，之后才读请求内容、
 * 才碰服务，所以无授权的人发一个非法建单请求得到 403，不是 422/409。
 * 没有 DELETE 路由（停任用 PATCH status）；两条选项端点只回逐列拼出的窄行。
 */
export const apiRoutes: AppApiRouteContribution<Application> = defineApiRoutes(
  (app) => {
    const router = new Hono<AuthEnv & AuthorizationEnv>();
    const auth = app.container.resolve(authenticationToken);
    const authz = app.container.resolve(authorizationToken);
    const reader = app.container.resolve(bizDictReaderToken);
    const employees = app.container.resolve(employeeServiceToken);
    const departments = app.container.resolve(departmentServiceToken);
    const database = app.container.resolve(databaseManagerToken);

    for (const base of [
      '/biz-dict',
      '/biz-dict/*',
      '/person-options',
      '/department-options',
    ]) {
      router.use(base, auth.required(), authz.middleware());
    }

    router.get(
      '/biz-dict/types',
      describeRoute({
        tags: ['Business dictionary'],
        summary: 'List the nine business dictionary types',
        operationId: 'listBizDictTypes',
        responses: {
          '200': objectResponse(TypesSchema, 'The nine types'),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '500': apiErrorResponse(500),
        },
      }),
      async (context) => {
        await authorizeBizDict(context, 'view');
        const translate = getRequestTranslator(context);
        return context.json({
          items: BIZ_DICT_TYPES.map((dictType) => ({
            dictType,
            label: translate(DICT_TYPE_LABEL_KEYS[dictType], {
              defaultValue: dictType,
            }),
          })),
        });
      },
    );

    router.get(
      '/biz-dict/entries',
      describeRoute({
        tags: ['Business dictionary'],
        summary: 'List dictionary entries of one type',
        operationId: 'listBizDictEntries',
        responses: {
          '200': objectResponse(EntryListSchema, 'One page of entries'),
          '400': apiErrorResponse(400),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '422': unprocessable,
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('query', EntryListQuery),
      async (context) => {
        await authorizeBizDict(context, 'view');
        const query = context.req.valid('query');
        const result = await withMappedErrors(context, () =>
          reader.list(query),
        );
        return context.json({ ...result, page: query.page, pageSize: query.pageSize });
      },
    );

    router.post(
      '/biz-dict/entries/reorder',
      describeRoute({
        tags: ['Business dictionary'],
        summary: 'Rewrite the sort order of one dictionary type',
        operationId: 'reorderBizDictEntries',
        responses: {
          '200': objectResponse(EntryListSchema, 'All active entries of the type'),
          '400': apiErrorResponse(400),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '422': unprocessable,
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('json', ReorderBody),
      async (context) => {
        await authorizeBizDict(context, 'manage');
        const body = context.req.valid('json');
        const items = await withMappedErrors(context, () =>
          reader.reorder(body.dictType, body.ids),
        );
        return context.json({ items });
      },
    );

    router.post(
      '/biz-dict/entries',
      describeRoute({
        tags: ['Business dictionary'],
        summary: 'Create a dictionary entry',
        description: 'Requires bizDict.manage. Codes are immutable and unique within a type.',
        operationId: 'createBizDictEntry',
        responses: {
          '201': objectResponse(EntrySchema, 'The created entry'),
          '400': apiErrorResponse(400),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '409': apiErrorResponse(409),
          '422': unprocessable,
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('json', CreateEntryBody),
      async (context) => {
        await authorizeBizDict(context, 'manage');
        const body = context.req.valid('json');
        const row = await withMappedErrors(context, () =>
          reader.create(body, actorOf(context)),
        );
        return context.json(row, 201);
      },
    );

    router.patch(
      '/biz-dict/entries/:id',
      describeRoute({
        tags: ['Business dictionary'],
        summary: 'Update a dictionary entry',
        description:
          'Requires bizDict.manage. The code and dictType are immutable (422); status inactive deactivates the entry.',
        operationId: 'updateBizDictEntry',
        responses: {
          '200': objectResponse(EntrySchema, 'The updated entry'),
          '400': apiErrorResponse(400),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '404': apiErrorResponse(404),
          '422': unprocessable,
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('json', UpdateEntryBody),
      async (context) => {
        await authorizeBizDict(context, 'manage');
        const body = context.req.valid('json');
        if (
          Object.prototype.hasOwnProperty.call(body, 'code') ||
          Object.prototype.hasOwnProperty.call(body, 'dictType')
        ) {
          throw bizDictApiError(
            new BizDictRuleError('code-immutable'),
            getRequestTranslator(context),
            getRequestLocale(context) ?? 'zh-CN',
          );
        }
        const patch: Record<string, unknown> = {};
        for (const key of UPDATE_KEYS) {
          if (Object.prototype.hasOwnProperty.call(body, key)) {
            patch[key] = body[key];
          }
        }
        const row = await withMappedErrors(context, () =>
          reader.update(context.req.param('id'), patch as BizDictUpdateInput),
        );
        return context.json(row);
      },
    );

    router.get(
      '/person-options',
      describeRoute({
        tags: ['Business options'],
        summary: 'Narrow person picker for document assignees',
        description:
          'Requires bizOptions.view. Returns only active employees as userId, name, departmentId and departmentName. q matches names only; email, phone and employee numbers are never read or returned.',
        operationId: 'listPersonOptions',
        responses: {
          '200': objectResponse(paged(PersonOptionSchema), 'One page of people'),
          '400': apiErrorResponse(400),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('query', PersonOptionsQuery),
      async (context) => {
        // 先授权后读内容：这一行在任何取数之前。
        await authorizeBizOptions(context);
        const { q, departmentId, page: currentPage, pageSize: size } =
          context.req.valid('query');

        let allowed: Set<string> | undefined;
        if (departmentId !== undefined) {
          allowed = new Set(await departments.memberIdsOf(departmentId));
        }
        let rows = await employees.activePersonOptions(
          allowed === undefined ? undefined : [...allowed],
        );
        if (q !== undefined) {
          const term = q.toLowerCase();
          rows = rows.filter((row) => (row.name ?? '').toLowerCase().includes(term));
        }
        rows = [...rows].sort(byName);
        const total = rows.length;
        return context.json({
          items: rows.slice((currentPage - 1) * size, currentPage * size),
          total,
          page: currentPage,
          pageSize: size,
        });
      },
    );

    router.get(
      '/department-options',
      describeRoute({
        tags: ['Business options'],
        summary: 'Narrow department picker for document headers',
        description:
          'Requires bizOptions.view. Returns only active departments as id and name.',
        operationId: 'listDepartmentOptions',
        responses: {
          '200': objectResponse(
            z.object({ items: z.array(DepartmentOptionSchema) }),
            'The active departments',
          ),
          '400': apiErrorResponse(400),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('query', DepartmentOptionsQuery),
      async (context) => {
        await authorizeBizOptions(context);
        const { q } = context.req.valid('query');
        const rows = await database
          .repository<{ id: string; title: string; active: boolean; sortOrder: number }>(
            'departments',
          )
          .findMany({ filter: { active: true } });
        const term = q?.toLowerCase();
        const items = rows
          .filter(
            (row) => term === undefined || row.title.toLowerCase().includes(term),
          )
          .sort((left, right) =>
            left.sortOrder !== right.sortOrder
              ? left.sortOrder - right.sortOrder
              : left.title < right.title
                ? -1
                : left.title > right.title
                  ? 1
                  : 0,
          )
          .map((row) => ({ id: row.id, name: row.title }));
        return context.json({ items });
      },
    );

    return new Hono().route('/', router);
  },
);
