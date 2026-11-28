import { useLocale, useTranslation } from '@nocobase/i18n/client';
import { useState, type ReactElement } from 'react';

import { errorText } from '#components/erp/messages';
import { Button } from '#components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '#components/ui/dialog';
import { Input } from '#components/ui/input';
import { Label } from '#components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '#components/ui/select';

import { useListData } from '#hooks/use-list-data';

import type { ExplodeResult, ExplodeTotal } from './client.js';
import { moneyText, qtyText } from './format.js';

/**
 * 「展开结构」弹窗：按选定日期出树，单层（levels=1）与多层（levels=all）可切。
 * 服务端是唯一的递归实现，成环时整次 422、不返回半棵树 —— 这里清空树、只给提示。
 * 金额键由服务端按 `items.viewPurchasePrice` 裁掉：totals 行没有键就不画那一列。
 */
export function ExplodeDialog({
  productId,
  defaultAsOf,
  onClose,
}: {
  readonly productId: string;
  readonly defaultAsOf: string;
  readonly onClose: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const { locale } = useLocale();
  const [asOf, setAsOf] = useState(defaultAsOf);
  const [levels, setLevels] = useState<'1' | 'all'>('1');
  // 服务端是唯一的递归实现：日期或层级一变就换一条查询重新取，不用自己存半棵树。
  const path = asOf
    ? `boms/explode?${new URLSearchParams({ productId, asOf, levels }).toString()}`
    : '';
  const request = useListData<ExplodeResult>(path, { active: Boolean(asOf) });
  const error = request.error === undefined ? undefined : errorText(request.error, t);
  // 成环整次失败：即便上次有结果，也不保留半棵树，只给提示。
  const result = error === undefined ? request.data : undefined;
  const loading = request.loading;

  const totals = result?.totals ?? [];
  const showCost = totals.some(
    (row) => 'estimatedCost' in row || 'basePurchasePrice' in row,
  );

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className='sm:max-w-3xl'>
        <DialogHeader>
          <DialogTitle>{t('boms.explode.title')}</DialogTitle>
          <DialogDescription>{t('boms.explode.description')}</DialogDescription>
        </DialogHeader>

        <div className='flex flex-wrap items-end gap-3'>
          <div className='flex w-48 flex-col gap-1.5'>
            <Label htmlFor='bom-explode-as-of'>{t('boms.explode.asOf')}</Label>
            <Input
              id='bom-explode-as-of'
              inputMode='numeric'
              autoComplete='off'
              aria-label={t('boms.explode.asOf')}
              value={asOf}
              onChange={(event) => setAsOf(event.target.value)}
            />
          </div>
          <div className='flex w-48 flex-col gap-1.5'>
            <Label>{t('boms.explode.levels')}</Label>
            <Select
              value={levels}
              onValueChange={(value) => setLevels(value === 'all' ? 'all' : '1')}
            >
              <SelectTrigger aria-label={t('boms.explode.levels')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value='1'>{t('boms.explode.singleLevel')}</SelectItem>
                <SelectItem value='all'>{t('boms.explode.allLevels')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {error ? (
          <p role='alert' className='text-sm text-destructive'>
            {error}
          </p>
        ) : null}
        {loading ? (
          <p role='status' className='text-sm text-muted-foreground'>
            {t('status.loading')}
          </p>
        ) : null}

        {result ? (
          <>
            <p className='text-sm text-muted-foreground'>
              {t('boms.explode.root', {
                docNo: result.root.docNo,
                version: result.root.version,
                depth: String(result.levels),
              })}
            </p>
            <div data-testid='bom-explode-tree'>
              {result.nodes.map((node) => (
                <div
                  key={node.nodeId}
                  data-testid='bom-node'
                  data-depth={node.depth}
                  className='flex items-center gap-2 border-b border-border py-1.5 text-sm'
                  style={{ paddingLeft: `${(node.depth - 1) * 16}px` }}
                >
                  <span className='tabular-nums text-muted-foreground'>
                    {node.depth}
                  </span>
                  <span>{node.item.code} {node.item.name}</span>
                  <span className='ml-auto tabular-nums'>
                    {qtyText(node.effectiveQty, locale)} {node.item.unitCode}
                  </span>
                </div>
              ))}
            </div>
            <h3 className='text-sm font-semibold'>{t('boms.explode.totals')}</h3>
            <table className='w-full text-sm'>
              <thead>
                <tr className='border-b border-border text-left'>
                  <th>{t('boms.explode.item')}</th>
                  <th>{t('boms.explode.unit')}</th>
                  <th className='text-right'>{t('boms.explode.qty')}</th>
                  {showCost ? (
                    <th className='text-right' role='columnheader'>
                      {t('boms.explode.basePurchasePrice')}
                    </th>
                  ) : null}
                  {showCost ? (
                    <th className='text-right' role='columnheader'>
                      {t('boms.explode.estimatedCost')}
                    </th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {totals.map((row: ExplodeTotal) => (
                  <tr key={row.itemId} className='border-b border-border'>
                    <td>{row.code} {row.name}</td>
                    <td>{row.unitCode}</td>
                    <td className='text-right tabular-nums'>
                      {qtyText(row.qty, locale)}
                    </td>
                    {showCost ? (
                      <td className='text-right tabular-nums'>
                        {row.basePurchasePrice === undefined || row.basePurchasePrice === null
                          ? ''
                          : moneyText(row.basePurchasePrice, locale)}
                      </td>
                    ) : null}
                    {showCost ? (
                      <td className='text-right tabular-nums'>
                        {row.estimatedCost === undefined || row.estimatedCost === null
                          ? ''
                          : moneyText(row.estimatedCost, locale)}
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : null}

        <DialogFooter>
          <Button type='button' variant='outline' onClick={onClose}>
            {t('actions.cancel')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
