export interface Attachment {
  name: string;
  dataUrl: string;
  id?: string;
  mime?: string;
  bytes?: number;
}

const MAX_BYTES = 50 * 1024 * 1024;

/* Upload any file to the control plane. Images come back usable as a preview
   (`dataUrl` is the attachment URL); everything else is stored opaquely and the
   agent receives it as a file on disk to read/process with its tools. */
export async function uploadAttachment(file: File): Promise<Attachment> {
  if (file.size > MAX_BYTES) throw new Error('Files must be 50 MB or smaller.');
  const mime = file.type || 'application/octet-stream';
  const response = await fetch(`/api/v2/attachments?name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'content-type': mime }, body: file });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || 'Upload failed.');
  const a = result.attachment;
  return { id: a.id, name: a.name, mime: a.mime, bytes: a.bytes, dataUrl: a.url };
}
