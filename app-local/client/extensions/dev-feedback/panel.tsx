import { ApiClientError, useApiClient, useToaster } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { Check, MessageSquareWarning } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type ReactElement,
} from 'react';
import { useLocation } from 'react-router';

import { Button } from '#components/ui/button';
import { Input } from '#components/ui/input';
import { Label } from '#components/ui/label';
import { Switch } from '#components/ui/switch';
import { Textarea } from '#components/ui/textarea';

/**
 * R-087 每页右下角的反馈悬浮入口（R-073，不进部署产物）。
 *
 * 由 `development-extensions.ts` 在开发构建里登记到布局的浮层挂点；布局本身不认识它。
 * 一句话加 Ctrl+Enter 就能交：当前路由自动带上，定位方式与类型有上次的选择，截图直接粘贴。
 * 点选元素时监听挂在 `useEffect` 的清理函数里，高亮样式也在那里还原 —— 中途退出不留下监听与描边。
 */

import {
  KIND_HINT_KEY,
  KIND_KEY,
  KIND_ORDER,
  buildFeedbackRequestBody,
  type ElementDraftInput,
  type FeedbackKind,
  type FeedbackPreference,
  type FeedbackSnapshot,
  locateElement,
  readPreference,
  userTextLength,
} from './model.js';

const IMAGE_TYPES: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/webp': 'webp',
  'image/jpeg': 'jpeg',
};

/** 4xx 用能看懂的话讲清原因，网络错误才回到「请重试」。 */
function submitErrorKey(error: unknown): string {
  if (error instanceof ApiClientError) {
    if (error.reason === 'TEXT_TOO_SHORT')
      return 'devTools.feedback.submitTextShort';
    if (error.status >= 400 && error.status < 500)
      return 'devTools.feedback.submitInvalid';
  }
  return 'devTools.feedback.submitFailed';
}

function savePreference(preference: FeedbackPreference): void {
  try {
    localStorage.setItem('dev-feedback.preference', JSON.stringify(preference));
  } catch {
    // 隐私模式下写不进去也不该让提交失败。
  }
}

export default function FeedbackPanel(): ReactElement {
  const api = useApiClient();
  const { t } = useTranslation();
  const toaster = useToaster();
  const { pathname } = useLocation();
  const storage =
    typeof localStorage === 'undefined' ? undefined : localStorage;
  const [preference, setPreference] = useState<FeedbackPreference>(() =>
    readPreference(storage),
  );
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [severe, setSevere] = useState(false);
  const [element, setElement] = useState<ElementDraftInput | null>(null);
  const [guides, setGuides] = useState<Partial<Record<FeedbackKind, string>>>(
    {},
  );
  const [registryId, setRegistryId] = useState('');
  const [registry, setRegistry] = useState<FeedbackSnapshot['registry']>([]);
  const [registryQuery, setRegistryQuery] = useState('');
  const [picking, setPicking] = useState(false);
  const [attachmentId, setAttachmentId] = useState<string | null>(null);
  const [attachmentUrl, setAttachmentUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const highlightedRef = useRef<HTMLElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const caretRef = useRef<number | null>(null);
  const previousLocateRef = useRef<FeedbackPreference['locate']>('page');

  const kinds: readonly FeedbackKind[] = preference.kinds;
  // 快捷输入插入的引导句不算正文：只有用户自己写的字够四个才让提交。
  const bodyLength = userTextLength(text, Object.values(guides));

  const updatePreference = useCallback(
    (change: Partial<FeedbackPreference>) => {
      setPreference((current) => {
        const next = { ...current, ...change };
        savePreference(next);
        return next;
      });
    },
    [],
  );

  const loadRegistry = useCallback((): void => {
    void api
      .request<{ data: FeedbackSnapshot }>({ path: '/dev/feedback' })
      .then((body) => setRegistry(body.data.registry))
      .catch(() => undefined);
  }, [api]);

  const toggle = (): void => {
    const next = !open;
    setError(null);
    setOpen(next);
    if (next) loadRegistry();
  };

  // 点选模式：捕获阶段先于业务页面的点击；清理函数一定移除监听并还原描边。
  useEffect(() => {
    if (!picking) return;
    const restore = (): void => {
      if (highlightedRef.current) {
        highlightedRef.current.style.outline = '';
        highlightedRef.current = null;
      }
    };
    const onMove = (event: MouseEvent): void => {
      const target = event.target;
      if (
        !(target instanceof HTMLElement) ||
        target.closest('[data-dev-feedback-panel]')
      ) {
        restore();
        return;
      }
      if (highlightedRef.current && highlightedRef.current !== target) {
        highlightedRef.current.style.outline = '';
      }
      highlightedRef.current = target;
      target.style.outline = '2px solid hsl(var(--primary))';
    };
    const onClick = (event: MouseEvent): void => {
      const target = event.target;
      if (
        !(target instanceof HTMLElement) ||
        target.closest('[data-dev-feedback-panel]')
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const located = locateElement(target);
      setElement({
        kind: 'element',
        text: located.text,
        locator: located.locator,
        ...(located.source ? { source: located.source } : {}),
      });
      updatePreference({ locate: 'element' });
      setPicking(false);
    };
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    return () => {
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('click', onClick, true);
      restore();
    };
  }, [picking, updatePreference]);

  useEffect(() => {
    return () => {
      if (attachmentUrl) URL.revokeObjectURL(attachmentUrl);
    };
  }, [attachmentUrl]);

  // 插入引导句后光标留在冒号后面；用户自己打字时不抢光标。
  useEffect(() => {
    const node = textareaRef.current;
    if (caretRef.current === null || !node) return;
    const at = Math.min(caretRef.current, node.value.length);
    node.focus();
    node.setSelectionRange(at, at);
    caretRef.current = null;
  }, [text]);

  // Esc 先退出拾取（回到进入前的定位模式），再按时关面板。选「回到之前模式」而不是停在空拾取态，
  // 这样一次 Esc 就能撤销误点的「点选页面上的元素」，不会留下一个无法提交的 element 模式。
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (picking) {
        updatePreference({ locate: previousLocateRef.current });
        setPicking(false);
      } else {
        setError(null);
        setOpen(false);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, picking, updatePreference]);

  // 功能登记表里的「针对这一条反馈」：打开面板并预选这一行。
  useEffect(() => {
    const onTarget = (event: Event): void => {
      const id = (event as CustomEvent<string>).detail;
      if (typeof id !== 'string') return;
      setRegistryId(id);
      updatePreference({ locate: 'registry', collapsed: false });
      setError(null);
      setOpen(true);
      setPicking(false);
      loadRegistry();
    };
    window.addEventListener('dev-feedback:target', onTarget);
    return () => window.removeEventListener('dev-feedback:target', onTarget);
  }, [updatePreference, loadRegistry]);

  const onPaste = (event: ClipboardEvent): void => {
    const file = Array.from(event.clipboardData?.files ?? []).find(
      (item) => IMAGE_TYPES[item.type] !== undefined,
    );
    if (!file) return;
    event.preventDefault();
    void (async () => {
      try {
        const buffer = await file.arrayBuffer();
        const body = await api.request<{ data: { attachmentId: string } }>({
          path: '/dev/feedback/attachments',
          method: 'POST',
          headers: { 'content-type': file.type },
          body: buffer,
        });
        setAttachmentId(body.data.attachmentId);
        setAttachmentUrl(URL.createObjectURL(file));
      } catch {
        setError(t('devTools.feedback.submitFailed'));
      }
    })();
  };

  const submit = (): void => {
    if (busy || bodyLength < 4) return;
    const locate = preference.locate;
    if (locate === 'element' && element === null) return;
    if (locate === 'registry' && registryId === '') return;
    const json = buildFeedbackRequestBody({
      locate,
      route: pathname,
      element,
      registryId,
      text,
      kinds,
      severe,
      screenshotId: attachmentId,
    });
    setBusy(true);
    setError(null);
    void api
      .request<{ data: { id: string } }>({
        path: '/dev/feedback',
        method: 'POST',
        json: json as unknown as Record<string, unknown>,
      })
      .then((result) => {
        setText('');
        setGuides({});
        setElement(null);
        setRegistryId('');
        setAttachmentId(null);
        setAttachmentUrl(null);
        setPicking(false);
        setBusy(false);
        setOpen(false);
        toaster.show({
          type: 'success',
          title: t('devTools.feedback.submitted', { id: result.data.id }),
        });
      })
      .catch((error: unknown) => {
        setBusy(false);
        setError(t(submitErrorKey(error)));
      });
  };

  const toggleKind = (kind: FeedbackKind): void => {
    const selected = kinds.includes(kind);
    const node = textareaRef.current;
    const caret = node?.selectionStart ?? text.length;
    if (selected) {
      // 取消只删这一类自己插入的那一句，用户手写的字一律保留。
      const inserted = guides[kind];
      if (inserted) {
        setText((current) => current.replace(inserted, ''));
        setGuides((current) => {
          const next = { ...current };
          delete next[kind];
          return next;
        });
        caretRef.current = Math.max(0, caret - inserted.length);
      }
      updatePreference({ kinds: kinds.filter((item) => item !== kind) });
      return;
    }
    // 选中：在光标处插入引导句，不覆盖已有文字，光标停在冒号后面。
    const hint = t(KIND_HINT_KEY[kind]);
    setText(`${text.slice(0, caret)}${hint}${text.slice(caret)}`);
    setGuides((current) => ({ ...current, [kind]: hint }));
    caretRef.current = caret + hint.length;
    updatePreference({ kinds: [...kinds, kind] });
  };

  const choices = registry
    .filter((row) => {
      const query = registryQuery.trim().toLowerCase();
      if (!query) return true;
      return [row.module, row.page, row.feature, row.route ?? ''].some(
        (value) => value.toLowerCase().includes(query),
      );
    })
    .slice(0, 30);

  if (preference.collapsed) {
    return (
      <Button
        type='button'
        size='icon'
        aria-label={t('devTools.feedback.floating')}
        data-testid='dev-feedback-floating'
        onClick={() => {
          setError(null);
          updatePreference({ collapsed: false });
        }}
      >
        <MessageSquareWarning className='size-4' />
      </Button>
    );
  }

  return (
    <div
      className={`flex flex-col gap-2 rounded-lg border border-border bg-card p-3 text-sm shadow-lg${
        preference.locate === 'registry' ? ' max-w-md' : ''
      }`}
      data-testid='dev-feedback-panel'
      onPaste={onPaste}
    >
      <div className='flex items-center justify-between gap-2'>
        <span className='font-medium'>{t('devTools.feedback.panelTitle')}</span>
        <Button
          type='button'
          variant='ghost'
          size='sm'
          aria-label={t('devTools.feedback.floating')}
          data-testid='dev-feedback-toggle'
          onClick={toggle}
        >
          {open ? '×' : '…'}
        </Button>
      </div>
      {!open ? (
        <Button
          type='button'
          size='sm'
          data-testid='dev-feedback-open'
          onClick={toggle}
        >
          {t('devTools.feedback.floating')}
        </Button>
      ) : null}
      {open ? (
        <>
          <Button
            type='button'
            variant='ghost'
            size='sm'
            className='self-end'
            aria-label={t('devTools.feedback.collapse')}
            data-testid='dev-feedback-collapse'
            onClick={() => {
              setError(null);
              updatePreference({ collapsed: true });
            }}
          >
            {t('devTools.feedback.collapse')}
          </Button>
          <div className='flex flex-wrap gap-1'>
            <Button
              type='button'
              size='sm'
              variant={preference.locate === 'page' ? 'default' : 'outline'}
              aria-pressed={preference.locate === 'page'}
              data-testid='dev-feedback-locate-page'
              onClick={() => {
                setError(null);
                updatePreference({ locate: 'page' });
                setPicking(false);
              }}
            >
              {t('devTools.feedback.locatePage')}
            </Button>
            <Button
              type='button'
              size='sm'
              variant={preference.locate === 'element' ? 'default' : 'outline'}
              aria-pressed={preference.locate === 'element'}
              data-testid='dev-feedback-locate-element'
              onClick={() => {
                previousLocateRef.current = preference.locate;
                setError(null);
                updatePreference({ locate: 'element' });
                setPicking(true);
              }}
            >
              {t('devTools.feedback.locateElement')}
            </Button>
            <Button
              type='button'
              size='sm'
              variant={preference.locate === 'registry' ? 'default' : 'outline'}
              aria-pressed={preference.locate === 'registry'}
              data-testid='dev-feedback-locate-registry'
              onClick={() => {
                setError(null);
                updatePreference({ locate: 'registry' });
                setPicking(false);
                loadRegistry();
              }}
            >
              {t('devTools.feedback.locateRegistry')}
            </Button>
          </div>
          {picking ? (
            <p className='text-xs'>{t('devTools.feedback.picking')}</p>
          ) : null}
          {preference.locate === 'element' && element ? (
            <p
              className='text-xs text-muted-foreground'
              data-testid='dev-feedback-picked'
            >
              {t('devTools.feedback.picked', {
                text: element.text || element.locator,
              })}
            </p>
          ) : null}
          {preference.locate === 'registry' ? (
            <div className='flex flex-col gap-1'>
              <Input
                aria-label={t('devTools.feedback.filterRegistry')}
                placeholder={t('devTools.feedback.filterRegistry')}
                value={registryQuery}
                onChange={(event) => setRegistryQuery(event.target.value)}
              />
              <div className='max-h-32 overflow-y-auto'>
                {choices.map((row) => (
                  <Button
                    key={row.id}
                    type='button'
                    variant={registryId === row.id ? 'secondary' : 'ghost'}
                    size='sm'
                    className='h-auto min-w-0 w-full justify-start font-normal'
                    data-testid={`dev-feedback-registry-${row.id}`}
                    onClick={() => setRegistryId(row.id)}
                  >
                    <span className='min-w-0 truncate'>
                      {row.module} · {row.page} · {row.feature}
                    </span>
                  </Button>
                ))}
              </div>
            </div>
          ) : null}
          <Label htmlFor='dev-feedback-text'>
            {t('devTools.feedback.textLabel')}
          </Label>
          <Textarea
            id='dev-feedback-text'
            ref={textareaRef}
            data-testid='dev-feedback-text'
            value={text}
            placeholder={t('devTools.feedback.textPlaceholder')}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                submit();
              }
            }}
          />
          <div
            className='flex flex-wrap gap-1'
            data-testid='dev-feedback-kinds'
          >
            {KIND_ORDER.map((kind) => {
              const selected = kinds.includes(kind);
              return (
                <Button
                  key={kind}
                  type='button'
                  size='sm'
                  variant={selected ? 'default' : 'outline'}
                  aria-pressed={selected}
                  aria-label={t(KIND_KEY[kind])}
                  data-testid={`dev-feedback-kind-${kind}`}
                  onClick={() => toggleKind(kind)}
                >
                  {selected ? (
                    <Check className='size-3' aria-hidden='true' />
                  ) : null}
                  {t(KIND_KEY[kind])}
                </Button>
              );
            })}
          </div>
          <div className='flex items-center gap-2'>
            <Switch
              id='dev-feedback-severe'
              data-testid='dev-feedback-severe'
              checked={severe}
              onCheckedChange={(value) => setSevere(value === true)}
            />
            <Label htmlFor='dev-feedback-severe'>
              {t('devTools.feedback.severe')}
            </Label>
            <span className='text-xs text-muted-foreground'>
              {t('devTools.feedback.severeHint')}
            </span>
          </div>
          <p className='text-xs text-muted-foreground'>
            {t('devTools.feedback.attach')}
          </p>
          {attachmentId ? (
            <p className='text-xs' data-testid='dev-feedback-attachment'>
              {t('devTools.feedback.attached')}
            </p>
          ) : null}
          {attachmentUrl ? (
            <div className='flex items-center gap-2'>
              <img
                src={attachmentUrl}
                alt={t('devTools.feedback.attached')}
                className='h-18 rounded'
              />
              <Button
                type='button'
                size='sm'
                variant='ghost'
                onClick={() => {
                  URL.revokeObjectURL(attachmentUrl);
                  setAttachmentUrl(null);
                  setAttachmentId(null);
                }}
              >
                {t('devTools.feedback.removeAttachment')}
              </Button>
            </div>
          ) : null}
          {error ? <p role='alert'>{error}</p> : null}
          <Button
            type='button'
            className='self-end'
            data-testid='dev-feedback-submit'
            disabled={busy || bodyLength < 4}
            onClick={submit}
          >
            {busy
              ? t('devTools.feedback.submitting')
              : t('devTools.feedback.submit')}
          </Button>
        </>
      ) : null}
    </div>
  );
}
