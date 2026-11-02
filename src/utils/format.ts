/**
 * Formatting utilities
 */

import { msg, str } from '@lit/localize';

/**
 * Format a date relative to now.
 *
 * Every branch is its own message rather than a number plus an English unit
 * suffix: a suffix cannot be translated (and `msg()` at module scope would
 * freeze at the startup locale), so the whole phrase carries the wording.
 * The compact `2m ago`/`3d ago` shape is deliberate — blame rows are narrow —
 * which is why the translations use short forms too.
 */
export function formatRelativeTime(timestamp: number): string {
  if (typeof timestamp !== 'number' || !isFinite(timestamp)) return msg('unknown');
  const now = Date.now();
  const diff = now - timestamp * 1000;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const weeks = Math.floor(days / 7);
  const months = Math.floor(days / 30);
  const years = Math.floor(days / 365);

  if (seconds < 60) return msg('just now');
  if (minutes < 60) return msg(str`${minutes}m ago`);
  if (hours < 24) return msg(str`${hours}h ago`);
  if (days < 7) return msg(str`${days}d ago`);
  if (weeks < 4) return msg(str`${weeks}w ago`);
  if (months < 12) return msg(str`${months}mo ago`);
  return msg(str`${years}y ago`);
}

/**
 * Format a date as ISO string
 */
export function formatDate(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleDateString();
}

/**
 * Format a date with time
 */
export function formatDateTime(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleString();
}

/**
 * Truncate a string with ellipsis
 */
export function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - 1) + '…';
}

/**
 * Format a commit SHA (short)
 */
export function formatSha(sha: string, length = 7): string {
  return sha.slice(0, length);
}

/**
 * Format file size
 */
export function formatFileSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return `${size.toFixed(unitIndex > 0 ? 1 : 0)} ${units[unitIndex]}`;
}

/**
 * Format a number with separators
 */
export function formatNumber(num: number): string {
  return num.toLocaleString();
}

/**
 * Pluralize a word based on count
 */
export function pluralize(count: number, singular: string, plural?: string): string {
  const word = count === 1 ? singular : (plural ?? singular + 's');
  return `${count} ${word}`;
}
