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
  CategoryListSchema,
  CategorySchema,
  CreateCategoryBody,
  DictionaryListQuery,
  UpdateCategoryBody,
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

function emptyPatch(context: Parameters<typeof itemRuleError>[0]): ApiError {
  return itemRuleError(context, 'empty-patch');
}

/**
 * R-019 物料分类的四个端点。授权与物料共用 `items` 资源，先授权后读内容；
 * 分类只用一层，但 parentId 列留着，指向自己返回 422 CATEGORY_INVALID_PARENT。
 */
export const apiRoutes: AppApiRouteContribution<Application> = defineApiRoutes(
  (app) => {
    const router = new Hono<AuthEnv & AuthorizationEnv>();
    const auth = app.container.resolve(authenticationToken);
    const authz = app.container.resolve(authorizationToken);
    const reader = app.container.resolve(itemsReaderToken);
    const mutations = app.container.resolve(itemsMutationsToken);

    for (const base of ['/item-categories', '/item-categories/*']) {
      router.use(base, auth.required(), authz.middleware());
    }

    router.get(
      '/item-categories',
      describeRoute({
        tags: ['Item categories'],
        summary: 'List item categories',
        description:
          'Requires items.view. Paginated 20 per page, at most 100; q matches code and name; status filters active/inactive. Sorted by code ascending.',
        operationId: 'listItemCategories',
        responses: {
          '200': objectResponse(CategoryListSchema, 'One page of categories'),
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
        const result = await reader.listCategories(query);
        return context.json({
          items: result.items,
          total: result.total,
          page: query.page,
          pageSize: query.pageSize,
        });
      },
    );

    router.get(
      '/item-categories/:id',
      describeRoute({
        tags: ['Item categories'],
        summary: 'Read one item category',
        operationId: 'readItemCategory',
        responses: {
          '200': objectResponse(CategorySchema, 'The category'),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '404': apiErrorResponse(404),
          '500': apiErrorResponse(500),
        },
      }),
      async (context) => {
        await authorizeItems(context, 'view');
        const row = await reader.categoryDetail(context.req.param('id'));
        if (row === undefined) throw missingItem(context, 'category-not-found');
        return context.json(row);
      },
    );

    router.post(
      '/item-categories',
      describeRoute({
        tags: ['Item categories'],
        summary: 'Create an item category',
        description:
          'Requires items.manage. The code is final and globally unique. parentId may point at another category; pointing at itself is rejected.',
        operationId: 'createItemCategory',
        responses: {
          '201': objectResponse(CategorySchema, 'The created category'),
          '400': apiErrorResponse(400),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '409': apiErrorResponse(409),
          '422': unprocessableResponse,
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('json', CreateCategoryBody),
      async (context) => {
        await authorizeItems(context, 'manage');
        const row = await withItemErrors(context, async () =>
          mutations.createCategory(context.req.valid('json')),
        );
        return context.json(row, 201);
      },
    );

    router.patch(
      '/item-categories/:id',
      describeRoute({
        tags: ['Item categories'],
        summary: 'Rename, reparent or deactivate an item category',
        operationId: 'updateItemCategory',
        responses: {
          '200': objectResponse(CategorySchema, 'The updated category'),
          '400': apiErrorResponse(400),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '404': apiErrorResponse(404),
          '422': unprocessableResponse,
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('json', UpdateCategoryBody),
      async (context) => {
        await authorizeItems(context, 'manage');
        const body = context.req.valid('json');
        if (Object.keys(body).length === 0) throw emptyPatch(context);
        const row = await withItemErrors(context, async () =>
          mutations.updateCategory(context.req.param('id'), body),
        );
        return context.json(row);
      },
    );

    return new Hono().route('/', router);
  },
);
