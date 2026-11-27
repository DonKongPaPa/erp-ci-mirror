import {
  authenticationToken,
  type AuthEnv,
} from '@nocobase/app-plugin-authentication';
import {
  authorizationToken,
  type AuthorizationEnv,
} from '@nocobase/app-plugin-authorization/server';
import type { Application } from '@nocobase/app-server/application';
import {
  ApiError,
  apiErrorResponse,
  apiValidator,
  defineApiRoutes,
  describeRoute,
  type AppApiRouteContribution,
} from '@nocobase/app-server/router';
import { Hono } from 'hono';

import {
  CreateUnitBody,
  DictionaryListQuery,
  UnitListSchema,
  UnitSchema,
  UpdateUnitBody,
} from './schemas.js';
import {
  itemsMutationsToken,
  itemsReaderToken,
} from '../providers/items.js';
import {
  authorizeItems,
  itemRuleError,
  missingItem,
  objectResponse,
  unprocessableResponse,
  withItemErrors,
} from './items.js';

/** PATCH 一项都没带时由端点映射成 422 ITEM_EMPTY_PATCH（zod passthrough）。 */
function emptyPatch(context: Parameters<typeof itemRuleError>[0]): ApiError {
  return itemRuleError(context, 'empty-patch');
}

/**
 * R-019 计量单位的四个端点。授权与物料共用 `items` 资源，先授权后读内容；
 * 单位只停用不删除，被物料引用时停用返回 422 UNIT_IN_USE。
 */
export const apiRoutes: AppApiRouteContribution<Application> = defineApiRoutes(
  (app) => {
    const router = new Hono<AuthEnv & AuthorizationEnv>();
    const auth = app.container.resolve(authenticationToken);
    const authz = app.container.resolve(authorizationToken);
    const reader = app.container.resolve(itemsReaderToken);
    const mutations = app.container.resolve(itemsMutationsToken);

    for (const base of ['/units', '/units/*']) {
      router.use(base, auth.required(), authz.middleware());
    }

    router.get(
      '/units',
      describeRoute({
        tags: ['Units'],
        summary: 'List units of measure',
        description:
          'Requires items.view. Paginated 20 per page, at most 100; q matches code and name; status filters active/inactive. Sorted by code ascending.',
        operationId: 'listUnits',
        responses: {
          '200': objectResponse(UnitListSchema, 'One page of units'),
          '400': apiErrorResponse(400),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('query', DictionaryListQuery),
      async (context) => {
        await authorizeItems(context, 'view');
        const query = context.req.valid('query');
        const result = await reader.listUnits(query);
        return context.json({
          items: result.items,
          total: result.total,
          page: query.page,
          pageSize: query.pageSize,
        });
      },
    );

    router.get(
      '/units/:code',
      describeRoute({
        tags: ['Units'],
        summary: 'Read one unit',
        operationId: 'readUnit',
        responses: {
          '200': objectResponse(UnitSchema, 'The unit'),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '404': apiErrorResponse(404),
          '500': apiErrorResponse(500),
        },
      }),
      async (context) => {
        await authorizeItems(context, 'view');
        const row = await reader.unitDetail(context.req.param('code'));
        if (row === undefined) throw missingItem(context, 'unit-not-found');
        return context.json(row);
      },
    );

    router.post(
      '/units',
      describeRoute({
        tags: ['Units'],
        summary: 'Create a unit of measure',
        description:
          'Requires items.manage. The short code is final, globally unique and never reused. No delete route exists.',
        operationId: 'createUnit',
        responses: {
          '201': objectResponse(UnitSchema, 'The created unit'),
          '400': apiErrorResponse(400),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '409': apiErrorResponse(409),
          '422': unprocessableResponse,
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('json', CreateUnitBody),
      async (context) => {
        await authorizeItems(context, 'manage');
        const row = await withItemErrors(context, async () =>
          mutations.createUnit(context.req.valid('json')),
        );
        return context.json(row, 201);
      },
    );

    router.patch(
      '/units/:code',
      describeRoute({
        tags: ['Units'],
        summary: 'Rename, rescale or deactivate a unit',
        description:
          'Requires items.manage. A unit referenced by any item cannot be deactivated (422 UNIT_IN_USE). No delete route exists.',
        operationId: 'updateUnit',
        responses: {
          '200': objectResponse(UnitSchema, 'The updated unit'),
          '400': apiErrorResponse(400),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '404': apiErrorResponse(404),
          '422': unprocessableResponse,
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('json', UpdateUnitBody),
      async (context) => {
        await authorizeItems(context, 'manage');
        const body = context.req.valid('json');
        if (Object.keys(body).length === 0) throw emptyPatch(context);
        const row = await withItemErrors(context, async () =>
          mutations.updateUnit(context.req.param('code'), body),
        );
        return context.json(row);
      },
    );

    return new Hono().route('/', router);
  },
);
