import { useApiClient } from '@nocobase/app-client';
import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useTranslation } from '@nocobase/i18n/client';
import { useEffect, useState, type ReactElement } from 'react';
import { useParams } from 'react-router';

import { Button } from '#components/ui/button';
import { DOC_PRINT_PATHS, type DocPrintPath } from './model.js';
import './print.css';

/**
 * R-076：浏览器打印视图。路径本身不登记页面授权；进入时按 docType 检查对应的
 * `print` 动作，没有就显示 403（且不发任何取数请求）。审批四键恒空，第一版不渲染。
 */
interface PrintLine {
  seq: number;
  itemCode: string;
  itemName: string;
  spec: string | null;
  unit: string;
  qty: number;
  batchNo: string;
  productionDate: string | null;
  expiryDate: string | null;
  note: string | null;
}
interface PrintData {
  docType: string;
  docNo: string;
  docDate: string | null;
  header: {
    warehouseName: string;
    partnerName: string;
    contactName: string;
    deliveryAddress: string;
    customerOrderNo: string;
    projectName: string;
    handlerName: string;
    takerDepartmentName: string;
    takerName: string;
    remark: string;
  };
  lines: PrintLine[];
  totals: { totalQty: number | null };
  printCount: number;
}

type State =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly data: PrintData }
  | { readonly kind: 'failed' };

export default function DocPrintViewPage(): ReactElement {
  const { docType = '', docNo = '' } = useParams();
  const { t } = useTranslation();
  const api = useApiClient();
  const config = DOC_PRINT_PATHS[docType as DocPrintPath];
  const print = useCan(
    config === undefined
      ? undefined
      : { resource: { type: 'composite', id: config.resource }, action: 'print' },
  );
  const [state, setState] = useState<{ readonly path: string; readonly value: State }>({
    path: '',
    value: { kind: 'loading' },
  });
  const [marking, setMarking] = useState(false);

  const path = `doc-print/${encodeURIComponent(docType)}/${encodeURIComponent(docNo)}`;
  useEffect(() => {
    if (config === undefined || print.isPending || !print.can) return;
    const controller = new AbortController();
    void api
      .request<PrintData>({ path, signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted)
          setState({ path, value: { kind: 'ready', data } });
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setState({ path, value: { kind: 'failed' } });
      });
    return () => controller.abort();
  }, [api, path, config, print.isPending, print.can]);
  const viewState: State = state.path === path ? state.value : { kind: 'loading' };

  /** 痕迹记在「点打印」这一次；先写成功再打开原生打印对话框。 */
  const markAndPrint = async (): Promise<void> => {
    setMarking(true);
    try {
      await api.request({
        path: `${path}/print-mark`,
        method: 'POST',
      });
      window.print?.();
    } finally {
      setMarking(false);
    }
  };

  if (config === undefined || (!print.isPending && !print.can)) {
    return (
      <section className='doc-print-page' role='alert' data-testid='doc-print-denied'>
        <h1>{t('docPrint.deniedTitle')}</h1>
        <p>{t('docPrint.deniedDescription')}</p>
      </section>
    );
  }
  if (print.isPending || viewState.kind === 'loading') {
    return <section className='doc-print-page'>{t('status.loading')}</section>;
  }
  if (viewState.kind === 'failed') {
    return (
      <section className='doc-print-page' role='alert'>
        {t('docPrint.loadFailed')}
      </section>
    );
  }

  const data = viewState.data;
  const internal = docType === 'internal-use';
  const title = t(internal ? 'docPrint.title.internalUse' : `docPrint.title.${docType}`);
  const headerCells = internal
    ? [
        [t('docPrint.columns.docNo'), data.docNo],
        [t('docPrint.columns.warehouse'), data.header.warehouseName],
        [t('docPrint.columns.docDate'), data.docDate ?? ''],
        [t('docPrint.columns.department'), data.header.takerDepartmentName],
        [t('docPrint.columns.taker'), data.header.takerName],
      ]
    : [
        [t('docPrint.columns.docNo'), data.docNo],
        [t('docPrint.columns.warehouse'), data.header.warehouseName],
        [t('docPrint.columns.docDate'), data.docDate ?? ''],
        [t('docPrint.columns.partner'), data.header.partnerName],
        [t('docPrint.columns.contact'), data.header.contactName],
      ];
  const lineHeaders = [
    t('docPrint.columns.seq'),
    t('docPrint.columns.itemCode'),
    t('docPrint.columns.itemName'),
    t('docPrint.columns.spec'),
    t('docPrint.columns.unit'),
    t('docPrint.columns.qty'),
    t('docPrint.columns.note'),
  ];

  return (
    <div className='doc-print-page'>
      <div data-print-hide className='doc-print-actions'>
        <Button disabled={marking} onClick={() => void markAndPrint()}>
          {t('docPrint.print')}
        </Button>
        <span data-testid='print-count'>{data.printCount}</span>
      </div>
      {[1, 2, 3].map((copy) => (
        <section key={copy} data-copy={copy} className='doc-print-copy'>
          <h1 className='doc-print-title'>{title}</h1>
          <table className='doc-print-sheet' data-testid={`doc-print-header-${copy}`}>
            <tbody>
              <tr>
                {headerCells.map(([label]) => (
                  <th key={label}>{label}</th>
                ))}
              </tr>
              <tr>
                {headerCells.map(([label, value]) => (
                  <td key={label}>{value}</td>
                ))}
              </tr>
            </tbody>
          </table>
          <table className='doc-print-sheet' data-testid={`doc-print-lines-${copy}`}>
            <thead>
              <tr>
                {lineHeaders.map((label) => (
                  <th key={label}>{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.lines.map((line) => (
                <tr key={line.seq}>
                  <td>{line.seq}</td>
                  <td>{line.itemCode}</td>
                  <td>{line.itemName}</td>
                  <td>{line.spec ?? ''}</td>
                  <td>{line.unit}</td>
                  <td>{line.qty}</td>
                  <td>{line.note ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {internal ? null : (
            <p data-testid={`doc-print-totals-${copy}`}>
              {t('docPrint.totalQty')}: {data.totals.totalQty ?? ''}
            </p>
          )}
          <p className='doc-print-signoff'>{t('docPrint.signoff')}</p>
        </section>
      ))}
    </div>
  );
}
