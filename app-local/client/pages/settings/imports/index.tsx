import { resolveAssetUrl, useApiClient, useToaster } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useState, type ChangeEvent, type ReactElement } from 'react';

import { PageContainer } from '#components/page-container';
import { Button } from '#components/ui/button';
import { Input } from '#components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '#components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '#components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '#components/ui/tabs';

import { IMPORT_KINDS, type ImportKind } from './model.js';


interface Issue {
  row: number;
  code: string;
  message: string;
}
interface Report {
  kind: ImportKind;
  rowCount: number;
  wouldCreate: number;
  wouldSkip: number;
  wouldUpdate: number;
  errorCount: number;
  issues: readonly Issue[];
}
interface Parsed {
  token: string;
  rowCount: number;
  headers: readonly string[];
}

/**
 * R-068 导入工具管理页。只在系统设置里出现，页面授权 `imports` 不写进任何业务角色，
 * 所以业务角色连卡片都看不到；服务端三个端点另外核对 root。
 * 不用原生 <form>：三步各有自己的按钮，文件只在内存里按令牌暂存。
 */
export default function ImportsPage(): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const toaster = useToaster();
  const [kind, setKind] = useState<ImportKind>('items');
  const [file, setFile] = useState<File>();
  const [token, setToken] = useState('');
  const [parsed, setParsed] = useState<Parsed>();
  const [report, setReport] = useState<Report>();
  const [mode, setMode] = useState<'skip' | 'update'>('skip');
  const [busy, setBusy] = useState(false);

  const errorOf = (error: unknown): void => {
    const reason = error instanceof Error ? error.message : String(error);
    toaster.show({ type: 'error', title: reason });
  };
  const reset = (): void => {
    setToken('');
    setParsed(undefined);
    setReport(undefined);
  };
  const choose = (next: ImportKind): void => {
    setKind(next);
    setFile(undefined);
    reset();
  };
  const onFile = (event: ChangeEvent<HTMLInputElement>): void => {
    setFile(event.target.files?.[0]);
    reset();
  };
  const runParse = async (): Promise<void> => {
    if (file === undefined) return;
    setBusy(true);
    try {
      const body = new FormData();
      body.append('file', file);
      const result = await api.request<Parsed>({
        path: `imports/${kind}/parse`, method: 'POST', body,
      });
      setParsed(result);
      setToken(result.token);
      setReport(undefined);
    } catch (error) {
      errorOf(error);
    } finally {
      setBusy(false);
    }
  };
  const runDryRun = async (): Promise<void> => {
    if (token === '') return;
    setBusy(true);
    try {
      setReport(await api.request<Report>({
        path: `imports/${kind}/dry-run`, method: 'POST', json: { token },
      }));
    } catch (error) {
      errorOf(error);
    } finally {
      setBusy(false);
    }
  };
  const runCommit = async (): Promise<void> => {
    if (token === '') return;
    setBusy(true);
    try {
      setReport(await api.request<Report>({
        path: `imports/${kind}/commit`, method: 'POST', json: { token, mode },
      }));
      setToken('');
    } catch (error) {
      errorOf(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <PageContainer>
      <h1 className='text-xl font-semibold'>{t('imports.title')}</h1>
      <p className='text-muted-foreground text-sm'>{t('imports.description')}</p>

      <Tabs value={kind} onValueChange={(value) => choose(value as ImportKind)}>
        <TabsList>
          {IMPORT_KINDS.map((item) => (
            <TabsTrigger key={item} value={item}>
              {t(`imports.kinds.${item}`)}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <div className='flex flex-wrap items-center gap-3'>
        <a
          href={resolveAssetUrl(`/import-samples/${kind}.csv`)}
          download={`${kind}.csv`}
          className='text-primary underline text-sm'
        >
          {t('imports.downloadSample')}
        </a>
        <Input type='file' accept='.csv,text/csv' aria-label={t('imports.fileLabel')} onChange={onFile} />
        <Button type='button' disabled={busy || file === undefined} onClick={() => { void runParse(); }}>
          {t('imports.parse')}
        </Button>
        <Button type='button' disabled={busy || token === ''} onClick={() => { void runDryRun(); }}>
          {t('imports.dryRun')}
        </Button>
        <Select value={mode} onValueChange={(value) => setMode(value as 'skip' | 'update')}>
          <SelectTrigger aria-label={t('imports.mode.label')} className='w-32'>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value='skip'>{t('imports.mode.skip')}</SelectItem>
            <SelectItem value='update'>{t('imports.mode.update')}</SelectItem>
          </SelectContent>
        </Select>
        <Button type='button' disabled={busy || token === ''} onClick={() => { void runCommit(); }}>
          {t('imports.commit')}
        </Button>
      </div>

      {parsed !== undefined && (
        <p className='text-sm'>{t('imports.parsed', { count: parsed.rowCount })}</p>
      )}

      {report !== undefined && (
        <div className='flex flex-col gap-3'>
          <div className='flex flex-wrap gap-4 text-sm'>
            <span>{t('imports.report.created', { count: report.wouldCreate })}</span>
            <span>{t('imports.report.skipped', { count: report.wouldSkip })}</span>
            <span>{t('imports.report.updated', { count: report.wouldUpdate })}</span>
            <span>{t('imports.report.errors', { count: report.errorCount })}</span>
          </div>
          {report.issues.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('imports.report.row')}</TableHead>
                  <TableHead>{t('imports.report.code')}</TableHead>
                  <TableHead>{t('imports.report.message')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.issues.map((item) => (
                  <TableRow key={`${item.row}-${item.code}-${item.message}`}>
                    <TableCell>{item.row}</TableCell>
                    <TableCell>{item.code}</TableCell>
                    <TableCell>{item.message}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      )}
    </PageContainer>
  );
}
