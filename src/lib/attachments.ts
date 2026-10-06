export interface Attachment {
  name: string;
  dataUrl: string;
  id?: string;
  mime?: string;
}

const SUPPORTED = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'text/plain', 'text/markdown', 'application/json']);

export async function fileToDataUrl(file: File): Promise<Attachment> {
  const mime = file.type || (/\.(md|txt|log|csv|ts|js|py|css|html)$/i.test(file.name) ? 'text/plain' : '');
  if (!SUPPORTED.has(mime)) throw new Error('Choose an image, text, Markdown or JSON file.');
  if (file.size > 5 * 1024 * 1024) throw new Error('Files must be 5 MB or smaller.');
  const response = await fetch(`/api/v2/attachments?name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'content-type': mime }, body: file });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Upload failed.');
  const a = result.attachment;
  return { id: a.id, name: a.name, mime: a.mime, dataUrl: a.url };
}
