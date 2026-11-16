import { escapeHtml, safeHttpUrl } from './email-utils';

type EmailLayoutOptions = {
  title: string;
  preheader?: string;
  bannerUrl: string;
  siteUrl: string;
  body: string;
};

/**
 * Shared responsive 2xPredict email shell.
 * The body is trusted template HTML; all layout metadata is escaped here.
 */
export function emailLayout({
  title,
  preheader,
  bannerUrl,
  siteUrl,
  body,
}: EmailLayoutOptions): string {
  const year = new Date().getFullYear();
  const safeTitle = escapeHtml(title);
  const safePreheader = escapeHtml(preheader ?? '');
  const safeBannerUrl = escapeHtml(safeHttpUrl(bannerUrl) ?? '');
  const safeSiteUrl = escapeHtml(safeHttpUrl(siteUrl) ?? '#');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="x-apple-disable-message-reformatting" />
  <meta name="color-scheme" content="light" />
  <meta name="supported-color-schemes" content="light" />
  <title>${safeTitle}</title>
  <style>
    body, table, td, a { -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; }
    table, td { mso-table-lspace:0pt; mso-table-rspace:0pt; }
    img { -ms-interpolation-mode:bicubic; border:0; outline:none; text-decoration:none; }
    table { border-collapse:collapse !important; }
    @media only screen and (max-width: 640px) {
      .email-outer { padding:16px 8px !important; }
      .email-shell { width:100% !important; max-width:100% !important; }
      .email-content { padding:26px 20px !important; }
      .email-footer { padding:22px 18px !important; }
      .email-banner { height:auto !important; }
      .email-heading { font-size:23px !important; line-height:1.3 !important; }
      .email-button { width:100% !important; }
      .email-button a { display:block !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background:#f3f0ed;font-family:Arial,Helvetica,sans-serif;color:#334155;">
  ${preheader ? `<div style="display:none!important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;max-height:0;max-width:0;overflow:hidden;mso-hide:all;">${safePreheader}</div>` : ''}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background:#f3f0ed;">
    <tr>
      <td class="email-outer" align="center" style="padding:34px 14px;">
        <table role="presentation" class="email-shell" width="640" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:640px;background:#ffffff;border:1px solid #e8e1da;border-radius:14px;overflow:hidden;">
          <tr>
            <td style="height:5px;line-height:5px;background:#6b233b;font-size:0;">&nbsp;</td>
          </tr>
          <tr>
            <td style="padding:0;background:#ffffff;">
              <img class="email-banner" src="${safeBannerUrl}" alt="2xPredict" width="640" style="display:block;width:100%;max-width:640px;height:auto;margin:0;padding:0;" />
            </td>
          </tr>
          <tr>
            <td class="email-content" style="padding:38px 42px 34px;background:#ffffff;">
              ${body}
            </td>
          </tr>
          <tr>
            <td class="email-footer" align="center" style="padding:26px 30px;background:#f7f2ea;border-top:1px solid #eee4d8;">
              <p style="margin:0;color:#6b233b;font-size:14px;line-height:1.5;font-weight:bold;letter-spacing:.2px;">2xPredict</p>
              <p style="margin:7px 0 12px;color:#64748b;font-size:12px;line-height:1.6;">Football insights. More informed decisions.</p>
              <p style="margin:0;color:#64748b;font-size:12px;line-height:1.6;">
                <a href="${safeSiteUrl}" style="color:#6b233b;text-decoration:none;font-weight:bold;">www.2xpredict.com</a>
              </p>
              <p style="margin:12px 0 0;color:#94a3b8;font-size:11px;line-height:1.6;">&copy; ${year} 2xPredict. All rights reserved.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
