import { ApiClientError } from '@nocobase/app-client';

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** 工单动作的服务端原因码到一句话。流转的守卫码与派单、改判的拒绝码都在这里。 */
const MESSAGES: Readonly<Record<string, string>> = {
  INVALID_TRANSITION: 'quality.ticketErrors.INVALID_TRANSITION',
  ASSIGNED_TO_OTHER: 'quality.ticketErrors.ASSIGNED_TO_OTHER',
  DEPARTMENT_OUT_OF_SCOPE: 'quality.ticketErrors.DEPARTMENT_OUT_OF_SCOPE',
  DEPARTMENT_DISABLED: 'quality.ticketErrors.DEPARTMENT_DISABLED',
  ASSIGNEE_NOT_DEPARTMENT_MEMBER:
    'quality.ticketErrors.ASSIGNEE_NOT_DEPARTMENT_MEMBER',
  TICKET_CLOSED: 'quality.ticketErrors.TICKET_CLOSED',
  SCREENING_ALREADY_DISPATCHED:
    'quality.ticketErrors.SCREENING_ALREADY_DISPATCHED',
  USE_REASSIGN: 'quality.ticketErrors.USE_REASSIGN',
  ROUTING_RULE_MISSING: 'quality.ticketErrors.ROUTING_RULE_MISSING',
  AUTHORIZATION_DENIED: 'quality.ticketErrors.forbidden',
  READ_FORBIDDEN: 'quality.ticketErrors.forbidden',
  WRITE_FORBIDDEN: 'quality.ticketErrors.forbidden',
};

/**
 * 认得原因码就给对应的话；认不出给通用提示并带上原因码，用户能据此报错。
 * 与反馈单页的 `feedbackErrorText` 同一套做法，不共用一份是因为两页的码集不同。
 */
export function ticketErrorText(error: unknown, t: Translate): string {
  if (error instanceof ApiClientError) {
    const key = error.reason ? MESSAGES[error.reason] : undefined;
    if (key) return t(key);
    return t('quality.ticketErrors.generic', {
      reason: error.reason ?? String(error.status),
    });
  }
  return t('quality.ticketErrors.generic', { reason: String(error) });
}
