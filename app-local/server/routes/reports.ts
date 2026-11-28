import {
  authenticationToken,
  type AuthEnv,
} from '@nocobase/app-plugin-authentication';
import {
  authorizationToken,
  type AuthorizationEnv,
} from '@nocobase/app-plugin-authorization/server';
import type { Application } from '@nocobase/app-server/application';
import type { AuthorizationDecision } from '@nocobase/authorization/core';
import { databaseManagerToken } from '@nocobase/db';
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
  getRequestTranslator,
} from '@nocobase/i18n/server';
import { Hono, type Context as HonoContext } from 'hono';
import { z } from 'zod';

import { shanghaiNow } from '../providers/doc-print.js';
import {
  DatabaseReportEngine,
  parseSpec,
  ReportRuleError,
  sha256Of,
  reportEngineToken,
  type ActionChecker,
  type LoadedDefinition,
  type ReportBrief,
  type ReportRuleCode,
  type RunReportInput,
} from '../providers/report-engine.js';
import {
  ExportTraceListSchema, FavoriteListSchema, FavoriteSchema,
  ReportListQuery, ReportListSchema, ReportResultSchema,
  ReportSchemaSchema, RunReportBody, TraceListQuery,
} from './reports-schemas.js';

type Context = HonoContext<AuthEnv & AuthorizationEnv>;
type Decision = AuthorizationDecision;

const RULE: Readonly<Record<ReportRuleCode, { status: ApiErrorStatus; reason: string; httpStatus?: 400 | 403 | 404 | 500 }>> = {
  'report-not-found': { status: 'NOT_FOUND', reason: 'REPORT_NOT_FOUND', httpStatus: 404 },
  'report-forbidden': { status: 'PERMISSION_DENIED', reason: 'REPORT_FORBIDDEN', httpStatus: 403 },
  'field-invalid': { status: 'INVALID_ARGUMENT', reason: 'REPORT_FIELD_INVALID', httpStatus: 400 },
  'page-invalid': { status: 'INVALID_ARGUMENT', reason: 'REPORT_PAGE_INVALID', httpStatus: 400 },
  'export-failed': { status: 'INTERNAL', reason: 'REPORT_EXPORT_FAILED', httpStatus: 500 },
};

function denied(): ApiError {
  return new ApiError({
    status: 'PERMISSION_DENIED', reason: 'NO_PERMISSION',
    domain: 'reports', message: 'You do not have permission to use reports.',
    httpStatus: 403,
  });
}

function ruleError(error: unknown): ApiError {
  if (!(error instanceof ReportRuleError)) throw error;
  const config = RULE[error.code];
  return new ApiError({
    status: config.status, reason: config.reason, domain: 'reports',
    message: error.message,
    ...(config.httpStatus === undefined ? {} : { httpStatus: config.httpStatus }),
    cause: error,
  });
}

async function withErrors<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw ruleError(error);
  }
}

const decide = async (
  context: Context, resource: string, action: string,
): Promise<Decision> =>
  await context.get('authz').authorize({ resource: { type: 'composite', id: resource }, action });

const require = async (context: Context, resource: string, action: string): Promise<void> => {
  if ((await decide(context, resource, action)).effect === 'deny') throw denied();
};

const allowsFor = (context: Context): ActionChecker => async (specification) => {
  const { resource, action } = parseSpec(specification);
  return (await decide(context, resource, action)).effect !== 'deny';
};

const actorOf = (context: Context): string => {
  const session = context.get('auth');
  if (session === null) {
    throw new ApiError({
      status: 'UNAUTHENTICATED', reason: 'AUTHENTICATION_REQUIRED',
      domain: 'reports', message: 'An authenticated user is required.', httpStatus: 401,
    });
  }
  return String(session.user.id);
};

/** 先做入口动作，再读定义；定义存在后才按 baseActions 二次判定，最后才取数。 */
async function load(
  context: Context, engine: DatabaseReportEngine, key: string, entryAction: string,
): Promise<LoadedDefinition> {
  await require(context, 'reports', entryAction);
  const definition = await withErrors(async () => await engine.definition(key));
  if (definition === undefined) throw ruleError(new ReportRuleError('report-not-found'));
  await withErrors(async () => await engine.assertBase(definition, allowsFor(context)));
  return definition;
}

function inputOf(body: z.infer<typeof RunReportBody>): RunReportInput {
  return {
    filters: body.filters,
    ...(body.dimensions === undefined ? {} : { dimensions: body.dimensions }),
    ...(body.measures === undefined ? {} : { measures: body.measures }),
    page: body.page ?? 1,
    pageSize: body.pageSize ?? 20,
  };
}

function csvOf(
  columns: readonly { key: string; labelKey: string }[],
  rows: readonly Record<string, string | number | null>[],
  translate: (key: string, options?: { defaultValue?: string }) => string,
): string {
  const cell = (value: unknown): string => {
    let raw = '';
    if (typeof value === 'string') raw = value;
    else if (typeof value === 'number' || typeof value === 'boolean') raw = String(value);
    else if (value !== null && value !== undefined) raw = JSON.stringify(value);
    return /[",\r\n]/u.test(raw) ? `"${raw.replaceAll('"', '""')}"` : raw;
  };
  const lines = [columns.map((column) => cell(translate(column.labelKey, {
    defaultValue: column.key,
  }))).join(',')];
  for (const row of rows) lines.push(columns.map((column) => cell(row[column.key])).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

const objectResponse = (schema: Parameters<typeof resolver>[0], description: string) => ({
  description,
  content: { 'application/json': { schema: resolver(schema) } },
});

export const apiRoutes: AppApiRouteContribution<Application> = defineApiRoutes((app) => {
  const router = new Hono<AuthEnv & AuthorizationEnv>();
  const auth = app.container.resolve(authenticationToken);
  const authz = app.container.resolve(authorizationToken);
  const engine = app.container.resolve(reportEngineToken);
  const database = app.container.resolve(databaseManagerToken);
  for (const base of ['/reports', '/reports/*']) {
    router.use(base, auth.required(), authz.middleware());
  }

  // 静态段先登记，避免被 /reports/:key/* 吞掉。
  router.get(
    '/reports/favorites',
    describeRoute({
      tags: ['Reports'], summary: 'List favorite reports', operationId: 'listReportFavorites',
      responses: {
        '200': objectResponse(FavoriteListSchema, 'Favorite report briefs'),
        '401': apiErrorResponse(401), '403': apiErrorResponse(403), '500': apiErrorResponse(500),
      },
    }),
    async (context) => {
      await require(context, 'reports', 'view');
      return context.json({ items: await engine.favorites(actorOf(context)) });
    },
  );

  router.get(
    '/reports/export-traces',
    describeRoute({
      tags: ['Reports'], summary: 'List export traces', operationId: 'listExportTraces',
      responses: {
        '200': objectResponse(ExportTraceListSchema, 'Export traces visible to the caller'),
        '401': apiErrorResponse(401), '403': apiErrorResponse(403), '500': apiErrorResponse(500),
      },
    }),
    apiValidator('query', TraceListQuery),
    async (context) => {
      await require(context, 'reports', 'view');
      const query = context.req.valid('query');
      const page = query.page ?? 1;
      const pageSize = query.pageSize ?? 20;
      const session = context.get('auth');
      const unrestricted = (await context.get('authz').snapshot()).unrestricted;
      const result = await engine.traces({
        ...query, page, pageSize,
      }, actorOf(context), unrestricted && session !== null);
      return context.json({ ...result, page, pageSize });
    },
  );

  router.get(
    '/reports',
    describeRoute({
      tags: ['Reports'], summary: 'List report definitions', operationId: 'listReports',
      responses: {
        '200': objectResponse(ReportListSchema, 'Reports the caller may see'),
        '401': apiErrorResponse(401), '403': apiErrorResponse(403), '500': apiErrorResponse(500),
      },
    }),
    apiValidator('query', ReportListQuery),
    async (context) => {
      await require(context, 'reports', 'view');
      const query = context.req.valid('query');
      const page = query.page ?? 1;
      const pageSize = query.pageSize ?? 20;
      const allows = allowsFor(context);
      const { items } = await engine.definitions({ ...query, page, pageSize });
      const visible: ReportBrief[] = [];
      for (const definition of items) {
        const decisions = await Promise.all(definition.baseActions.map((action: string) => allows(action)));
        if (decisions.some(Boolean)) {
          visible.push({
            key: definition.key, titleKey: definition.titleKey,
            category: definition.category,
          });
        }
      }
      return context.json({ items: visible, total: visible.length, page, pageSize });
    },
  );

  router.get(
    '/reports/:key/schema',
    describeRoute({
      tags: ['Reports'], summary: 'Read one report schema', operationId: 'readReportSchema',
      responses: {
        '200': objectResponse(ReportSchemaSchema, 'Trimmed dimensions, measures and columns'),
        '401': apiErrorResponse(401), '403': apiErrorResponse(403),
        '404': apiErrorResponse(404), '500': apiErrorResponse(500),
      },
    }),
    async (context) => {
      const definition = await load(context, engine, context.req.param('key'), 'view');
      const columns = await engine.columnsFor(
        definition, definition.dimensions, definition.measures, allowsFor(context),
      );
      return context.json({
        dimensions: definition.dimensions, measures: definition.measures, columns,
      });
    },
  );

  router.post(
    '/reports/:key/run',
    describeRoute({
      tags: ['Reports'], summary: 'Run one report', operationId: 'runReport',
      responses: {
        '200': objectResponse(ReportResultSchema, 'Trimmed columns and rows'),
        '400': apiErrorResponse(400), '401': apiErrorResponse(401),
        '403': apiErrorResponse(403), '404': apiErrorResponse(404), '500': apiErrorResponse(500),
      },
    }),
    apiValidator('json', RunReportBody),
    async (context) => {
      const definition = await load(context, engine, context.req.param('key'), 'run');
      const result = await withErrors(async () => await engine.run(
        definition, inputOf(context.req.valid('json')),
        allowsFor(context),
      ));
      return context.json(result);
    },
  );

  router.post(
    '/reports/:key/export',
    describeRoute({
      tags: ['Reports'], summary: 'Export one report as CSV', operationId: 'exportReport',
      responses: {
        '200': { description: 'CSV with a trace row', content: { 'text/csv': { schema: { type: 'string' } } } },
        '400': apiErrorResponse(400), '401': apiErrorResponse(401),
        '403': apiErrorResponse(403), '404': apiErrorResponse(404), '500': apiErrorResponse(500),
      },
    }),
    apiValidator('json', RunReportBody),
    async (context) => {
      const actor = actorOf(context);
      const definition = await load(context, engine, context.req.param('key'), 'export');
      const input = inputOf(context.req.valid('json'));
      const csv = await withErrors(async () => await database.transaction(async (transaction) => {
        const { columns, rows } = await engine.table(definition, input, allowsFor(context));
        const text = csvOf(columns, rows, (key, options) =>
          getRequestTranslator(context)(key, options));
        await engine.insertTrace(transaction, {
          userId: actor, reportKey: definition.key, at: shanghaiNow(),
          filtersHash: sha256Of({ filters: input.filters, dimensions: input.dimensions, measures: input.measures }),
          rowCount: rows.length,
        });
        return text;
      }));
      const filename = `${definition.key}.csv`;
      return new Response(csv, {
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="${filename}"`,
        },
      });
    },
  );

  router.post(
    '/reports/:key/favorite',
    describeRoute({
      tags: ['Reports'], summary: 'Favorite one report', operationId: 'favoriteReport',
      responses: {
        '200': objectResponse(FavoriteSchema, 'Idempotent favorite'),
        '401': apiErrorResponse(401), '403': apiErrorResponse(403),
        '404': apiErrorResponse(404), '500': apiErrorResponse(500),
      },
    }),
    async (context) => {
      await require(context, 'reports', 'favorite');
      await withErrors(async () => await engine.favorite(actorOf(context), context.req.param('key')));
      return context.json({ favorited: true });
    },
  );

  router.delete(
    '/reports/:key/favorite',
    describeRoute({
      tags: ['Reports'], summary: 'Remove one favorite report', operationId: 'unfavoriteReport',
      responses: {
        '200': objectResponse(FavoriteSchema, 'Favorite removed'),
        '401': apiErrorResponse(401), '403': apiErrorResponse(403), '500': apiErrorResponse(500),
      },
    }),
    async (context) => {
      await require(context, 'reports', 'favorite');
      await engine.unfavorite(actorOf(context), context.req.param('key'));
      return context.json({ favorited: false });
    },
  );

  return new Hono().route('/', router);
});
