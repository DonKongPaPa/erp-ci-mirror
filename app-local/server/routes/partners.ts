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
  AuthorizationDeniedError,
  type CompositeResourceConditions,
  type AuthorizationDecision,
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

import {
  ContactSchema,
  CreateContactBody,
  CreatePartnerBody,
  PartnerDetailSchema,
  PartnerListQuery,
  PartnerListSchema,
  PartnerSchema,
  UpdateContactBody,
  UpdatePartnerBody,
} from './schemas.js';
import {
  PartnerRuleError,
  partnerMutationsToken,
  partnerReaderToken,
  type PartnerKindResource,
  type PartnerRuleCode,
} from '../providers/partners.js';

type PartnerAction = 'view' | 'create' | 'update';
type PartnerContext = Context<AuthEnv & AuthorizationEnv>;
type PartnerDecision = AuthorizationDecision<CompositeResourceConditions>;

/** 422 不在框架状态表里，显式给 httpStatus（照 routes/shifts.ts）。 */
const RULE_STATUS: Readonly<
  Record<PartnerRuleCode, { readonly status: ApiErrorStatus; readonly httpStatus?: 422 }>
> = {
  'kind-required': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'invalid-name': { status: 'INVALID_ARGUMENT' },
  'code-taken': { status: 'ALREADY_EXISTS' },
  'partner-not-found': { status: 'NOT_FOUND' },
  'partner-inactive': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'contact-not-found': { status: 'NOT_FOUND' },
  'invalid-update': { status: 'INVALID_ARGUMENT' },
};

const reasonOf = (code: PartnerRuleCode): string =>
  `PARTNER_${code.replaceAll('-', '_').toUpperCase()}`;

const camelOf = (code: PartnerRuleCode): string =>
  code.replace(/-([a-z])/gu, (_, letter: string) => letter.toUpperCase());

const objectResponse = (schema: Parameters<typeof resolver>[0], description: string) => ({
  description,
  content: { 'application/json': { schema: resolver(schema) } },
});

const unprocessableResponse = objectResponse(
  PartnerSchema,
  'The request violates a partner rule (422).',
);

function partnerApiError(
  error: unknown,
  translate: Translator,
  locale: string,
): ApiError {
  if (!(error instanceof PartnerRuleError)) {
    throw error;
  }
  const rule = RULE_STATUS[error.code];
  return new ApiError({
    status: rule.status,
    reason: reasonOf(error.code),
    domain: 'partners',
    message: error.message,
    localizedMessage: {
      locale,
      message: translate(`partners.errors.${camelOf(error.code)}`, {
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
  context: PartnerContext,
  work: () => Promise<T>,
): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    throw partnerApiError(
      error,
      getRequestTranslator(context),
      getRequestLocale(context) ?? 'zh-CN',
    );
  }
};

/**
 * 一次请求可能要判两个资源（没给 kind 时客户与供应商都要问）。
 * 先把授权问完再看内容：任何内容校验、查库都在 authorize 之后。
 */
async function allowedResources(
  context: PartnerContext,
  candidates: readonly PartnerKindResource[],
  action: PartnerAction,
): Promise<{
  readonly allowed: readonly PartnerKindResource[];
  readonly firstDeny: PartnerDecision | undefined;
}> {
  const decisions = await Promise.all(
    candidates.map(async (resource) => ({
      resource,
      decision: await context.get('authz').authorize({
        resource: { type: 'composite', id: resource },
        action,
      }),
    })),
  );
  return {
    allowed: decisions
      .filter(({ decision }) => decision.effect !== 'deny')
      .map(({ resource }) => resource),
    firstDeny: decisions.find(({ decision }) => decision.effect === 'deny')?.decision,
  };
}

function requireAllowed(
  resource: PartnerKindResource,
  allowed: readonly PartnerKindResource[],
  firstDeny: PartnerDecision | undefined,
): void {
  if (!allowed.includes(resource)) {
    if (firstDeny === undefined) {
      throw new ApiError({
        status: 'PERMISSION_DENIED',
        reason: 'PARTNER_FORBIDDEN',
        domain: 'partners',
        message: 'You cannot access this partner.',
      });
    }
    throw new AuthorizationDeniedError(firstDeny);
  }
}

const resourceOfKind = (
  kind: 'customer' | 'supplier' | undefined,
): PartnerKindResource => (kind === 'supplier' ? 'suppliers' : 'customers');

const resourceOfPartner = (row: {
  readonly isCustomer: boolean;
  readonly isSupplier: boolean;
}): PartnerKindResource => (row.isCustomer ? 'customers' : 'suppliers');

const matchesResource = (
  row: { readonly isCustomer: boolean; readonly isSupplier: boolean },
  resource: PartnerKindResource,
): boolean =>
  resource === 'customers' ? row.isCustomer : row.isSupplier;

function missingPartner(): ApiError {
  return new ApiError({
    status: 'NOT_FOUND',
    reason: 'PARTNER_NOT_FOUND',
    domain: 'partners',
    message: 'The partner does not exist.',
  });
}

/**
 * R-014 MVP 的六个端点：客户 `customers.*`，供应商 `suppliers.*`，root 全部。
 * 没有删除端点（用停用代替）。授权在 handler 最前面完成，无授权的人即使内容非法
 * 也先拿到 403，不会从 409/422 里探出信息（同 routes/shifts.ts）。
 */
export const apiRoutes: AppApiRouteContribution<Application> = defineApiRoutes(
  (app) => {
    const router = new Hono<AuthEnv & AuthorizationEnv>();
    const auth = app.container.resolve(authenticationToken);
    const authz = app.container.resolve(authorizationToken);
    const reader = app.container.resolve(partnerReaderToken);
    const mutations = app.container.resolve(partnerMutationsToken);

    for (const base of ['/partners', '/partners/*']) {
      router.use(base, auth.required(), authz.middleware());
    }

    router.get(
      '/partners',
      describeRoute({
        tags: ['Partners'],
        summary: 'List customers or suppliers',
        description:
          'Requires customers.view or suppliers.view. kind filters isCustomer / isSupplier; q matches name and code; status filters active / inactive. Sorted by code, paginated 20 per page, at most 100.',
        operationId: 'listPartners',
        responses: {
          '200': objectResponse(PartnerListSchema, 'One page of partners'),
          '400': apiErrorResponse(400),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('query', PartnerListQuery),
      async (context) => {
        const query = context.req.valid('query');
        const candidates: readonly PartnerKindResource[] =
          query.kind === undefined
            ? ['customers', 'suppliers']
            : [resourceOfKind(query.kind)];
        const { allowed, firstDeny } = await allowedResources(
          context,
          candidates,
          'view',
        );
        if (allowed.length === 0) {
          throw new AuthorizationDeniedError(firstDeny!);
        }
        const result = await reader.list({
          kind: query.kind,
          q: query.q,
          status: query.status,
          page: query.page,
          pageSize: query.pageSize,
        });
        const items =
          query.kind === undefined
            ? result.items.filter((row) =>
                allowed.some((resource) => matchesResource(row, resource)),
              )
            : result.items;
        return context.json({
          items,
          total: query.kind === undefined ? items.length : result.total,
          page: query.page,
          pageSize: query.pageSize,
        });
      },
    );

    router.get(
      '/partners/:id',
      describeRoute({
        tags: ['Partners'],
        summary: 'Read one partner with its contacts',
        operationId: 'readPartner',
        responses: {
          '200': objectResponse(PartnerDetailSchema, 'The partner and its contacts'),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '404': apiErrorResponse(404),
          '500': apiErrorResponse(500),
        },
      }),
      async (context) => {
        const { allowed, firstDeny } = await allowedResources(
          context,
          ['customers', 'suppliers'],
          'view',
        );
        if (allowed.length === 0) {
          throw new AuthorizationDeniedError(firstDeny!);
        }
        const row = await reader.detail(context.req.param('id'));
        if (row === undefined) {
          throw missingPartner();
        }
        requireAllowed(resourceOfPartner(row), allowed, firstDeny);
        return context.json(row);
      },
    );

    router.post(
      '/partners',
      describeRoute({
        tags: ['Partners'],
        summary: 'Create a customer or supplier',
        description:
          'Requires customers.create / suppliers.create for every flag in the body. The code is issued by the R-016 code service in the same transaction (CU for customers, SU for suppliers, CU when both). No delete route exists.',
        operationId: 'createPartner',
        responses: {
          '201': objectResponse(PartnerSchema, 'The created partner'),
          '400': apiErrorResponse(400),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '409': apiErrorResponse(409),
          '422': unprocessableResponse,
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('json', CreatePartnerBody),
      async (context) => {
        const body = context.req.valid('json');
        const needed: readonly PartnerKindResource[] = [
          ...(body.isCustomer ? (['customers'] as const) : []),
          ...(body.isSupplier ? (['suppliers'] as const) : []),
        ];
        const candidates: readonly PartnerKindResource[] =
          needed.length === 0 ? ['customers'] : needed;
        const { allowed, firstDeny } = await allowedResources(
          context,
          candidates,
          'create',
        );
        // 没给任何标志时也要先授权再报 422：否则无授权的人能从一个空请求里探出规则码。
        for (const resource of candidates) {
          requireAllowed(resource, allowed, firstDeny);
        }
        const session = context.get('auth');
        const row = await withMappedErrors(context, async () =>
          mutations.create(body, session?.user?.id),
        );
        return context.json(row, 201);
      },
    );

    router.patch(
      '/partners/:id',
      describeRoute({
        tags: ['Partners'],
        summary: 'Edit a partner or change its status',
        description:
          'Requires customers.update / suppliers.update for the partner kind. The code and the customer/supplier flags cannot change. Use status inactive instead of deleting.',
        operationId: 'updatePartner',
        responses: {
          '200': objectResponse(PartnerSchema, 'The updated partner'),
          '400': apiErrorResponse(400),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '404': apiErrorResponse(404),
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('json', UpdatePartnerBody),
      async (context) => {
        const { allowed, firstDeny } = await allowedResources(
          context,
          ['customers', 'suppliers'],
          'update',
        );
        if (allowed.length === 0) {
          throw new AuthorizationDeniedError(firstDeny!);
        }
        const row = await reader.detail(context.req.param('id'));
        if (row === undefined) {
          throw missingPartner();
        }
        requireAllowed(resourceOfPartner(row), allowed, firstDeny);
        const updated = await withMappedErrors(context, async () =>
          mutations.update(context.req.param('id'), context.req.valid('json')),
        );
        return context.json(updated);
      },
    );

    router.post(
      '/partners/:id/contacts',
      describeRoute({
        tags: ['Partners'],
        summary: 'Add a contact to an active partner',
        operationId: 'createPartnerContact',
        responses: {
          '200': objectResponse(ContactSchema, 'The created contact'),
          '400': apiErrorResponse(400),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '404': apiErrorResponse(404),
          '422': unprocessableResponse,
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('json', CreateContactBody),
      async (context) => {
        const { allowed, firstDeny } = await allowedResources(
          context,
          ['customers', 'suppliers'],
          'update',
        );
        if (allowed.length === 0) {
          throw new AuthorizationDeniedError(firstDeny!);
        }
        const partner = await reader.detail(context.req.param('id'));
        if (partner === undefined) {
          throw missingPartner();
        }
        requireAllowed(resourceOfPartner(partner), allowed, firstDeny);
        const contact = await withMappedErrors(context, async () =>
          mutations.createContact(context.req.param('id'), context.req.valid('json')),
        );
        return context.json(contact);
      },
    );

    router.patch(
      '/partners/:id/contacts/:contactId',
      describeRoute({
        tags: ['Partners'],
        summary: 'Edit a contact of an active partner',
        operationId: 'updatePartnerContact',
        responses: {
          '200': objectResponse(ContactSchema, 'The updated contact'),
          '400': apiErrorResponse(400),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '404': apiErrorResponse(404),
          '422': unprocessableResponse,
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('json', UpdateContactBody),
      async (context) => {
        const { allowed, firstDeny } = await allowedResources(
          context,
          ['customers', 'suppliers'],
          'update',
        );
        if (allowed.length === 0) {
          throw new AuthorizationDeniedError(firstDeny!);
        }
        const partner = await reader.detail(context.req.param('id'));
        if (partner === undefined) {
          throw missingPartner();
        }
        requireAllowed(resourceOfPartner(partner), allowed, firstDeny);
        const contact = await withMappedErrors(context, async () =>
          mutations.updateContact(
            context.req.param('id'),
            context.req.param('contactId'),
            context.req.valid('json'),
          ),
        );
        return context.json(contact);
      },
    );

    return new Hono().route('/', router);
  },
);
