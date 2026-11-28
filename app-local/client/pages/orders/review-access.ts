import { useCan } from '@nocobase/app-plugin-authorization/client';

/** 页签与页内按钮全部按会话实际持有的动作决定，不按角色名猜。 */
export interface ReviewAccess {
  readonly view: boolean;
  readonly create: boolean;
  readonly submit: boolean;
  readonly confirm: boolean;
  readonly personOptions: boolean;
  readonly pending: boolean;
}

export function useReviewAccess(): ReviewAccess {
  const view = useCan({ resource: { type: 'composite', id: 'orderReviews' }, action: 'view' });
  const create = useCan({ resource: { type: 'composite', id: 'orderReviews' }, action: 'create' });
  const submit = useCan({ resource: { type: 'composite', id: 'orderReviews' }, action: 'submit' });
  const confirm = useCan({ resource: { type: 'composite', id: 'orderReviews' }, action: 'confirm' });
  // 选评审人走 R-072 的收窄人员选项端点，不授予「用户 · 读」。
  const options = useCan({ resource: { type: 'composite', id: 'bizOptions' }, action: 'view' });
  return {
    view: view.can,
    create: create.can,
    submit: submit.can,
    confirm: confirm.can,
    personOptions: options.can,
    pending:
      view.isPending ||
      create.isPending ||
      submit.isPending ||
      confirm.isPending ||
      options.isPending,
  };
}
