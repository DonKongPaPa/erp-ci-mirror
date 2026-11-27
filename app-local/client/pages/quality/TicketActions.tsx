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
import { Textarea } from '#components/ui/textarea';

import { QualityClient, type QualityTicket } from './client.js';
import { ColleagueSearch } from './ColleagueSearch.js';
import {
  departmentsUnavailable,
  useTicketDepartments,
} from './use-departments.js';
import { ticketErrorText } from './ticket-errors.js';

interface DialogProps {
  readonly ticket: QualityTicket;
  readonly client?: QualityClient;
  readonly onClose: () => void;
  /** 成功之后由父级刷新详情与列表。 */
  readonly onDone: () => void;
}

/** 五个流转对话框共用的外壳：头部、错误条与底部的取消/执行。 */
function ActionFrame({
  title,
  description,
  error,
  saving,
  submitLabel,
  disabled,
  onSubmit,
  onClose,
  children,
}: {
  readonly title: string;
  readonly description?: string;
  readonly error?: string;
  readonly saving: boolean;
  readonly submitLabel: string;
  readonly disabled?: boolean;
  readonly onSubmit: () => void;
  readonly onClose: () => void;
  readonly children?: ReactElement;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <Dialog open onOpenChange={(open) => (!open && !saving ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? (
            <DialogDescription>{description}</DialogDescription>
          ) : null}
        </DialogHeader>
        {children}
        {error ? (
          <Alert variant='destructive' role='alert'>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <DialogFooter>
          <Button variant='outline' onClick={onClose} disabled={saving}>
            {t('actions.cancel')}
          </Button>
          <Button onClick={() => void onSubmit()} disabled={saving || disabled}>
            {saving ? <Loader2 className='size-4 animate-spin' /> : null}
            {submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 受理：可以带经办人（在责任部门里搜），不带就是自己。 */
export function AcceptDialog(props: DialogProps): ReactElement {
  return <AssigneeTransition {...props} name='accept' />;
}

/** 解决：处理说明必填。 */
export function ResolveDialog(props: DialogProps): ReactElement {
  return <TextFieldTransition {...props} name='resolve' field='resolution' />;
}

/** 关闭：可以带一句备注，备注只进流转日志。 */
export function CloseDialog(props: DialogProps): ReactElement {
  return <TextFieldTransition {...props} name='close' field='note' optional />;
}

/** 重开：原因必填，原因也只进流转日志。 */
export function ReopenDialog(props: DialogProps): ReactElement {
  return <TextFieldTransition {...props} name='reopen' field='reason' />;
}

/** 转派：新责任部门必填，可以同时换经办人。 */
export function ReassignDialog(props: DialogProps): ReactElement {
  return <DepartmentTransition {...props} />;
}

/** 带经办人选择的受理。 */
function AssigneeTransition({
  ticket,
  client: providedClient,
  onClose,
  onDone,
  name,
}: DialogProps & { readonly name: 'accept' }): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const toaster = useToaster();
  const client = useMemo(
    () => providedClient ?? new QualityClient(api),
    [providedClient, api],
  );
  const [assigneeId, setAssigneeId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (): Promise<void> => {
    if (saving) return;
    setSaving(true);
    setError(undefined);
    try {
      await client.fireTransition(ticket.id, name, {
        ...(assigneeId === null ? {} : { assigneeId }),
      });
      toaster.show({ type: 'success', title: t('quality.transitionsSaved') });
      onDone();
      onClose();
    } catch (next) {
      setError(ticketErrorText(next, t));
      setSaving(false);
    }
  };

  return (
    <ActionFrame
      title={t('quality.tickets.actions.accept')}
      description={t('quality.accept.description')}
      error={error}
      saving={saving}
      submitLabel={t('quality.tickets.actions.accept')}
      onSubmit={() => void submit()}
      onClose={onClose}
    >
      <div className='flex flex-col gap-1'>
        <Label htmlFor='accept-assignee'>
          {t('quality.accept.assignee')}
        </Label>
        <ColleagueSearch
          id='accept-assignee'
          client={client}
          departmentId={ticket.departmentId}
          value={assigneeId}
          onPick={(candidate) => setAssigneeId(candidate?.id ?? null)}
          label={t('quality.accept.assignee')}
        />
        <p className='text-xs text-muted-foreground'>
          {t('quality.accept.assigneeSelf')}
        </p>
      </div>
    </ActionFrame>
  );
}

/** 带一个必填或可选文本域的流转（解决的处理说明、关闭的备注、重开的原因）。 */
function TextFieldTransition({
  ticket,
  client: providedClient,
  onClose,
  onDone,
  name,
  field,
  optional = false,
}: DialogProps & {
  readonly name: 'resolve' | 'close' | 'reopen';
  readonly field: 'resolution' | 'note' | 'reason';
  readonly optional?: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const toaster = useToaster();
  const client = useMemo(
    () => providedClient ?? new QualityClient(api),
    [providedClient, api],
  );
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const label =
    field === 'resolution'
      ? t('quality.resolve.resolution')
      : field === 'reason'
        ? t('quality.reopen.reason')
        : t('quality.close.note');

  const submit = async (): Promise<void> => {
    if (saving) return;
    const value = text.trim();
    if (!optional && value.length === 0) {
      setError(
        field === 'resolution'
          ? t('quality.resolve.resolutionRequired')
          : t('quality.reopen.reasonRequired'),
      );
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      await client.fireTransition(ticket.id, name, {
        ...(value.length === 0 ? {} : { [field]: value }),
      });
      toaster.show({ type: 'success', title: t('quality.transitionsSaved') });
      onDone();
      onClose();
    } catch (next) {
      setError(ticketErrorText(next, t));
      setSaving(false);
    }
  };

  return (
    <ActionFrame
      title={t(`quality.tickets.actions.${name}`)}
      error={error}
      saving={saving}
      submitLabel={t(`quality.tickets.actions.${name}`)}
      disabled={!optional && text.trim().length === 0}
      onSubmit={() => void submit()}
      onClose={onClose}
    >
      <div className='flex flex-col gap-1'>
        <Label htmlFor={`transition-${field}`}>{label}</Label>
        <Textarea
          id={`transition-${field}`}
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={3}
        />
      </div>
    </ActionFrame>
  );
}

/** 转派：新部门必选；可同时换经办人（他得是新部门的成员，服务端核）。 */
function DepartmentTransition({
  ticket,
  client: providedClient,
  onClose,
  onDone,
}: DialogProps): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const toaster = useToaster();
  const client = useMemo(
    () => providedClient ?? new QualityClient(api),
    [providedClient, api],
  );
  // 部门选项进对话框才取（enabled 由打开状态决定）；读不到时在下拉旁给一句说明。
  const departments = useTicketDepartments(client, true);
  const [departmentId, setDepartmentId] = useState('');
  const [assigneeId, setAssigneeId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (): Promise<void> => {
    if (saving) return;
    if (departmentId === '') {
      setError(t('quality.reassign.departmentRequired'));
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      await client.fireTransition(ticket.id, 'reassign', {
        departmentId,
        ...(assigneeId === null ? {} : { assigneeId }),
      });
      toaster.show({ type: 'success', title: t('quality.transitionsSaved') });
      onDone();
      onClose();
    } catch (next) {
      setError(ticketErrorText(next, t));
      setSaving(false);
    }
  };

  return (
    <ActionFrame
      title={t('quality.tickets.actions.reassign')}
      error={error}
      saving={saving}
      submitLabel={t('quality.tickets.actions.reassign')}
      disabled={departmentId === ''}
      onSubmit={() => void submit()}
      onClose={onClose}
    >
      <div className='flex flex-col gap-3'>
        <div className='flex flex-col gap-1'>
          <Label htmlFor='reassign-department'>
            {t('quality.reassign.department')}
          </Label>
          <Select
            items={departments.options.map((option) => ({
              value: option.id,
              label: option.title,
            }))}
            value={departmentId}
            onValueChange={(value) => setDepartmentId(value as string)}
          >
            <SelectTrigger id='reassign-department' className='w-48'>
              <SelectValue
                placeholder={t('quality.reassign.departmentPlaceholder')}
              />
            </SelectTrigger>
            <SelectContent>
              {departments.options.map((option) => (
                <SelectItem key={option.id} value={option.id}>
                  {option.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {departmentsUnavailable(departments) ? (
            <p role='status' className='text-xs text-muted-foreground'>
              {t('quality.departmentsUnavailable')}
            </p>
          ) : null}
        </div>
        <div className='flex flex-col gap-1'>
          <Label htmlFor='reassign-assignee'>
            {t('quality.reassign.assignee')}
          </Label>
          <ColleagueSearch
            id='reassign-assignee'
            client={client}
            departmentId={departmentId === '' ? null : departmentId}
            value={assigneeId}
            onPick={(candidate) => setAssigneeId(candidate?.id ?? null)}
            label={t('quality.reassign.assignee')}
          />
        </div>
      </div>
    </ActionFrame>
  );
}
