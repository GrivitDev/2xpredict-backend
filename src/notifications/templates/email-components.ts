import { escapeHtml, safeHttpUrl } from './email-utils';

const COLORS = {
  burgundy: '#6b233b',
  burgundyDark: '#4d182b',
  champagne: '#e8d7b8',
  champagneSoft: '#f7f2ea',
  slate: '#334155',
  muted: '#64748b',
  border: '#e8e1da',
};

/** Template copy can contain trusted inline HTML. Escape dynamic values first. */
export function paragraph(html: string) {
  return `<p style="margin:0 0 18px;color:${COLORS.slate};font-size:15px;line-height:1.8;">${html}</p>`;
}

export function sectionTitle(title: string) {
  return `<h1 class="email-heading" style="margin:0 0 22px;color:${COLORS.burgundyDark};font-family:Arial,Helvetica,sans-serif;font-size:27px;line-height:1.3;font-weight:700;">${escapeHtml(title)}</h1>
<div style="width:54px;height:3px;background:${COLORS.champagne};margin:0 0 24px;line-height:3px;font-size:0;">&nbsp;</div>`;
}

export function primaryButton(text: string, url: string) {
  const safeUrl = safeHttpUrl(url);
  if (!safeUrl) return '';

  return `<table role="presentation" class="email-button" align="center" cellpadding="0" cellspacing="0" border="0" style="margin:26px auto 20px;">
  <tr><td align="center" bgcolor="${COLORS.burgundy}" style="border-radius:7px;background:${COLORS.burgundy};">
    <a href="${escapeHtml(safeUrl)}" style="display:inline-block;padding:14px 28px;border:1px solid ${COLORS.burgundy};border-radius:7px;color:#ffffff;text-decoration:none;font-size:14px;line-height:1.4;font-weight:bold;">${escapeHtml(text)}</a>
  </td></tr>
</table>`;
}

export function secondaryButton(text: string, url: string) {
  const safeUrl = safeHttpUrl(url);
  if (!safeUrl) return '';

  return `<table role="presentation" class="email-button" align="center" cellpadding="0" cellspacing="0" border="0" style="margin:14px auto 22px;">
  <tr><td align="center" style="border:1px solid ${COLORS.champagne};border-radius:7px;background:#ffffff;">
    <a href="${escapeHtml(safeUrl)}" style="display:inline-block;padding:12px 25px;border-radius:7px;color:${COLORS.burgundy};text-decoration:none;font-size:14px;line-height:1.4;font-weight:bold;">${escapeHtml(text)}</a>
  </td></tr>
</table>`;
}

export function successBox(html: string) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin:22px 0;border:1px solid #b7dfc8;border-left:4px solid #16834a;background:#f0faf4;border-radius:8px;">
  <tr><td style="padding:16px 18px;color:#166534;font-size:14px;line-height:1.7;"><strong style="display:block;margin-bottom:5px;color:#14532d;">Success</strong>${html}</td></tr>
</table>`;
}

export function warningBox(html: string) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin:22px 0;border:1px solid #ead9b9;border-left:4px solid #b58b48;background:${COLORS.champagneSoft};border-radius:8px;">
  <tr><td style="padding:16px 18px;color:#72552c;font-size:14px;line-height:1.7;"><strong style="display:block;margin-bottom:5px;color:${COLORS.burgundy};">Please note</strong>${html}</td></tr>
</table>`;
}

export function dangerBox(html: string) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin:22px 0;border:1px solid #f0c6c6;border-left:4px solid #b42318;background:#fff6f5;border-radius:8px;">
  <tr><td style="padding:16px 18px;color:#7f1d1d;font-size:14px;line-height:1.7;"><strong style="display:block;margin-bottom:5px;color:#7f1d1d;">Action required</strong>${html}</td></tr>
</table>`;
}

export function codePanel(label: string, code: string, helperText?: string) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin:24px 0;border:1px dashed #c9a96e;border-radius:10px;background:${COLORS.champagneSoft};">
  <tr><td align="center" style="padding:22px 16px;">
    <p style="margin:0 0 10px;color:${COLORS.muted};font-size:11px;line-height:1.4;letter-spacing:1.7px;text-transform:uppercase;">${escapeHtml(label)}</p>
    <p style="margin:0;color:${COLORS.burgundy};font-size:32px;line-height:1.3;font-weight:bold;letter-spacing:7px;">${escapeHtml(code)}</p>
    ${helperText ? `<p style="margin:12px 0 0;color:${COLORS.muted};font-size:12px;line-height:1.6;">${escapeHtml(helperText)}</p>` : ''}
  </td></tr>
</table>`;
}

export function infoCard(
  title: string,
  rows: { label: string; value: string }[],
) {
  const safeRows = rows.slice(0, 12).map((row, index) => {
    const border = index === rows.length - 1 ? 'none' : `1px solid ${COLORS.border}`;
    return `<tr>
      <td valign="top" style="padding:11px 8px 11px 0;color:${COLORS.muted};font-size:13px;line-height:1.5;border-bottom:${border};">${escapeHtml(row.label)}</td>
      <td valign="top" align="right" style="padding:11px 0 11px 8px;color:${COLORS.slate};font-size:13px;line-height:1.5;font-weight:600;border-bottom:${border};word-break:break-word;">${escapeHtml(row.value)}</td>
    </tr>`;
  }).join('');

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin:24px 0;border:1px solid ${COLORS.border};border-radius:9px;background:#fff;">
  <tr><td style="padding:17px 18px 8px;">
    <h2 style="margin:0 0 8px;color:${COLORS.burgundyDark};font-size:15px;line-height:1.4;">${escapeHtml(title)}</h2>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;">${safeRows}</table>
  </td></tr>
</table>`;
}
