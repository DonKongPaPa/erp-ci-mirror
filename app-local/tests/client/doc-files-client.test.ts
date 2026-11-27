import { describe, expect, it, vi } from 'vitest';

import {
  acceptDocFiles,
  DocFilesClient,
  DOC_FILE_MAX_COUNT,
} from '../../client/components/erp/doc-files.js';

/** R-021 加片「单据附件」的上传客户端：类型、大小、个数与请求形状。 */
const file = (name: string, type: string, size: number): File =>
  new File([new Uint8Array(size)], name, { type });

describe('document attachment client', () => {
  it('only accepts images and PDFs within the limit and the remaining slots', () => {
    const picked = [
      file('a.png', 'image/png', 10),
      file('b.txt', 'text/plain', 10),
      file('c.pdf', 'application/pdf', 10 * 1024 * 1024 + 1),
      file('d.jpg', 'image/jpeg', 10),
    ];
    const accepted = acceptDocFiles(picked, 0);
    expect(accepted.map((one) => one.name)).toEqual(['a.png', 'd.jpg']);
    expect(acceptDocFiles([file('e.png', 'image/png', 1)], DOC_FILE_MAX_COUNT - 1)).toHaveLength(1);
    expect(acceptDocFiles([file('e.png', 'image/png', 1)], DOC_FILE_MAX_COUNT)).toHaveLength(0);
  });

  it('uploads one file as multipart and builds the content URL', async () => {
    const request = vi.fn(async () => ({ id: 'f1', name: 'a.png', contentType: 'image/png', size: 3 }));
    const client = new DocFilesClient({ request } as never);
    const result = await client.upload(file('a.png', 'image/png', 3));
    expect(result).toEqual({ id: 'f1', name: 'a.png', contentType: 'image/png', size: 3 });
    const call = request.mock.calls[0]![0] as {
      path: string;
      method: string;
      body: FormData;
    };
    expect(call.path).toBe('doc-files');
    expect(call.method).toBe('POST');
    expect(call.body.get('file')).toBeInstanceOf(File);
    expect(client.contentUrl('f1')).toContain('/doc-files/f1/content');
  });
});
