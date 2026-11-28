import { useApiClient } from '@nocobase/app-client';
import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useTranslation } from '@nocobase/i18n/client';
import { PlusIcon, SaveIcon, XIcon } from 'lucide-react';
import {
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';

import { ConfirmDialog } from '#components/erp/confirm';
import { errorText, serverMessage } from '#components/erp/messages';
import { FormRoute } from '#components/erp/form-route';
import { FeedbackForm } from '#components/feedback-form';
import { PageContainer } from '#components/page-container';
import { PageHeader } from '#components/page-header';
import { RouteChildPage } from '#components/route-child-page';
import { Button } from '#components/ui/button';
import { Checkbox } from '#components/ui/checkbox';
import { Input } from '#components/ui/input';
import { Label } from '#components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '#components/ui/select';

import {
  BomsClient,
  type Bom,
  type BomLineInput,
} from './client.js';
import { itemChoices, useReferencePage, type Item } from '../orders/reference.js';
import { BOMS_RESOURCE } from './page-id.js';
import { usePageLeave } from '../../routing/route-leave-boundary.js';

/** 焦点必须看得见：这一组页面统一用可读的轮廓，不依赖外壳的浅色阴影。 */
const focusRing = [
  '[&_button:focus-visible]:outline-2',
  '[&_button:focus-visible]:outline-offset-2',
  '[&_button:focus-visible]:outline-ring',
  '[&_input:focus-visible]:outline-2',
  '[&_input:focus-visible]:outline-offset-2',
  '[&_input:focus-visible]:outline-ring',
  '[&_[role=combobox]:focus-visible]:outline-2',
  '[&_[role=combobox]:focus-visible]:outline-offset-2',
  '[&_[role=combobox]:focus-visible]:outline-ring',
].join(' ');

interface LineDraft {
  readonly key: string;
  itemId: string;
  qty: string;
  lossRate: string;
  childBomId: string;
  note: string;
}

const newLine = (key: string): LineDraft => ({
  key, itemId: '', qty: '', lossRate: '0', childBomId: '', note: '',
});

function Field({
  label,
  children,
  className = '',
}: {
  readonly label: string;
  readonly children: ReactNode;
  readonly className?: string;
}): ReactElement {
  return (
    <div className={`flex w-full flex-col gap-1.5 ${className}`}>
      <Label>{label}</Label>
      {children}
    </div>
  );
}

/**
 * 新建与编辑共用的表单：表头 + 配件行（行可挂子 BOM）。
 * docNo、状态、建单人由服务端决定，请求体里只放手填的字段；明细整单替换。
 */
export default function BomFormPage({ editing }: { readonly editing: boolean }): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const navigate = useNavigate();
  const id = useParams().bomId ?? '';
  const [searchParams] = useSearchParams();
  const client = useMemo(() => new BomsClient(api), [api]);
  const permission = useCan({
    resource: BOMS_RESOURCE,
    action: editing ? 'update' : 'create',
  });
  const items = useReferencePage<Item>('items', permission.can);
  const boms = useReferencePage<{ id: string; docNo: string }>('boms', permission.can);

  const [version, setVersion] = useState('');
  const [productId, setProductId] = useState(searchParams.get('productId') ?? '');
  const [isDefault, setIsDefault] = useState(false);
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [effectiveTo, setEffectiveTo] = useState('');
  const [dailyOutput, setDailyOutput] = useState('');
  const [remark, setRemark] = useState('');
  const [lines, setLines] = useState<readonly LineDraft[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [loaded, setLoaded] = useState(!editing);
  const [docNo, setDocNo] = useState('');
  const [confirmLeave, setConfirmLeave] = useState(false);

  const current = {
    version, productId, isDefault, effectiveFrom, effectiveTo,
    dailyOutput, remark, lines,
  };
  const [saved, setSaved] = useState(current);
  const dirty = JSON.stringify(current) !== JSON.stringify(saved);
  const leave = usePageLeave(dirty, busy);
  const leavePage = (): void => {
    leave.allow();
    void navigate('/boms');
  };

  useEffect(() => {
    if (!editing || !permission.can) return;
    let live = true;
    void client.detail(id).then(
      (bom: Bom) => {
        if (!live) return;
        const restored = {
          version: bom.version,
          productId: bom.product.id,
          isDefault: bom.isDefault,
          effectiveFrom: bom.effectiveFrom,
          effectiveTo: bom.effectiveTo ?? '',
          dailyOutput: bom.dailyOutput === null ? '' : String(bom.dailyOutput),
          remark: bom.remark,
          lines: bom.lines.map((line, index) => ({
            key: String(index + 1),
            itemId: line.itemId,
            qty: String(line.qty),
            lossRate: String(line.lossRate),
            childBomId: line.childBomId ?? '',
            note: line.note ?? '',
          })),
        };
        setSaved(restored);
        setDocNo(bom.docNo);
        setVersion(restored.version);
        setProductId(restored.productId);
        setIsDefault(restored.isDefault);
        setEffectiveFrom(restored.effectiveFrom);
        setEffectiveTo(restored.effectiveTo);
        setDailyOutput(restored.dailyOutput);
        setRemark(restored.remark);
        setLines(restored.lines);
        setLoaded(true);
      },
      (cause: unknown) => {
        if (live) setError(errorText(cause, t));
      },
    );
    return () => {
      live = false;
    };
  }, [editing, permission.can, client, id, t]);

  const itemOptions = useMemo(
    () => itemChoices(items.items ?? [], t('orderDocs.form.inactiveItem')),
    [items.items, t],
  );
  const bomOptions = useMemo(
    () => (boms.items ?? []).map((bom) => ({ value: bom.id, label: bom.docNo })),
    [boms.items],
  );

  const patchLine = (key: string, patch: Partial<LineDraft>): void => {
    setLines((current) =>
      current.map((line) => (line.key === key ? { ...line, ...patch } : line)),
    );
  };
  const addLine = (): void => {
    setLines((current) => [...current, newLine(String(current.length + 1))]);
  };
  const removeLine = (key: string): void => {
    setLines((current) => current.filter((line) => line.key !== key));
  };

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    const bodyLines: BomLineInput[] = lines.map((line) => ({
      itemId: line.itemId,
      qty: Number(line.qty),
      lossRate: line.lossRate === '' ? 0 : Number(line.lossRate),
      note: line.note === '' ? null : line.note,
      ...(line.childBomId ? { childBomId: line.childBomId } : {}),
    }));
    const base = {
      ...(isDefault ? { isDefault: true } : {}),
      ...(effectiveTo ? { effectiveTo } : {}),
      ...(dailyOutput ? { dailyOutput: Number(dailyOutput) } : {}),
      ...(remark ? { remark } : {}),
      lines: bodyLines,
    };
    try {
      const saved = editing
        ? await client.update(id, { ...base, version })
        : await client.create({
            version,
            productId,
            effectiveFrom,
            ...base,
          });
      leave.allow();
      void navigate(`/boms/${encodeURIComponent(saved.id)}`);
    } catch (cause) {
      setError(serverMessage(cause) ?? errorText(cause, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <FormRoute
      title={t(editing ? 'boms.editTitle' : 'boms.newTitle')}
      pending={permission.isPending || (editing && !loaded)}
      allowed={permission.can}
    >
      <RouteChildPage>
        <PageContainer>
          <PageHeader
            title={t(editing ? 'boms.editTitle' : 'boms.newTitle')}
            description={editing
              ? t('boms.editDescription', { docNo })
              : t('boms.newDescription')}
          />
          <div className={`w-full max-w-3xl ${focusRing}`}>
      <FeedbackForm
        className='flex flex-col gap-6'
        error={error}
        submitting={busy}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <fieldset className='grid gap-4 sm:grid-cols-2' disabled={busy}>
          <legend className='text-sm font-semibold'>
            {t('boms.sections.header')}
          </legend>
          <Field label={t('boms.fields.version')}>
            <Input
              aria-label={t('boms.fields.version')}
              value={version}
              onChange={(event) => setVersion(event.target.value)}
            />
          </Field>
          <Field label={t('boms.fields.product')}>
            <Select
              value={productId}
              onValueChange={(value) => setProductId(value ?? '')}
              disabled={editing}
            >
              <SelectTrigger
                className='w-full'
                aria-label={t('boms.fields.product')}
              >
                <SelectValue placeholder={t('boms.form.choose')} />
              </SelectTrigger>
              <SelectContent>
                {itemOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label={t('boms.fields.effectiveFrom')}>
            <Input
              inputMode='numeric'
              autoComplete='off'
              aria-label={t('boms.fields.effectiveFrom')}
              value={effectiveFrom}
              onChange={(event) => setEffectiveFrom(event.target.value)}
            />
          </Field>
          <Field label={t('boms.fields.effectiveTo')}>
            <Input
              inputMode='numeric'
              autoComplete='off'
              aria-label={t('boms.fields.effectiveTo')}
              value={effectiveTo}
              onChange={(event) => setEffectiveTo(event.target.value)}
            />
          </Field>
          <Field label={t('boms.fields.dailyOutput')}>
            <Input
              inputMode='decimal'
              autoComplete='off'
              aria-label={t('boms.fields.dailyOutput')}
              value={dailyOutput}
              onChange={(event) => setDailyOutput(event.target.value)}
            />
          </Field>
          <Label className='flex items-center gap-2 self-end'>
            <Checkbox
              checked={isDefault}
              onCheckedChange={(value) => setIsDefault(value === true)}
              aria-label={t('boms.fields.isDefault')}
            />
            {t('boms.fields.isDefault')}
          </Label>
          <Field label={t('boms.fields.remark')} className='sm:col-span-2'>
            <Input
              aria-label={t('boms.fields.remark')}
              value={remark}
              onChange={(event) => setRemark(event.target.value)}
            />
          </Field>
        </fieldset>

        <fieldset className='flex flex-col gap-3' disabled={busy}>
          <legend className='text-sm font-semibold'>
            {t('boms.sections.lines')}
          </legend>
          {lines.map((line, index) => (
            <div
              key={line.key}
              className='grid items-end gap-3 rounded-lg border border-border p-3 sm:grid-cols-5'
            >
              <Field label={t('boms.fields.itemInLine', { row: index + 1 })}>
                <Select
                  value={line.itemId}
                  onValueChange={(value) => patchLine(line.key, { itemId: value ?? '' })}
                >
                  <SelectTrigger
                    className='w-full'
                    aria-label={t('boms.fields.itemInLine', { row: index + 1 })}
                  >
                    <SelectValue placeholder={t('boms.form.choose')} />
                  </SelectTrigger>
                  <SelectContent>
                    {itemOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label={t('boms.fields.qtyInLine', { row: index + 1 })}>
                <Input
                  inputMode='decimal'
                  autoComplete='off'
                  aria-label={t('boms.fields.qtyInLine', { row: index + 1 })}
                  value={line.qty}
                  onChange={(event) => patchLine(line.key, { qty: event.target.value })}
                />
              </Field>
              <Field label={t('boms.fields.lossRateInLine', { row: index + 1 })}>
                <Input
                  inputMode='decimal'
                  autoComplete='off'
                  aria-label={t('boms.fields.lossRateInLine', { row: index + 1 })}
                  value={line.lossRate}
                  onChange={(event) => patchLine(line.key, { lossRate: event.target.value })}
                />
              </Field>
              <Field label={t('boms.fields.childBomIdInLine', { row: index + 1 })}>
                <Select
                  value={line.childBomId}
                  onValueChange={(value) => patchLine(line.key, { childBomId: value ?? '' })}
                >
                  <SelectTrigger
                    className='w-full'
                    aria-label={t('boms.fields.childBomIdInLine', { row: index + 1 })}
                  >
                    <SelectValue placeholder={t('boms.fields.none')} />
                  </SelectTrigger>
                  <SelectContent>
                    {bomOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <div className='flex items-end gap-2'>
                <Field label={t('boms.fields.noteInLine', { row: index + 1 })}>
                  <Input
                    aria-label={t('boms.fields.noteInLine', { row: index + 1 })}
                    value={line.note}
                    onChange={(event) => patchLine(line.key, { note: event.target.value })}
                  />
                </Field>
                <Button
                  type='button'
                  variant='ghost'
                  size='icon'
                  aria-label={t('boms.actions.removeLine', { row: index + 1 })}
                  disabled={lines.length === 1}
                  onClick={() => removeLine(line.key)}
                >
                  <XIcon aria-hidden='true' />
                </Button>
              </div>
            </div>
          ))}
          <Button type='button' variant='outline' onClick={addLine}>
            <PlusIcon aria-hidden='true' />
            {t('boms.actions.addLine')}
          </Button>
        </fieldset>

        <div className='flex items-center gap-3'>
          <Button
            type='submit'
            disabled={busy || !version || !effectiveFrom || (!editing && !productId)}
          >
            <SaveIcon data-icon='inline-start' aria-hidden='true' />
            {t('boms.actions.save')}
          </Button>
          <Button
            type='button'
            variant='outline'
            onClick={() => (dirty ? setConfirmLeave(true) : leavePage())}
          >
            <XIcon data-icon='inline-start' aria-hidden='true' />
            {t('actions.cancel')}
          </Button>
        </div>
      </FeedbackForm>
          <ConfirmDialog
            open={confirmLeave}
            title={t('boms.discardTitle', {
              name: editing ? docNo : t('boms.newTitle'),
            })}
            description={t('boms.discardDescription')}
            confirmLabel={t('boms.actions.discard')}
            busy={false}
            onCancel={() => setConfirmLeave(false)}
            onConfirm={() => {
              setConfirmLeave(false);
              leavePage();
            }}
          />
          {leave.dialog}
          </div>
        </PageContainer>
      </RouteChildPage>
    </FormRoute>
  );
}
