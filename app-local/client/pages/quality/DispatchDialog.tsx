import { useApiClient, useToaster } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { Loader2 } from 'lucide-react';
import { useMemo, useState, type ReactElement } from 'react';

import { Alert, AlertDescription } from '#components/ui/alert';
import { Button } from '#components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '#components/ui/dialog';
import { Label } from '#components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '#components/ui/select';

import {
  QualityClient,
  type DispatchedTicket,
  type QualityScreening,
} from './client.js';
import { ColleagueSearch } from './ColleagueSearch.js';
import { CATEGORIES, SEVERITIES } from './model.js';
import { ticketErrorText } from './ticket-errors.js';
import {
  departmentsUnavailable,
  useTicketDepartments,
} from './use-departments.js';

/** 责任部门的「按派单规则」哨兵：不选部门时由服务端按规则取，草稿的路由键不参与。 */
const BY_RULE = 'by-rule';
const UNSPECIFIED = 'unspecified';

/**
 * 确认并派单（R-003 验收 17）：每一份未派单的草稿从这里变成工单。
 * 点开能改类别、严重度、责任部门、经办人；留空的字段由服务端按
 * 请求 → 确认记录 → 派单规则的顺序取值。同一份草稿的第二张单由服务端 409 挡下。
 */
export function DispatchDialog({
  screening,
  client: providedClient,
  onClose,
  onDispatched,
}: {
  readonly screening: QualityScreening;
  /** 测试可以注入客户端；运行时由组件自己取。 */
  readonly client?: QualityClient;
  readonly onClose: () => void;
  readonly onDispatched: (ticket: DispatchedTicket) => void;
}): ReactElement {
  const { t } = useTranslation();
  const toaster = useToaster();
  const api = useApiClient();
  const client = useMemo(() => providedClient ?? new QualityClient(api), [providedClient, api]);
  const [category, setCategory] = useState(screening.category ?? UNSPECIFIED);
  const [severity, setSeverity] = useState(screening.severity ?? UNSPECIFIED);
  const [departmentId, setDepartmentId] = useState(BY_RULE);
  const [assigneeId, setAssigneeId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const departments = useTicketDepartments(client, true);
  const { options } = departments;
  // 类别与严重度必选（草稿没给时在表单里选）：没选好之前不提交。
  const valuesMissing = category === UNSPECIFIED || severity === UNSPECIFIED;

  const submit = async (): Promise<void> => {
    if (saving) return;
    if (category === UNSPECIFIED || severity === UNSPECIFIED) {
      setError(t('quality.dispatch.requiredValues'));
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      const ticket = await client.dispatch(screening.id, {
        category,
        severity,
        ...(departmentId === BY_RULE ? {} : { departmentId }),
        ...(assigneeId === null ? {} : { assigneeId }),
      });
      toaster.show({ type: 'success', title: t('quality.dispatch.saved') });
      onDispatched(ticket);
      onClose();
    } catch (next) {
      setError(ticketErrorText(next, t));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (!open && !saving ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('quality.dispatch.title')}</DialogTitle>
          <DialogDescription>
            {t('quality.dispatch.description')}
          </DialogDescription>
        </DialogHeader>
        <div className='flex flex-col gap-3'>
          <div className='flex flex-col gap-1'>
            <Label htmlFor='dispatch-category'>
              {t('quality.dispatch.category')}
            </Label>
            <Select
              items={[UNSPECIFIED, ...CATEGORIES].map((value) => ({
                value,
                label:
                  value === UNSPECIFIED
                    ? t('quality.dispatch.unspecified')
                    : t(`quality.categories.${value}`),
              }))}
              value={category}
              onValueChange={(value) => setCategory(value as string)}
            >
              <SelectTrigger id='dispatch-category' className='w-48'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={UNSPECIFIED}>
                  {t('quality.dispatch.unspecified')}
                </SelectItem>
                {CATEGORIES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {t(`quality.categories.${value}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className='flex flex-col gap-1'>
            <Label htmlFor='dispatch-severity'>
              {t('quality.dispatch.severity')}
            </Label>
            <Select
              items={[UNSPECIFIED, ...SEVERITIES].map((value) => ({
                value,
                label:
                  value === UNSPECIFIED
                    ? t('quality.dispatch.unspecified')
                    : t(`quality.severities.${value}`),
              }))}
              value={severity}
              onValueChange={(value) => setSeverity(value as string)}
            >
              <SelectTrigger id='dispatch-severity' className='w-48'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={UNSPECIFIED}>
                  {t('quality.dispatch.unspecified')}
                </SelectItem>
                {SEVERITIES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {t(`quality.severities.${value}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className='flex flex-col gap-1'>
            <Label htmlFor='dispatch-department'>
              {t('quality.dispatch.department')}
            </Label>
            <Select
              items={[BY_RULE, ...options].map((option) => ({
                value: typeof option === 'string' ? option : option.id,
                label:
                  typeof option === 'string'
                    ? t('quality.dispatch.departmentByRule')
                    : option.title,
              }))}
              value={departmentId}
              onValueChange={(value) => setDepartmentId(value as string)}
            >
              <SelectTrigger id='dispatch-department' className='w-48'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={BY_RULE}>
                  {t('quality.dispatch.departmentByRule')}
                </SelectItem>
                {options.map((option) => (
                  <SelectItem key={option.id} value={option.id}>
                    {option.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className='text-xs text-muted-foreground'>
              {t('quality.dispatch.departmentHint')}
            </p>
            {departmentsUnavailable(departments) ? (
              <p role='status' className='text-xs text-muted-foreground'>
                {t('quality.departmentsUnavailable')}
              </p>
            ) : null}
          </div>
          <div className='flex flex-col gap-1'>
            <Label htmlFor='dispatch-assignee'>
              {t('quality.dispatch.assignee')}
            </Label>
            <ColleagueSearch
              id='dispatch-assignee'
              client={client}
              departmentId={departmentId === BY_RULE ? null : departmentId}
              value={assigneeId}
              onPick={(candidate) => setAssigneeId(candidate?.id ?? null)}
              label={t('quality.dispatch.assignee')}
            />
          </div>
          {error ? (
            <Alert variant='destructive' role='alert'>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant='outline' onClick={onClose} disabled={saving}>
            {t('actions.cancel')}
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={saving || valuesMissing}
          >
            {saving ? <Loader2 className='size-4 animate-spin' /> : null}
            {t('quality.dispatch.submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
