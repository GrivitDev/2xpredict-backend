import {
  Injectable,
  InternalServerErrorException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { Resend } from 'resend';

import { emailLayout } from './templates/email-layout';

import {
  sectionTitle,
  paragraph,
  warningBox,
  successBox,
  dangerBox,
  infoCard,
  primaryButton,
  secondaryButton,
} from './templates/email-components';
@Injectable()
export class EmailService {
  private resendClient?: { apiKey: string; client: Resend };

  constructor(private readonly config: ConfigService) {}

  /** Resolve Resend lazily so missing optional provider credentials never
   * prevent the Nest application from booting. */
  private get resend(): Resend {
    const apiKey = this.config.get<string>('RESEND_API_KEY')?.trim();
    if (!apiKey) {
      throw new ServiceUnavailableException(
        'Email delivery is unavailable because RESEND_API_KEY is not configured.',
      );
    }
    if (!this.resendClient || this.resendClient.apiKey !== apiKey) {
      this.resendClient = { apiKey, client: new Resend(apiKey) };
    }
    return this.resendClient.client;
  }

  async sendOtpEmail(email: string, otp: string, idempotencyKey?: string) {
    try {
      const response = await this.resend.emails.send({
        from: '2XPredict <register@2xpredict.com>',
        to: email,
        subject: 'Verify Your Email Address',
        html: `
<!DOCTYPE html>
<html>

<head>
<meta charset="UTF-8">
<title>Email Verification</title>
</head>

<body
  style="
    margin:0;
    padding:0;
    background:#f4f7fb;
    font-family:Arial,Helvetica,sans-serif;
  "
>

<table
  width="100%"
  cellpadding="0"
  cellspacing="0"
  style="padding:40px 20px;"
>

<tr>

<td align="center">

<table
  width="600"
  cellpadding="0"
  cellspacing="0"
  style="
    background:#ffffff;
    border-radius:18px;
    overflow:hidden;
    box-shadow:0 8px 30px rgba(0,0,0,.08);
  "
>

<!-- Banner -->

<tr>

<td>

<img
  src="https://www.2xpredict.com/banner.png"
  alt="Football Predictions"
  width="600"
  style="
    display:block;
    width:100%;
  "
/>

</td>

</tr>

<!-- Body -->

<tr>

<td style="padding:40px;">

<h2
  style="
    margin-top:0;
    color:#111827;
  "
>

Verify Your Email Address

</h2>

<p
  style="
    color:#4b5563;
    line-height:1.8;
    font-size:16px;
  "
>

Welcome to <strong>2XPredict</strong>!

<br><br>

To complete your registration, please use the verification code below.

</p>

<div
  style="
    background:#eff6ff;
    border:2px dashed #2563eb;
    border-radius:12px;
    padding:25px;
    text-align:center;
    margin:35px 0;
  "
>

<p
  style="
    margin:0;
    color:#6b7280;
    font-size:14px;
    text-transform:uppercase;
    letter-spacing:2px;
  "
>

Verification Code

</p>

<div
  style="
    margin-top:15px;
    font-size:42px;
    font-weight:bold;
    letter-spacing:10px;
    color:#2563eb;
  "
>

${otp}

</div>

</div>

<p
  style="
    color:#6b7280;
    line-height:1.8;
  "
>

This verification code will expire in
<strong>20 minutes</strong>.

</p>

<p
  style="
    color:#6b7280;
    line-height:1.8;
  "
>

For your security, never share this code with anyone.

</p>

<hr
  style="
    border:none;
    border-top:1px solid #e5e7eb;
    margin:35px 0;
  "
>

<p
  style="
    color:#9ca3af;
    font-size:14px;
    line-height:1.8;
  "
>

If you didn't create an 2XPredict account,
you can safely ignore this email.

</p>

</td>

</tr>

<!-- Footer -->

<tr>

<td
  align="center"
  style="
    background:#f9fafb;
    padding:25px;
  "
>

<p
  style="
    margin:0;
    color:#6b7280;
    font-size:13px;
  "
>

© ${new Date().getFullYear()} 2XPredict

</p>

<p
  style="
    margin-top:10px;
  "
>

<a
  href="https://www.2xpredict.com"
  style="
    color:#2563eb;
    text-decoration:none;
  "
>

www.2xpredict.com

</a>

</p>

</td>

</tr>

</table>

</td>

</tr>

</table>

</body>

</html>
`,
      }, idempotencyKey ? ({ idempotencyKey } as any) : undefined);

      return response;
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      // Avoid logging OTPs, email addresses or provider payloads.
      throw new InternalServerErrorException('Failed to send OTP email');
    }
  }

  async sendPasswordResetEmail(email: string, resetLink: string, idempotencyKey?: string) {
    const safeResetLink = escapeHtml(resetLink);
    return this.resend.emails.send({
      from: '2XPredict <passwordreset@2xpredict.com>',
      to: email,
      subject: 'Reset Your Password',
      html: `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Reset Password</title>
</head>

<body style="
  margin:0;
  padding:0;
  background:#f4f7fb;
  font-family:Arial,Helvetica,sans-serif;
">

<table
  width="100%"
  cellpadding="0"
  cellspacing="0"
  style="padding:40px 20px;"
>

<tr>

<td align="center">

<table
  width="600"
  cellpadding="0"
  cellspacing="0"
  style="
    background:#ffffff;
    border-radius:18px;
    overflow:hidden;
    box-shadow:0 8px 30px rgba(0,0,0,.08);
  "
>


<!-- Banner -->

<tr>

<td>

<img
  src="https://www.2xpredict.com/banner.png"
  alt="Football"
  width="600"
  style="
    display:block;
    width:100%;
  "
/>

</td>

</tr>

<!-- Content -->

<tr>

<td style="padding:40px;">

<h2
  style="
    margin-top:0;
    color:#111827;
  "
>

Reset Your Password

</h2>

<p
  style="
    color:#4b5563;
    line-height:1.7;
    font-size:16px;
  "
>

Hello,

<br><br>

We received a request to reset the password for your 2XPredict account.

If this was you, simply click the button below.

</p>

<div
  style="
    text-align:center;
    margin:40px 0;
  "
>

<a
  href="${safeResetLink}"
  style="
    background:#2563eb;
    color:#ffffff;
    padding:16px 36px;
    text-decoration:none;
    border-radius:8px;
    font-weight:bold;
    font-size:16px;
    display:inline-block;
  "
>

Reset Password

</a>

</div>

<p
  style="
    color:#6b7280;
    line-height:1.7;
  "
>

This password reset link will expire in
<strong>30 minutes</strong>.

</p>

<p
  style="
    color:#6b7280;
    line-height:1.7;
  "
>

If the button doesn't work, copy and paste this link into your browser:

</p>

<p
  style="
    word-break:break-word;
  "
>

<a
  href="${safeResetLink}"
  style="
    color:#2563eb;
  "
>

${safeResetLink}

</a>

</p>

<hr
  style="
    border:none;
    border-top:1px solid #e5e7eb;
    margin:35px 0;
  "
>

<p
  style="
    color:#9ca3af;
    font-size:14px;
    line-height:1.7;
  "
>

If you didn't request a password reset,
you can safely ignore this email.
Your password will remain unchanged.

</p>

</td>

</tr>

<!-- Footer -->

<tr>

<td
  align="center"
  style="
    background:#f9fafb;
    padding:25px;
  "
>

<p
  style="
    margin:0;
    color:#6b7280;
    font-size:13px;
  "
>

© ${new Date().getFullYear()} 2XPredict

</p>

<p
  style="
    margin:10px 0 0;
  "
>

<a
  href="https://www.2xpredict.com"
  style="
    color:#2563eb;
    text-decoration:none;
  "
>

www.2xpredict.com

</a>

</p>

</td>

</tr>

</table>

</td>

</tr>

</table>

</body>

</html>
`,
    }, idempotencyKey ? ({ idempotencyKey } as any) : undefined);
  }
  async sendPaymentReceivedEmail(data: {
    email: string;
    amount: number;
    currency: string;
    paymentType: string;
    reference: string;
  }) {
    const homeUrl = 'https://www.2xpredict.com';

    const aboutUrl = 'https://www.2xpredict.com/about';

    const symbol = data.currency === 'USD' ? '$' : '₦';

    return this.resend.emails.send({
      from: '2XPredict <payments@2xpredict.com>',

      to: data.email,

      subject: 'Payment Request Submitted — Awaiting Verification',

      html: emailLayout({
        title: 'Payment Submission Received',

        preheader:
          'Your payment submission has been recorded and is awaiting verification.',

        body: `
${sectionTitle('Payment Request Submitted')}

${paragraph(`
Hello,

Thank you for submitting your payment to 2XPredict.

Your payment request has been recorded and is now awaiting verification by our finance team.

Verification normally takes less than <strong>30 minutes</strong>.
As soon as your payment has been approved you will receive another confirmation email.
`)}

${warningBox(`
Your payment request is pending verification. This message does not confirm payment settlement or subscription activation.
No further action is required from you at this time.
`)}

${infoCard('Payment Summary', [
  {
    label: 'Payment Type',
    value: data.paymentType,
  },
  {
    label: 'Amount',
    value: `${symbol}${data.amount.toLocaleString()}`,
  },
  {
    label: 'Reference',
    value: data.reference,
  },
  {
    label: 'Status',
    value: 'Pending Verification',
  },
])}

${primaryButton('🏠 Go to Home', homeUrl)}

${secondaryButton('ℹ About 2XPredict', aboutUrl)}

${paragraph(`
Need help?

Our support team is always available if you have any questions regarding your payment.
`)}
`,
      }),
    });
  }

  async sendSubscriptionActivatedEmail(data: {
    email: string;
    plan: 'regular' | 'vip' | 'premium';
    amount: number;
    currency: string;
    activatedDate: Date;
    expiryDate: Date;
  }) {
    const dashboardUrl = 'https://www.2xpredict.com/dashboard';

    const predictionsUrl = 'https://www.2xpredict.com/predictions';

    const symbol = data.currency === 'USD' ? '$' : '₦';

    const planName =
      data.plan === 'premium'
        ? 'Premium Subscription'
        : data.plan === 'vip'
          ? 'VIP Subscription'
          : 'Regular Subscription';

    return this.resend.emails.send({
      from: '2XPredict <subscriptions@2xpredict.com>',

      to: data.email,

      subject: `${planName} Activated Successfully`,

      html: emailLayout({
        title: 'Subscription Activated',

        preheader: 'Your subscription has been activated successfully.',

        body: `
${sectionTitle('🎉 Subscription Activated')}

${paragraph(`
Congratulations!

Your <strong>${planName}</strong> has been activated successfully.

Thank you for choosing 2XPredict.
`)}

${successBox(`
Your subscription is now active.

You can immediately enjoy all the features available on your selected plan.
`)}

${infoCard('Subscription Summary', [
  {
    label: 'Plan',
    value: planName,
  },
  {
    label: 'Status',
    value: '🟢 Active',
  },
  {
    label: 'Amount Paid',
    value: `${symbol}${data.amount.toLocaleString()}`,
  },
  {
    label: 'Activated',
    value: data.activatedDate.toLocaleDateString('en-NG', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    }),
  },
  {
    label: 'Expires',
    value: data.expiryDate.toLocaleDateString('en-NG', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    }),
  },
])}

${
  data.plan === 'premium'
    ? `
${infoCard('Premium Benefits', [
  { label: '✓ Premium Prediction Access', value: '' },
  { label: '✓ Full Market Access', value: '' },
  { label: '✓ Priority Member Features', value: '' },
  { label: '✓ Advanced Analysis', value: '' },
])}
`
    : data.plan === 'vip'
      ? `
${infoCard('VIP Benefits', [
  { label: '✓ Premium Predictions', value: '' },
  { label: '✓ VIP Markets', value: '' },
  { label: '✓ Expert Analysis', value: '' },
  { label: '✓ Early Access', value: '' },
])}
`
      : `
${infoCard('Regular Benefits', [
  { label: '✓ Regular Predictions', value: '' },
  { label: '✓ Member Features', value: '' },
  { label: '✓ Daily Tips', value: '' },
])}
`
}

${primaryButton('📊 Go to Dashboard', dashboardUrl)}

${secondaryButton('⚽ Browse Predictions', predictionsUrl)}

${paragraph(`
Thank you for trusting 2XPredict.

We wish you success with your football predictions!
`)}
`,
      }),
    });
  }

  async sendPaymentRejectedEmail(data: {
    email: string;
    paymentType: string;
    amount: number;
    currency: string;
    reason?: string;
  }) {
    const paymentUrl = 'https://www.2xpredict.com/payments';

    const supportUrl = 'https://www.2xpredict.com/about';

    const symbol = data.currency === 'USD' ? '$' : '₦';

    return this.resend.emails.send({
      from: '2XPredict <payments@2xpredict.com>',

      to: data.email,

      subject: 'Your Payment Could Not Be Verified',

      html: emailLayout({
        title: 'Payment Rejected',

        preheader: 'Your payment verification was unsuccessful.',

        body: `
${sectionTitle('Payment Verification Unsuccessful')}

${paragraph(`
Hello,

Unfortunately, we were unable to verify your recent payment submission.

This does not necessarily mean your payment failed. In many cases, payments are rejected because the uploaded proof is unclear, the transfer details cannot be verified, or there is missing information.
`)}

${dangerBox(`
Your payment request has been rejected.

Reason:
<strong>${data.reason || 'No reason was provided by the administrator.'}</strong>
`)}

${infoCard('Payment Details', [
  {
    label: 'Payment Type',
    value: data.paymentType,
  },
  {
    label: 'Amount',
    value: `${symbol}${data.amount.toLocaleString()}`,
  },
  {
    label: 'Status',
    value: 'Rejected',
  },
])}

${paragraph(`
You can submit another payment request after correcting the issue mentioned above.

If you believe this decision was made in error, please contact our support team and include your payment details.
`)}

${primaryButton('Submit Another Payment', paymentUrl)}

${secondaryButton('About 2XPredict', supportUrl)}

${paragraph(`
Thank you for your patience and understanding.

We appreciate your continued support of 2XPredict.
`)}
`,
      }),
    });
  }

  async sendWelcomeEmail(data: { email: string; fullName: string }, idempotencyKey?: string) {
    const safeFullName = escapeHtml(data.fullName);
    const predictionsUrl = 'https://www.2xpredict.com/predictions';

    const betlabUrl = 'https://www.2xpredict.com/bet-lab';

    return this.resend.emails.send({
      from: '2XPredict <welcome@2xpredict.com>',

      to: data.email,

      subject: 'Welcome to 2XPredict 🎉',

      html: emailLayout({
        title: 'Welcome to 2XPredict',

        preheader: 'Your account has been verified successfully.',

        body: `
${sectionTitle('Welcome to 2XPredict! ⚽')}

${paragraph(`
Hello <strong>${safeFullName}</strong>,

Congratulations! Your account has been verified successfully, and you're now officially part of the 2XPredict community.

We're excited to have you with us and look forward to helping you make smarter football prediction decisions.
`)}

${successBox(`
Your account is now fully verified and ready to use.

You can start exploring today's predictions immediately.
`)}

${infoCard('Your Account', [
  {
    label: 'Status',
    value: 'Verified',
  },
  {
    label: 'Membership',
    value: 'Free',
  },
  {
    label: 'Access',
    value: 'Active',
  },
])}

${paragraph(`
As a member of 2XPredict, you can:

• View free football predictions

• Access predictions and markets included with your subscription

• Choose a Regular, VIP, or Premium subscription

• Access expert football analysis

• Receive timely match insights
`)}

${primaryButton('Browse Predictions', predictionsUrl)}

${secondaryButton('Try Betlab', betlabUrl)}

${paragraph(`
Thank you for choosing 2XPredict.

We wish you success and hope you enjoy everything our platform has to offer.
`)}
`,
      }),
    }, idempotencyKey ? ({ idempotencyKey } as any) : undefined);
  }

  async sendSubscriptionExpiringEmail(data: {
    email: string;
    plan: 'regular' | 'vip' | 'premium';
    expiryDate: Date;
    daysRemaining: number;
  }) {
    const renewalUrl = 'https://www.2xpredict.com/subscription';

    const dashboardUrl = 'https://www.2xpredict.com/dashboard';

    return this.resend.emails.send({
      from: '2XPredict <subscriptions@2xpredict.com>',

      to: data.email,

      subject: `Your ${data.plan.toUpperCase()} Subscription Expires Soon`,

      html: emailLayout({
        title: 'Subscription Expiring Soon',

        preheader: 'Your subscription will expire soon.',

        body: `
${sectionTitle('Your Subscription is Almost Expiring ⏳')}

${paragraph(`
Hello,

Your <strong>${data.plan.toUpperCase()}</strong> subscription will expire soon.

To continue enjoying uninterrupted access to premium football predictions and member benefits, please renew your subscription before it expires.
`)}

${warningBox(`
Your subscription expires in <strong>${data.daysRemaining} day${
  data.daysRemaining === 1 ? '' : 's'
}</strong>.
`)}

${infoCard('Subscription Details', [
  {
    label: 'Plan',
    value: data.plan.toUpperCase(),
  },
  {
    label: 'Expires On',
    value: data.expiryDate.toLocaleDateString('en-NG', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    }),
  },
  {
    label: 'Days Remaining',
    value: `${data.daysRemaining}`,
  },
])}

${paragraph(`
Renewing before your subscription expires ensures you continue enjoying uninterrupted access to all your current benefits.
`)}

${primaryButton('Renew Subscription', renewalUrl)}

${secondaryButton('Go to Dashboard', dashboardUrl)}

${paragraph(`
Thank you for choosing 2XPredict.

We appreciate your continued support.
`)}
`,
      }),
    });
  }

  async sendSubscriptionExpiredEmail(data: {
    email: string;
    plan: 'regular' | 'vip' | 'premium';
    expiryDate: Date;
  }) {
    const renewalUrl = 'https://www.2xpredict.com/subscription';

    const predictionsUrl = 'https://www.2xpredict.com/predictions';

    return this.resend.emails.send({
      from: '2XPredict <subscriptions@2xpredict.com>',

      to: data.email,

      subject: 'Your Subscription Has Expired',

      html: emailLayout({
        title: 'Subscription Expired',

        preheader: 'Your subscription has expired.',

        body: `
${sectionTitle('Your Subscription Has Expired')}

${paragraph(`
Hello,

Your <strong>${data.plan.toUpperCase()}</strong> subscription has now expired.

Premium features are no longer available until your subscription is renewed.
`)}

${dangerBox(`
Your subscription expired on <strong>${data.expiryDate.toLocaleDateString(
  'en-NG',
  {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  },
)}</strong>.
`)}

${infoCard('Subscription Summary', [
  {
    label: 'Plan',
    value: data.plan.toUpperCase(),
  },
  {
    label: 'Status',
    value: 'Expired',
  },
  {
    label: 'Expired On',
    value: data.expiryDate.toLocaleDateString('en-NG', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    }),
  },
])}

${paragraph(`
Renew today to regain immediate access to premium football predictions, expert analysis, and exclusive member content.
`)}

${primaryButton('Renew Subscription', renewalUrl)}

${secondaryButton('Browse Free Predictions', predictionsUrl)}

${paragraph(`
We hope to welcome you back soon.

Thank you for being part of 2XPredict.
`)}
`,
      }),
    });
  }

  /**
   * Sends the generic email representation of an in-app notification.
   * Resend's provider idempotency key is stable across outbox retries.
   */
  async sendNotificationEmail(
    data: {
      email: string;
      title: string;
      message: string;
      actionUrl?: string | null;
      details?: Array<{ label: string; value: string }>;
    },
    idempotencyKey: string,
  ) {
    const title = escapeHtml(data.title);
    const message = escapeHtml(data.message);
    const actionPath = safeLocalActionPath(data.actionUrl);
    const actionUrl = actionPath
      ? `https://www.2xpredict.com${actionPath}`
      : null;
    const details = (data.details ?? []).slice(0, 8).map((item) => ({
      label: escapeHtml(item.label),
      value: escapeHtml(item.value),
    }));
    const safeSubject = String(data.title).replace(/[\r\n]+/g, ' ').slice(0, 100);

    return this.resend.emails.send(
      {
        from: '2XPredict <register@2xpredict.com>',
        to: data.email,
        subject: `2xPredict | ${safeSubject}`,
        html: emailLayout({
          title,
          preheader: message.slice(0, 150),
          body: `
${sectionTitle(title)}
${paragraph(message)}
${details.length ? infoCard('Details', details) : ''}
${actionUrl ? primaryButton('View in 2xPredict', actionUrl) : ''}
${paragraph('This message relates to activity on your 2xPredict account. Sign in to your account for more information.')}
`,
        }),
      },
      { idempotencyKey } as any,
    );
  }

}


function escapeHtml(value: string): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeLocalActionPath(value?: string | null): string | null {
  const path = String(value ?? '').trim();
  if (!path || !path.startsWith('/') || path.startsWith('//')) return null;
  if (/[\\\r\n]/.test(path)) return null;
  return path.slice(0, 300);
}

