/** Escape untrusted text before placing it in an HTML email. */
export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Email links must be absolute HTTP(S) URLs. This prevents unsafe schemes such
 * as javascript: or data: from being written into href attributes.
 */
export function safeHttpUrl(value: unknown): string | null {
  const candidate = String(value ?? '').trim();
  if (!candidate) return null;

  try {
    const url = new URL(candidate);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** Format untrusted date-like values without leaking "Invalid Date". */
export function formatEmailDate(value: Date | string | number): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not available';

  return date.toLocaleDateString('en-NG', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Africa/Lagos',
  });
}

/** Prevent untrusted titles from creating extra email subject headers. */
export function safeEmailSubject(value: unknown, fallback = '2xPredict update'): string {
  const subject = String(value ?? '')
    .replace(/[\r\n\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);

  return subject || fallback;
}
