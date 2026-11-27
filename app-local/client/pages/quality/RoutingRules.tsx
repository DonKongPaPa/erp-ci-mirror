import { useApiClient, useToaster } from '@nocobase/app-client';
import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useTranslation } from '@nocobase/i18n/client';
import { Loader2 } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactElement } from 'react';

import { Alert, AlertDescription } from '#components/ui/alert';
import { Button } from '#components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '#components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '#components/ui/select';
import { Skeleton } from '#components/ui/skeleton';

import {
  QualityClient,
  type RoutingRule,
  type RoutingRuleInput,
} from './client.js';
import { CATEGORIES } from './model.js';
import { ticketErrorText } from './ticket-errors.js';
import {
  departmentsUnavailable,
  useTicketDepartments,
} from './use-departments.js';
import { FQC_RESOURCE } from './page-id.js';

/** 骨架行数与七个类别一致：编辑入口只给持「维护派单规则」的人。 */
const RULE_ROW_CLASS = 'flex items-center justify-between gap-2 text-sm';

/**
 * 派单规则卡（R-003 验收 17）：七个类别各自的部门，读对持「查看」的人开放，
 * 编辑入口只给持「维护派单规则」的人。整体替换：保存一次写全七行（PUT）。
 * 读不到（没有范围）时如实显示读取失败，不显示一张空表装作没有规则。
 */
export function RoutingRulesCard({
  client: providedClient,
}: {
  readonly client?: QualityClient;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const client = useMemo(
    () => providedClient ?? new QualityClient(api),
    [providedClient, api],
  );
  const configure = useCan({ resource: FQC_RESOURCE, action: 'configure' });

  const [rules, setRules] = useState<
    ReadonlyMap<string, RoutingRule> | undefined
  >();
  const [error, setError] = useState<string>();
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let active = true;
    client.getRoutingRules().then(
      (result) => {
        if (!active) return;
        setRules(new Map(result.items.map((rule) => [rule.category, rule])));
        setError(undefined);
      },
      (next: unknown) => {
        if (active) setError(next instanceof Error ? next.message : String(next));
      },
    );
    return () => {
      active = false;
    };
  }, [client, reloadToken]);

  return (
    <Card data-testid='routing-rules-card'>
      <CardHeader className='flex flex-row items-center gap-2'>
        <div className='flex flex-col gap-1'>
          <CardTitle className='text-sm'>
            {t('quality.routingRules.title')}
          </CardTitle>
          <CardDescription>
            {t('quality.routingRules.description')}
          </CardDescription>
        </div>
        {configure.can ? (
          <RoutingRulesEditor
            client={client}
            rules={rules}
            onSaved={() => setReloadToken((value) => value + 1)}
          />
        ) : null}
      </CardHeader>
      <CardContent className='flex flex-col gap-2'>
        {error && rules === undefined ? (
          <p role='alert' className='text-sm text-muted-foreground'>
            {t('quality.routingRules.failed')}
          </p>
        ) : rules === undefined ? (
          CATEGORIES.map((category) => (
            <div key={category} aria-hidden='true' className={RULE_ROW_CLASS}>
              <Skeleton className='h-4 w-24' />
              <Skeleton className='h-4 w-32' />
            </div>
          ))
        ) : (
          CATEGORIES.map((category) => {
            const rule = rules.get(category);
            // 显示服务端解析好的部门名；解析不到退回标识，没配规则如实显示未配置。
            const label =
              rule?.departmentTitle ??
              (rule?.departmentId ? rule.departmentId : null);
            return (
              <div key={category} className={RULE_ROW_CLASS}>
                <span className='text-muted-foreground'>
                  {t(`quality.categories.${category}`)}
                </span>
                <span>
                  {label ?? t('quality.routingRules.unset')}
                </span>
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}

/**
 * 编辑态：七个类别各一个部门下拉（停用的部门不进选项），保存一次 PUT 全部七行。
 * 「维护派单规则」的编辑入口在卡片头部；没有它的人看不到这个组件。
 */
function RoutingRulesEditor({
  client,
  rules,
  onSaved,
}: {
  readonly client: QualityClient;
  readonly rules: ReadonlyMap<string, RoutingRule> | undefined;
  readonly onSaved: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const toaster = useToaster();
  const [editing, setEditing] = useState(false);
  // 草稿：类别到部门标识，null/缺省表示「未配置」。
  const [values, setValues] = useState<ReadonlyMap<string, string | null>>(
    () => new Map(),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const departments = useTicketDepartments(client, editing);
  const { options } = departments;

  const startEditing = (): void => {
    // 以当前读到的规则为起点；规则还没读到就不进编辑（读不到也没法整体替换）。
    if (rules === undefined) return;
    setValues(
      new Map(
        CATEGORIES.map((category) => [
          category,
          rules.get(category)?.departmentId ?? null,
        ]),
      ),
    );
    setError(undefined);
    setEditing(true);
  };

  const save = async (): Promise<void> => {
    if (saving) return;
    setSaving(true);
    setError(undefined);
    const payload: readonly RoutingRuleInput[] = CATEGORIES.map((category) => ({
      category,
      departmentId: values.get(category) ?? null,
    }));
    try {
      await client.putRoutingRules(payload);
      toaster.show({ type: 'success', title: t('quality.routingRules.saved') });
      setEditing(false);
      onSaved();
    } catch (next) {
      setError(ticketErrorText(next, t));
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    return (
      <Button
        variant='outline'
        size='sm'
        className='ml-auto'
        data-testid='routing-rules-edit'
        disabled={rules === undefined}
        onClick={startEditing}
      >
        {t('quality.routingRules.edit')}
      </Button>
    );
  }

  return (
    <div className='ml-auto flex flex-col gap-2'>
      {CATEGORIES.map((category) => (
        <div key={category} className='flex items-center gap-2 text-sm'>
          <span className='w-20 text-muted-foreground'>
            {t(`quality.categories.${category}`)}
          </span>
          <Select
            items={[null, ...options].map((option) => ({
              value: option === null ? 'unset' : option.id,
              label:
                option === null
                  ? t('quality.routingRules.unset')
                  : option.title,
            }))}
            value={values.get(category) ?? 'unset'}
            onValueChange={(value) =>
              setValues((previous) => {
                const next = new Map(previous);
                next.set(category, value === 'unset' ? null : value);
                return next;
              })
            }
          >
            <SelectTrigger
              aria-label={`${t(`quality.categories.${category}`)} ${t('quality.routingRules.departmentColumn')}`}
              className='w-44'
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='unset'>
                {t('quality.routingRules.unset')}
              </SelectItem>
              {options.map((option) => (
                <SelectItem key={option.id} value={option.id}>
                  {option.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ))}
      {departmentsUnavailable(departments) ? (
        <p role='status' className='text-xs text-muted-foreground'>
          {t('quality.departmentsUnavailable')}
        </p>
      ) : null}
      {error ? (
        <Alert variant='destructive' role='alert'>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <div className='flex items-center justify-end gap-2'>
        <Button variant='outline' size='sm' onClick={() => setEditing(false)} disabled={saving}>
          {t('quality.routingRules.cancel')}
        </Button>
        <Button size='sm' onClick={() => void save()} disabled={saving}>
          {saving ? <Loader2 className='size-4 animate-spin' /> : null}
          {t('quality.routingRules.save')}
        </Button>
      </div>
    </div>
  );
}
