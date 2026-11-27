import { useApiClient } from '@nocobase/app-client';
import { useLocale, useTranslation } from '@nocobase/i18n/client';
import { useMemo, useState, type ReactElement } from 'react';

import {
  AttachmentPanel,
  type AttachmentFile,
  type AttachmentLabels,
} from '#components/attachment-list';
import { errorText } from '#components/erp/messages';

import {
  acceptDocFiles,
  DocFilesClient,
  docFileImage,
  DOC_FILE_MAX_COUNT,
  type DocFile,
} from './doc-files.js';

/**
 * 各单据上的「单据附件」区：复用反馈单那一套展示组件，上传/下载接通用附件端点。
 * `ids` 是单据请求体里的 `fileIds`，父层保存时整组提交；这里只改这一组 id。
 */
export function DocFilesPanel({
  files,
  ids,
  onChange,
  disabled = false,
}: {
  readonly files: readonly DocFile[];
  readonly ids: readonly string[];
  readonly onChange: (ids: readonly string[]) => void;
  readonly disabled?: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const { locale } = useLocale();
  const api = useApiClient();
  const client = useMemo(() => new DocFilesClient(api), [api]);
  const [uploading, setUploading] = useState<readonly string[]>([]);
  const [error, setError] = useState<string>();

  const labels: AttachmentLabels = {
    title: t('erp.docFiles.title'),
    images: t('erp.docFiles.images'),
    files: t('erp.docFiles.files'),
    pending: t('erp.docFiles.pending'),
    upload: t('erp.docFiles.upload'),
    preview: t('erp.docFiles.preview'),
    download: t('erp.docFiles.download'),
    remove: t('erp.docFiles.remove'),
    uploading: t('erp.docFiles.uploading'),
    removeTitle: t('erp.docFiles.removeTitle'),
    removeDescription: t('erp.docFiles.removeDescription'),
    removeConfirm: t('erp.docFiles.removeConfirm'),
    cancel: t('erp.docFiles.cancel'),
    previous: t('erp.docFiles.previous'),
    next: t('erp.docFiles.next'),
  };

  const shown: readonly AttachmentFile[] = files.map((file) => ({
    id: file.id,
    name: file.name,
    size: file.size,
    image: docFileImage(file),
    url: client.contentUrl(file.id),
    downloadUrl: client.contentUrl(file.id),
  }));

  const upload = async (picked: readonly File[]): Promise<void> => {
    if (disabled) return;
    const accepted = acceptDocFiles(picked, ids.length);
    if (accepted.length === 0) {
      setError(t('erp.docFiles.invalid'));
      return;
    }
    setError(undefined);
    setUploading(accepted.map((file) => file.name));
    try {
      const uploaded = await Promise.all(
        accepted.map((file) => client.upload(file)),
      );
      onChange([...ids, ...uploaded.map((file) => file.id)]);
    } catch (cause) {
      setError(errorText(cause, t));
    } finally {
      setUploading([]);
    }
  };

  return (
    <div className='flex flex-col gap-2'>
      <AttachmentPanel
        files={shown}
        labels={labels}
        locale={locale}
        uploading={uploading}
        hint={t('erp.docFiles.hint', { count: DOC_FILE_MAX_COUNT })}
        {...(disabled
          ? {}
          : {
              onUpload: (picked) => void upload(picked),
              onRemove: async (file) => onChange(ids.filter((id) => id !== file.id)),
            })}
      />
      {error ? (
        <p role='alert' className='text-sm text-destructive'>
          {error}
        </p>
      ) : null}
    </div>
  );
}
