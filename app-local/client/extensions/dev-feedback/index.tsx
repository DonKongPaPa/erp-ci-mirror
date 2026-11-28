import { useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';

import { Badge } from '#components/ui/badge';
import { Button } from '#components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '#components/ui/collapsible';
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
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '#components/ui/sheet';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '#components/ui/tabs';
import { Textarea } from '#components/ui/textarea';

/**
 * R-087 测试反馈表：开发区里的反馈列表与功能登记表（R-073，不进部署产物）。
 *
 * 数据来自 `GET /dev/feedback`，每次打开现算；反馈状态由主会话用脚本写，页面不改历史。
 * 「看过，没意见」是本机的确认，记在 localStorage；未反馈的行按进入测试版的时刻算天数。
 */

import {
  byModule,
  byStatus,
  inRegistryGroup,
  KIND_KEY,
  KIND_ORDER,
  STATUS_KEY,
  STATUS_ORDER,
  targetLabel,
  type FeedbackItem,
  type FeedbackSnapshot,
  type RegistryGroup,
  type RegistryViewRow,
  registryViews,
} from './model.js';

const NOW = new Date().toISOString();

function attachmentUrl(id: string): string {
  return `/api/dev/feedback/attachments/${encodeURIComponent(id)}`;
}

function FeedbackDetail({
  item,
  onNote,
}: {
  readonly item: FeedbackItem;
  readonly onNote: (text: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const [note, setNote] = useState('');
  return (
    <div className='flex flex-col gap-3 text-sm' data-testid={`detail-${item.id}`}>
      <div className='flex items-center gap-2'>
        <Badge variant='outline'>{item.id}</Badge>
        <Badge>{t(STATUS_KEY[item.status])}</Badge>
        {item.severe ? <Badge variant='destructive'>{t('devTools.feedback.severe')}</Badge> : null}
      </div>
      <p className='whitespace-pre-wrap'>{item.text}</p>
      <p className='text-xs text-muted-foreground'>
        {targetLabel(item)} · {item.at}
      </p>
      <div className='flex flex-wrap gap-1'>
        {item.kinds.map((kind) => (
          <Badge key={kind} variant='secondary'>
            {t(KIND_KEY[kind])}
          </Badge>
        ))}
      </div>
      {item.screenshot ? (
        <img
          src={attachmentUrl(item.screenshot)}
          alt={t('devTools.feedback.attached')}
          className='max-h-96 max-w-full rounded border border-border'
          data-testid={`screenshot-${item.id}`}
        />
      ) : null}
      {item.ref ? (
        <p className='text-xs text-muted-foreground'>{item.ref}</p>
      ) : null}
      {item.note ? <p className='whitespace-pre-wrap'>{item.note}</p> : null}
        {item.notes.map((entry) => (
        <p key={`${item.id}-${entry.at}`} className='whitespace-pre-wrap' data-testid={`note-${item.id}-${entry.at}`}>
          {entry.text}
        </p>
      ))}
      <div className='flex flex-col gap-2' data-testid={`note-form-${item.id}`}>
        <Label htmlFor={`note-${item.id}`}>{t('devTools.feedback.addNote')}</Label>
        <Textarea
          id={`note-${item.id}`}
          placeholder={t('devTools.feedback.notePlaceholder')}
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
        <Button
          type='button'
          size='sm'
          disabled={note.trim().length === 0}
          onClick={() => {
            onNote(note.trim());
            setNote('');
          }}
        >
          {t('devTools.feedback.noteSubmit')}
        </Button>
      </div>
    </div>
  );
}

function FeedbackBoard({
  snapshot,
  onNote,
}: {
  readonly snapshot: FeedbackSnapshot;
  readonly onNote: (id: string, text: string) => Promise<void>;
}): ReactElement {
  const { t } = useTranslation();
  const [status, setStatus] = useState('all');
  const [kind, setKind] = useState('all');
  const [moduleFilter, setModuleFilter] = useState('all');
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const modules = useMemo(
    () => [...new Set(snapshot.registry.map((row) => row.module))].sort(),
    [snapshot],
  );
  const visible = useMemo(
    () =>
      snapshot.items.filter((item) => {
        if (status !== 'all' && item.status !== status) return false;
        if (kind !== 'all' && !item.kinds.includes(kind as never)) return false;
        if (moduleFilter !== 'all') {
          const row = snapshot.registry.find((entry) =>
            item.target.kind === 'registry'
              ? entry.id === item.target.registryId
              : entry.route !== undefined && entry.route === item.route,
          );
          if (row?.module !== moduleFilter) return false;
        }
        return true;
      }),
    [snapshot, status, kind, moduleFilter],
  );
  const chosen = visible.find((item) => item.id === selected) ?? null;

  const submitNote = (id: string, text: string): void => {
    setBusy(id);
    setFailed(false);
    void onNote(id, text)
      .then(() => setBusy(null))
      .catch(() => {
        setBusy(null);
        setFailed(true);
      });
  };

  return (
    <div className='flex flex-col gap-4'>
      <div className='flex flex-wrap gap-2'>
        <Select value={status} onValueChange={(value) => setStatus(value ?? 'all')}>
          <SelectTrigger aria-label={t('devTools.feedback.filterStatus')} className='w-40'>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value='all'>{t('devTools.feedback.all')}</SelectItem>
            {STATUS_ORDER.map((value) => (
              <SelectItem key={value} value={value}>
                {t(STATUS_KEY[value])}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={kind} onValueChange={(value) => setKind(value ?? 'all')}>
          <SelectTrigger aria-label={t('devTools.feedback.filterKind')} className='w-40'>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value='all'>{t('devTools.feedback.all')}</SelectItem>
            {KIND_ORDER.map((value) => (
              <SelectItem key={value} value={value}>
                {t(KIND_KEY[value])}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={moduleFilter} onValueChange={(value) => setModuleFilter(value ?? 'all')}>
          <SelectTrigger aria-label={t('devTools.feedback.filterModule')} className='w-40'>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value='all'>{t('devTools.feedback.all')}</SelectItem>
            {modules.map((value) => (
              <SelectItem key={value} value={value}>
                {value}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {failed ? <p role='alert'>{t('devTools.feedback.submitFailed')}</p> : null}
      <div className='grid gap-3 md:grid-cols-5' data-testid='feedback-columns'>
        {STATUS_ORDER.map((value) => (
          <section
            key={value}
            className='flex min-h-24 flex-col gap-2 rounded-md border border-border bg-card p-2'
            data-testid={`feedback-column-${value}`}
            aria-label={t(STATUS_KEY[value])}
          >
            <h3 className='text-sm font-semibold'>{t(STATUS_KEY[value])}</h3>
            {byStatus(visible, value).map((item) => (
              <Button
                key={item.id}
                type='button'
                variant='ghost'
                size='sm'
                className='h-auto w-full justify-start whitespace-normal text-left font-normal'
                data-testid={`feedback-card-${item.id}`}
                onClick={() => setSelected(item.id)}
              >
                <span className='flex flex-col items-start gap-1'>
                  <Badge variant='outline'>{item.id}</Badge>
                  <span>{item.text}</span>
                  <span className='text-xs text-muted-foreground'>{targetLabel(item)}</span>
                  {item.screenshot ? (
                    <img
                      src={attachmentUrl(item.screenshot)}
                      alt={t('devTools.feedback.attached')}
                      className='h-10 rounded'
                    />
                  ) : null}
                </span>
              </Button>
            ))}
          </section>
        ))}
      </div>
      <Sheet open={chosen !== null} onOpenChange={(next) => !next && setSelected(null)}>
        <SheetContent className='w-full max-w-xl'>
          <SheetHeader>
            <SheetTitle>{chosen?.id ?? ''}</SheetTitle>
            <SheetDescription>{t('devTools.feedback.detail')}</SheetDescription>
          </SheetHeader>
          <div className='min-h-0 flex-1 overflow-y-auto px-4'>
            {chosen ? (
              <FeedbackDetail item={chosen} onNote={(text) => submitNote(chosen.id, text)} />
            ) : null}
            {chosen && busy === chosen.id ? (
              <p className='text-xs'>{t('devTools.feedback.submitting')}</p>
            ) : null}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

function RegistryBoard({
  rows,
  seen,
  onSeen,
}: {
  readonly rows: readonly RegistryViewRow[];
  readonly seen: Readonly<Record<string, string>>;
  readonly onSeen: (id: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState<RegistryGroup | 'all'>('all');
  const filtered = useMemo(
    () =>
      rows.filter((row) => {
        const text = query.trim().toLowerCase();
        const match =
          !text ||
          [row.module, row.page, row.feature, row.route ?? '', row.source].some((value) =>
            value.toLowerCase().includes(text),
          );
        if (!match) return false;
        if (group === 'all') return true;
        return (
          (group === 'feedbacked' && row.feedbackCount > 0) ||
          (group === 'seen' && row.feedbackCount === 0 && seen[row.id] !== undefined) ||
          (group === 'unfeedbacked' && row.feedbackCount === 0 && seen[row.id] === undefined)
        );
      }),
    [rows, query, group, seen],
  );

  const forThisRow = (row: RegistryViewRow): void => {
    window.dispatchEvent(
      new CustomEvent('dev-feedback:target', { detail: row.id }),
    );
  };

  return (
    <div className='flex flex-col gap-4'>
      <div className='flex flex-wrap gap-2'>
        <Input
          className='max-w-sm'
          aria-label={t('devTools.feedback.filterRegistry')}
          placeholder={t('devTools.feedback.filterRegistry')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Select value={group} onValueChange={(value) => setGroup(value ?? 'all')}>
          <SelectTrigger aria-label={t('devTools.feedback.registryStatus')} className='w-48'>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value='all'>{t('devTools.feedback.all')}</SelectItem>
            <SelectItem value='feedbacked'>{t('devTools.feedback.registryFeedbacked')}</SelectItem>
            <SelectItem value='seen'>{t('devTools.feedback.registrySeen')}</SelectItem>
            <SelectItem value='unfeedbacked'>{t('devTools.feedback.registryUnfeedbacked')}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {(['feedbacked', 'seen', 'unfeedbacked'] as const).map((key) => {
        const grouped = byModule(inRegistryGroup(filtered, key));
        if (grouped.length === 0) return null;
        return (
          <section key={key} data-testid={`registry-group-${key}`}>
            <h3 className='mb-2 text-base font-semibold'>
              {t(
                key === 'feedbacked'
                  ? 'devTools.feedback.registryFeedbacked'
                  : key === 'seen'
                    ? 'devTools.feedback.registrySeen'
                    : 'devTools.feedback.registryUnfeedbacked',
              )}
            </h3>
            {grouped.map((entry) => (
              <Collapsible key={entry.module} defaultOpen>
                <CollapsibleTrigger className='text-sm font-medium'>
                  {entry.module}（{entry.rows.length}）
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className='overflow-x-auto'>
                    <table className='w-full text-left text-sm' data-testid={`registry-table-${entry.module}`}>
                      <thead>
                        <tr className='text-xs text-muted-foreground'>
                          <th>{t('devTools.feedback.registryPage')}</th>
                          <th>{t('devTools.feedback.registryFeature')}</th>
                          <th>{t('devTools.feedback.registryRoute')}</th>
                          <th>{t('devTools.feedback.registrySource')}</th>
                          <th>{t('devTools.feedback.registryStatus')}</th>
                          <th>{t('devTools.feedback.registryFeedbacks')}</th>
                          <th>{t('devTools.feedback.actions')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {entry.rows.map((row) => (
                          <tr key={row.id} data-testid={`registry-row-${row.id}`}>
                            <td>{row.page}</td>
                            <td>{row.feature}</td>
                            <td>{row.route ?? '—'}</td>
                            <td className='font-mono text-xs'>{row.source}</td>
                            <td>
                              {row.feedbackCount > 0
                                ? t('devTools.feedback.registryFeedbacked')
                                : row.seenAt
                                  ? t('devTools.feedback.registrySeen')
                                  : row.daysSinceBeta === null
                                    ? t('devTools.feedback.notEnteredBeta')
                                    : t('devTools.feedback.registryDays', {
                                        days: row.daysSinceBeta,
                                      })}
                            </td>
                            <td>{row.openCount}</td>
                            <td className='flex gap-1'>
                              <Button
                                type='button'
                                size='sm'
                                variant='outline'
                                data-testid={`registry-seen-${row.id}`}
                                onClick={() => onSeen(row.id)}
                              >
                                {t('devTools.feedback.markSeen')}
                              </Button>
                              <Button
                                type='button'
                                size='sm'
                                variant='outline'
                                data-testid={`registry-feedback-${row.id}`}
                                onClick={() => forThisRow(row)}
                              >
                                {t('devTools.feedback.forThisRow')}
                              </Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </CollapsibleContent>
              </Collapsible>
            ))}
          </section>
        );
      })}
      {filtered.length === 0 ? <p>{t('devTools.feedback.noItems')}</p> : null}
    </div>
  );
}

export default function FeedbackPage(): ReactElement {
  const api = useApiClient();
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<FeedbackSnapshot | null>(null);
  const [failed, setFailed] = useState(false);
  const [seenFailed, setSeenFailed] = useState(false);
  // 只是一轮会话里的即时提示；真相在服务端 state.json，页面每次打开都从端点取。
  const [seen, setSeen] = useState<Readonly<Record<string, string>>>({});

  const load = useCallback((): void => {
    const controller = new AbortController();
    void api
      .request<{ data: FeedbackSnapshot }>({
        path: '/dev/feedback',
        signal: controller.signal,
      })
      .then((body) => {
        if (!controller.signal.aborted) setSnapshot(body.data);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
  }, [api]);

  useEffect(() => {
    load();
    const refresh = (): void => load();
    const noteRefresh = (): void => load();
    window.addEventListener('dev-feedback:refresh', refresh);
    window.addEventListener('dev-feedback:note', noteRefresh);
    return () => {
      window.removeEventListener('dev-feedback:refresh', refresh);
      window.removeEventListener('dev-feedback:note', noteRefresh);
    };
  }, [load]);

  const markSeen = (id: string): void => {
    setSeenFailed(false);
    void api
      .request<{ data: { registryId: string; at: string } }>({
        path: '/dev/feedback/seen',
        method: 'POST',
        json: { registryId: id },
      })
      .then((body) => {
        setSeen((current) => ({ ...current, [body.data.registryId]: body.data.at }));
        load();
      })
      .catch(() => setSeenFailed(true));
  };

  // 端点返回的 seen 是真相；本次会话刚表态的时刻只在这里即时显示，下一次打开仍以端点为准。
  const effectiveSeen = useMemo(
    () => ({ ...(snapshot?.seen ?? {}), ...seen }),
    [snapshot, seen],
  );

  if (failed) return <p role='alert'>{t('devTools.feedback.loadFailed')}</p>;
  if (!snapshot) return <p>{t('devTools.feedback.loading')}</p>;

  const rows = registryViews(snapshot.registry, snapshot.items, effectiveSeen, NOW);

  return (
    <div className='mx-auto flex w-full max-w-6xl flex-col gap-6 p-6'>
      <h1 className='text-2xl font-semibold'>{t('devTools.feedback.title')}</h1>
      {seenFailed ? (
        <p role='alert'>{t('devTools.feedback.submitFailed')}</p>
      ) : null}
      <Tabs defaultValue='feedback'>
        <TabsList>
          <TabsTrigger value='feedback' data-testid='tab-feedback'>
            {t('devTools.feedback.tabFeedback')}
          </TabsTrigger>
          <TabsTrigger value='registry' data-testid='tab-registry'>
            {t('devTools.feedback.tabRegistry')}
          </TabsTrigger>
        </TabsList>
        <TabsContent value='feedback'>
          <FeedbackBoard
            snapshot={snapshot}
            onNote={(id, text) => {
              return api
                .request({
                  path: `/dev/feedback/${id}/notes`,
                  method: 'POST',
                  json: { text },
                })
                .then(() => load());
            }}
          />
        </TabsContent>
        <TabsContent value='registry'>
          <RegistryBoard rows={rows} seen={effectiveSeen} onSeen={markSeen} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
