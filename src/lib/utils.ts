import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatTime(value?: number | string | null, withDate = false) {
  if (!value) return '—';
  const date = new Date(Number(value));
  if (Number.isNaN(date.getTime())) return '—';
  const sameDay = date.toDateString() === new Date().toDateString();
  return new Intl.DateTimeFormat(undefined, withDate || !sameDay
    ? { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
    : { hour: 'numeric', minute: '2-digit' }).format(date);
}

export function timeAgo(value?: number | string | null) {
  if (!value) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - Number(value)) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export function humanBytes(value?: number | null) {
  const bytes = Number(value || 0);
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

export function shortDirectory(directory?: string) {
  return directory?.replace(/^\/(?:home|Users)\/[^/]+(?=\/|$)/, '~') || '~/';
}

export function isHomeDirectory(directory?: string) {
  return /^\/(?:home|Users)\/[^/]+$/.test(directory || '');
}

export function plainPreview(value?: string) {
  return String(value || '')
    .replace(/```[\s\S]*?```/g, ' Code ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/^\s*>+\s?/gm, '')
    .replace(/^\s*(?:[-*+] |\d+[.)] )/gm, '')
    .replace(/[*_~`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
