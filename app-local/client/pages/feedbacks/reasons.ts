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
  AUTHORIZATION_DENIED: 'feedbacks.errors.forbidden',
  READ_FORBIDDEN: 'feedbacks.errors.forbidden',
  WRITE_FORBIDDEN: 'feedbacks.errors.forbidden',
};

/**
 * 认得原因码就给对应的话；认不出（含服务端以后新增的码）给通用提示并把原因码原样带上，
 * 用户能据此报错，测试也不会把「随便一句成功提示」当成错误处理。
 */
export function feedbackErrorText(error: unknown, t: Translate): string {
  if (error instanceof ApiClientError) {
    const key = error.reason ? MESSAGES[error.reason] : undefined;
    if (key) return t(key);
    return t('feedbacks.errors.generic', {
      reason: error.reason ?? String(error.status),
    });
  }
  return t('feedbacks.errors.generic', { reason: String(error) });
}
