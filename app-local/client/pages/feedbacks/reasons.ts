import { ApiClientError } from '@nocobase/app-client';

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** 服务端的原因码到用户能看懂的一句话。400 / 409 / 413 / 415 都走这里。 */
const MESSAGES: Readonly<Record<string, string>> = {
  CUSTOMER_REQUIRED: 'feedbacks.errors.customerRequired',
  TOO_MANY_ATTACHMENTS: 'feedbacks.errors.tooManyAttachments',
  OPERATION_KEY_REQUIRED: 'feedbacks.errors.operationKey',
  OPERATION_CONFLICT: 'feedbacks.errors.operationConflict',
  EMPTY_UPDATE: 'feedbacks.errors.emptyUpdate',
  ATTACHMENT_NOT_AVAILABLE: 'feedbacks.errors.attachmentUnavailable',
  ATTACHMENT_NOT_FOUND: 'feedbacks.errors.attachmentNotFound',
  FEEDBACK_NOT_OPEN: 'feedbacks.errors.notOpen',
  FEEDBACK_DISPATCHED: 'feedbacks.errors.dispatched',
  FEEDBACK_ALREADY_RECORDED: 'feedbacks.errors.alreadyRecorded',
  FEEDBACK_NOT_FOUND: 'feedbacks.errors.notFound',
  FILE_TOO_LARGE: 'feedbacks.errors.fileTooLarge',
  FILE_TYPE_NOT_ALLOWED: 'feedbacks.errors.fileType',
  FILE_REQUIRED: 'feedbacks.errors.fileRequired',
  INVALID_MULTIPART: 'feedbacks.errors.invalidMultipart',
  UNSUPPORTED_MEDIA_TYPE: 'feedbacks.errors.unsupportedMediaType',
  PRINCIPAL_REQUIRED: 'feedbacks.errors.principalRequired',
  AUTHORIZATION_DENIED: 'feedbacks.errors.forbidden',
  READ_FORBIDDEN: 'feedbacks.errors.forbidden',
  WRITE_FORBIDDEN: 'feedbacks.errors.forbidden',
};

/** 状态码到一句话。原因码没认出时按它给话：会话过期、内容不合规都不该让用户看到原因码。 */
const STATUS_MESSAGES: Readonly<Record<number, string>> = {
  401: 'feedbacks.errors.session',
  400: 'feedbacks.errors.invalidInput',
  422: 'feedbacks.errors.invalidInput',
};

/** 校验失败的 `INVALID_INPUT` 带每个字段的具体原因（`fieldViolations[].description`）；没有就只说请检查填写的内容。 */
function inputDetail(error: ApiClientError): string | undefined {
  const body = (error.payload as { error?: { fieldViolations?: unknown } } | undefined)
    ?.error;
  const violations = body?.fieldViolations;
  if (!Array.isArray(violations)) return undefined;
  const descriptions = violations.flatMap((violation) => {
    const description = (violation as { description?: unknown } | null)?.description;
    return typeof description === 'string' && description ? [description] : [];
  });
  return descriptions.join('; ') || undefined;
}

/**
 * 认得原因码就给对应的话；其次按状态码给话；都不是（含服务端以后新增的码）给通用提示并把原因码原样带上，
 * 用户能据此报错。请求根本没发出去（网络断开）时不是 `ApiClientError`，只说网络、不带英文原话。
 */
export function feedbackErrorText(error: unknown, t: Translate): string {
  if (error instanceof ApiClientError) {
    if (error.reason && Object.hasOwn(MESSAGES, error.reason)) return t(MESSAGES[error.reason]);
    if (Object.hasOwn(STATUS_MESSAGES, error.status)) {
      if (STATUS_MESSAGES[error.status] === 'feedbacks.errors.invalidInput') {
        const detail = inputDetail(error);
        if (detail) return t('feedbacks.errors.invalidInputWith', { detail });
      }
      return t(STATUS_MESSAGES[error.status]);
    }
    return t('feedbacks.errors.generic', {
      reason: error.reason ?? String(error.status),
    });
  }
  return t('feedbacks.errors.network');
}
