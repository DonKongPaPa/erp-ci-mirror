import {
  AuthenticationProvider,
  authenticationClientToken,
} from '@nocobase/app-plugin-authentication/client';
import {
  AuthorizationClient,
  authorizationClientToken,
  type AuthorizationSnapshot,
} from '@nocobase/app-plugin-authorization/client';
import { apiClientToken } from '@nocobase/app-client';
import {
  answerApi,
  renderWithApp,
  type ApiCall,
} from '@nocobase/app-testing/client';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { beforeEach, expect, it, vi } from 'vitest';

import enUS from '../../client/locales/en-US.js';
import DocPrintViewPage from '../../client/pages/doc-print/index.js';
import packageMetadata from '../../package.json' with { type: 'json' };

/**
 * R-076 打印视图：进入时按 docType 检查 print 动作；没有就显示 403 且不取数；
 * 有则三块 data-copy、七列表头，点「打印」写痕迹。示例数据一律编造。
 */
const T = 15_000;
const WAIT = { timeout: T };
const permission = (id: string, actions: string[]) => ({
  resource: { type: 'composite', id },
  actions,
});
const snapshot = (...items: { resource: { type: string; id: string }; actions: string[] }[]): AuthorizationSnapshot => ({
  unrestricted: false,
  permissions: items,
});
const docNo = 'CK-20261128-0001';

const printData = {
  docType: 'internal_use',
  docNo,
  docDate: '2026-11-28',
  status: 'draft',
  header: {
    warehouseName: 'Sample Warehouse',
    partnerName: '',
    contactName: '',
    deliveryAddress: '',
    customerOrderNo: '',
    projectName: '',
    handlerName: 'Sample Keeper',
    takerDepartmentName: 'Sample Dept',
    takerName: 'Sample Taker',
    remark: '',
  },
  lines: [{
    seq: 1, itemCode: 'M001', itemName: 'Sample Sheet Metal', spec: '1.5mm',
    unit: 'KG', qty: 10, batchNo: 'B1', productionDate: null, expiryDate: null,
    note: 'fabricated',
  }],
  party: { name: '', contactName: '', phone: '' },
  totals: { totalQty: 10 },
  preparedBy: { id: 'u1', name: 'Sample Keeper' },
  printedAt: '2026-11-28T10:00:00+08:00',
  approval: { approver: '', approvedAt: '', approvalStatus: '', approvalFlow: '' },
  printCount: 0,
};

let permissions: AuthorizationSnapshot;
let answer: (call: ApiCall) => unknown;
const api = vi.fn((call: ApiCall) =>
  call.path === 'authorization/permissions' ? { data: permissions } : answer(call),
);
const getSession = vi.fn(async () => ({ data: null }));

async function renderAt(path: string, grants: AuthorizationSnapshot) {
  permissions = grants;
  return await renderWithApp(
    <AuthenticationProvider>
      <Routes>
        <Route path='/main/doc-print/:docType/:docNo' element={<DocPrintViewPage />} />
      </Routes>
    </AuthenticationProvider>,
    {
      route: path,
      namespace: packageMetadata.name,
      namespaces: { [packageMetadata.name]: enUS },
      fetch: answerApi(api),
      services: (app) => {
        app.container.instance(authenticationClientToken, { getSession });
        app.container.singleton(
          authorizationClientToken,
          (resolver) => new AuthorizationClient(resolver.resolve(apiClientToken)),
        );
      },
    },
  );
}

const pathOf = (type: string) => `/main/doc-print/${type}/${encodeURIComponent(docNo)}`;
const dataCalls = (method: string) =>
  api.mock.calls.map(([call]) => call).filter(
    (call) => call.method === method && call.path.startsWith('doc-print/'),
  );

beforeEach(() => {
  sessionStorage.clear();
  api.mockClear();
  getSession.mockClear();
  answer = () => new Response(null, { status: 404 });
});

it('没有对应 print 动作时显示 403，且不发任何取数请求', async () => {
  await renderAt(
    pathOf('sales-issue'),
    snapshot(permission('docPrintInternalIssue', ['print'])),
  );
  // 等权限判定真正落定，再断言「没有取数」；否则空断言守不住任何行为。
  await screen.findByTestId('doc-print-denied', {}, WAIT);
  expect(dataCalls('GET')).toHaveLength(0);
  expect(api.mock.calls.some(([call]) => call.path === 'authorization/permissions')).toBe(true);
});

it('有 print 时渲染三块单据与七列表头，点打印写一次痕迹', async () => {
  answer = (call: ApiCall) => {
    if (call.method === 'GET' && call.path === `doc-print/internal-use/${docNo}`)
      return printData;
    if (call.method === 'POST' && call.path === `doc-print/internal-use/${docNo}/print-mark`)
      return { docNo, printCount: 1, lastPrintedAt: '2026-11-28T10:01:00+08:00', lastPrintedBy: 'u1' };
    return new Response(null, { status: 404 });
  };
  await renderAt(pathOf('internal-use'), snapshot(permission('docPrintInternalIssue', ['print'])));

  await screen.findByTestId('doc-print-lines-3', {}, WAIT);
  for (const copy of [1, 2, 3]) {
    expect(screen.getByTestId(`doc-print-header-${copy}`)).toBeInTheDocument();
  }
  const headers = within(screen.getByTestId('doc-print-lines-1')).getAllByRole('columnheader');
  expect(headers).toHaveLength(7);
  expect(headers.map((cell) => cell.textContent)).toEqual([
    '#', 'Item code', 'Item name', 'Specification', 'Unit', 'Qty', 'Note',
  ]);
  expect(screen.getAllByText('Issue note')).toHaveLength(3);
  expect(screen.queryByTestId('doc-print-denied')).not.toBeInTheDocument();

  const button = screen.getByRole('button', { name: 'Print' });
  await waitFor(() => expect(button).toBeEnabled(), WAIT);
  await userEvent.click(button);
  await waitFor(() => expect(dataCalls('POST')).toHaveLength(1), WAIT);
  expect(dataCalls('POST')[0]?.path).toBe(`doc-print/internal-use/${docNo}/print-mark`);
});

it('审批四项在视图里不渲染', async () => {
  answer = (call: ApiCall) =>
    call.method === 'GET' && call.path === `doc-print/internal-use/${docNo}`
      ? printData
      : new Response(null, { status: 404 });
  await renderAt(pathOf('internal-use'), snapshot(permission('docPrintInternalIssue', ['print'])));
  await screen.findByTestId('doc-print-lines-1', {}, WAIT);
  const body = document.body.textContent ?? '';
  for (const key of ['approver', 'approvedAt', 'approvalStatus', 'approvalFlow', '审批人', '审批时间']) {
    expect(body).not.toContain(key);
  }
});

it('印出合计与人民币大写；没有金额时画破折号', async () => {
  const priced = {
    ...printData,
    docType: 'purchase_receipt',
    totals: { totalQty: 2, payableTotal: 37.5, taxIncludedTotal: 37.5, taxExcludedTotal: 33.19, taxTotal: 4.31, discountAmount: 0 },
    amountInWords: '叁拾柒元伍角整',
  };
  answer = (call) =>
    call.method === 'GET' && call.path === `doc-print/purchase-receipt/${docNo}`
      ? priced
      : new Response(null, { status: 404 });
  await renderAt(pathOf('purchase-receipt'), snapshot(permission('docPrintPurchaseReceipt', ['print'])));
  await screen.findByTestId('doc-print-lines-3', {}, WAIT);
  for (const copy of [1, 2, 3]) {
    const totals = screen.getByTestId(`doc-print-totals-${copy}`);
    expect(totals).toHaveTextContent('Total qty: 2');
    expect(screen.getByTestId(`doc-print-amount-${copy}`)).toHaveTextContent('Amount payable: 37.5');
    expect(screen.getByTestId(`doc-print-amount-words-${copy}`)).toHaveTextContent('叁拾柒元伍角整');
  }
});

it('没有金额键的三联不出现空合计，破折号占位', async () => {
  answer = (call) =>
    call.method === 'GET' && call.path === `doc-print/internal-use/${docNo}`
      ? printData
      : new Response(null, { status: 404 });
  await renderAt(pathOf('internal-use'), snapshot(permission('docPrintInternalIssue', ['print'])));
  await screen.findByTestId('doc-print-lines-2', {}, WAIT);
  for (const copy of [1, 2, 3]) {
    expect(screen.getByTestId(`doc-print-totals-${copy}`)).toHaveTextContent('Total qty: 10');
    expect(screen.getByTestId(`doc-print-amount-${copy}`)).toHaveTextContent('—');
    expect(screen.getByTestId(`doc-print-amount-words-${copy}`)).toHaveTextContent('—');
  }
});

it('点打印后计数当场加一并把痕迹留给详情', async () => {
  answer = (call) => {
    if (call.method === 'GET' && call.path === `doc-print/internal-use/${docNo}`)
      return printData;
    if (call.method === 'POST' && call.path === `doc-print/internal-use/${docNo}/print-mark`)
      return { docNo, printCount: 1, lastPrintedAt: '2026-11-28T10:01:00+08:00', lastPrintedBy: 'u1' };
    return new Response(null, { status: 404 });
  };
  await renderAt(pathOf('internal-use'), snapshot(permission('docPrintInternalIssue', ['print'])));
  const button = await screen.findByRole('button', { name: 'Print' }, WAIT);
  await waitFor(() => expect(button).toBeEnabled(), WAIT);
  expect(screen.getByTestId('print-count')).toHaveTextContent('0');
  await userEvent.click(button);
  await waitFor(() => expect(screen.getByTestId('print-count')).toHaveTextContent('1'), WAIT);
  const stored = JSON.parse(sessionStorage.getItem(`nocobase.doc-print.trace:${docNo}`) ?? '{}') as Record<string, unknown>;
  expect(stored).toMatchObject({ printCount: 1, lastPrintedBy: 'u1', lastPrintedByName: '' });
});
