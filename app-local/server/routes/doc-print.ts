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
  resolver,
  type AppApiRouteContribution,
} from '@nocobase/app-server/router';
import { Hono, type Context } from 'hono';

import {
  PRINT_DOC_TYPES,
  type PrintDocTypePath,
} from '../doc-print-resources.js';
import {
  DocPrintRuleError,
  docPrintToken,
  type DocPrintService,
} from '../providers/doc-print.js';
import {
  PrintDataSchema,
  PrintDocParam,
  PrintMarkSchema,
} from './doc-print-schemas.js';

type PrintContext = Context<AuthEnv & AuthorizationEnv>;

const objectResponse = (schema: Parameters<typeof resolver>[0], description: string) => ({
  description,
  content: { 'application/json': { schema: resolver(schema) } },
});

/** 403 不带任何单据内容，也不回显 docNo：错误体只有规则码与文案。 */
function denied(): ApiError {
  return new ApiError({
    status: 'PERMISSION_DENIED',
    reason: 'NO_PERMISSION',
    domain: 'docPrint',
    message: 'You do not have permission to print this document.',
  });
}

function ruleError(error: unknown): ApiError {
  if (!(error instanceof DocPrintRuleError)) throw error;
  if (error.code === 'doc-type-invalid') {
    return new ApiError({
      status: 'NOT_FOUND', reason: 'PRINT_DOC_TYPE_INVALID', domain: 'docPrint',
      message: 'Unknown document type for printing.',
      ...(error.detail === undefined ? {} : { metadata: { reason: error.detail } }),
    });
  }
  if (error.code === 'doc-not-found') {
    return new ApiError({
      status: 'NOT_FOUND', reason: 'PRINT_DOC_NOT_FOUND', domain: 'docPrint',
      message: 'That document does not exist for this print type.',
    });
  }
  return new ApiError({
    status: 'ABORTED', reason: 'PRINT_MARK_CONFLICT', domain: 'docPrint',
    httpStatus: 409,
    message: 'The print mark could not be recorded; retry.',
  });
}

/** 先授权、后读内容：两个动作分别判定，缺 print 一律 403，不发任何查询。 */
async function authorizePrint(
  context: PrintContext,
  resource: string,
  action: 'print' | 'printPrice',
): Promise<boolean> {
  const decision = await context.get('authz').authorize({
    resource: { type: 'composite', id: resource },
    action,
  });
  if (action === 'print' && decision.effect === 'deny') throw denied();
  return decision.effect !== 'deny';
}

function actorOf(context: PrintContext): string {
  const session = context.get('auth');
  if (session === null) {
    throw new ApiError({
      status: 'UNAUTHENTICATED', reason: 'AUTHENTICATION_REQUIRED',
      domain: 'docPrint', message: 'An authenticated user is required.',
    });
  }
  return session.user.id;
}

function configOf(context: PrintContext): {
  readonly config: (typeof PRINT_DOC_TYPES)[PrintDocTypePath];
  readonly docNo: string;
} {
  const docType = context.req.param('docType');
  const config = PRINT_DOC_TYPES[docType as PrintDocTypePath];
  if (config === undefined) {
    throw ruleError(new DocPrintRuleError('doc-type-invalid', docType));
  }
  return { config, docNo: context.req.param('docNo') ?? '' };
}

/**
 * R-076 的四个端点：三条只读打印数据 + 一条追加痕迹。先授权、后读内容；
 * 不提供删除，也没有改痕迹的反向端点。
 */
export const apiRoutes: AppApiRouteContribution<Application> = defineApiRoutes(
  (app) => {
    const router = new Hono<AuthEnv & AuthorizationEnv>();
    const auth = app.container.resolve(authenticationToken);
    const authz = app.container.resolve(authorizationToken);
    const service: DocPrintService = app.container.resolve(docPrintToken);

    for (const base of ['/doc-print', '/doc-print/*']) {
      router.use(base, auth.required(), authz.middleware());
    }

    const readRoute = (
      path: '/doc-print/internal-use/:docNo' | '/doc-print/sales-issue/:docNo' | '/doc-print/purchase-receipt/:docNo',
      docType: PrintDocTypePath,
      operationId: string,
      summary: string,
    ) => {
      router.get(
        path,
        describeRoute({
          tags: ['Document print'],
          summary,
          description: 'Requires the matching print action; price keys require printPrice too. The response never carries document data without print.',
          operationId,
          responses: {
            '200': objectResponse(PrintDataSchema, 'The print-ready document'),
            '401': apiErrorResponse(401),
            '403': apiErrorResponse(403),
            '404': apiErrorResponse(404),
            '500': apiErrorResponse(500),
          },
        }),
        apiValidator('param', PrintDocParam),
        async (context) => {
          const config = PRINT_DOC_TYPES[docType];
          await authorizePrint(context, config.resource, 'print');
          const withPrice = await authorizePrint(context, config.resource, 'printPrice');
          try {
            return context.json(
              await service.read(context.req.param('docNo') ?? '', config.reason, withPrice),
            );
          } catch (error) {
            throw ruleError(error);
          }
        },
      );
    };

    readRoute('/doc-print/internal-use/:docNo', 'internal-use', 'getInternalUsePrintData', 'Print data of one internal issue');
    readRoute('/doc-print/sales-issue/:docNo', 'sales-issue', 'getSalesIssuePrintData', 'Print data of one sales issue');
    readRoute('/doc-print/purchase-receipt/:docNo', 'purchase-receipt', 'getPurchaseReceiptPrintData', 'Print data of one purchase receipt');

    router.post(
      '/doc-print/:docType/:docNo/print-mark',
      describeRoute({
        tags: ['Document print'],
        summary: 'Append one print mark to a document',
        description: 'Requires the matching print action. Increments printCount and writes the time and actor in one transaction; no delete endpoint exists.',
        operationId: 'markDocPrint',
        responses: {
          '201': objectResponse(PrintMarkSchema, 'The updated print trace'),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '404': apiErrorResponse(404),
          '409': apiErrorResponse(409),
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('param', PrintDocParam),
      async (context) => {
        // docType 非法先回 404，不给内容；合法时再按对应资源授权。
        const { config, docNo } = configOf(context);
        await authorizePrint(context, config.resource, 'print');
        try {
          return context.json(
            await service.mark(docNo, config.reason, actorOf(context)),
            201,
          );
        } catch (error) {
          throw ruleError(error);
        }
      },
    );

    return new Hono().route('/', router);
  },
);
