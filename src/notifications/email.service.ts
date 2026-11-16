import {
  Injectable,
  InternalServerErrorException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { Resend } from 'resend';

import { emailLayout } from './templates/email-layout';
import {
  COMMUNICATION_BANNER_PATH,
  NotificationRoutes,
  buildFrontendUrl,
  normalizeNotificationActionUrl,
} from './notification-routes';

import {
  sectionTitle,
  paragraph,
  warningBox,
  successBox,
  dangerBox,
  infoCard,
  primaryButton,
  secondaryButton,
  codePanel,
} from './templates/email-components';
import {
  escapeHtml,
  formatEmailDate,
  safeEmailSubject,
  safeHttpUrl,
} from './templates/email-utils';

@Injectable()
export class EmailService {
  private resendClient?: { apiKey: string; client: Resend };

  constructor(private readonly config: ConfigService) {}

  /** Build absolute links using the configured public frontend origin. */
  private frontendPath(path: string): string {
    return buildFrontendUrl(this.config.get<string>('FRONTEND_URL'), path);
  }

  /** Password-reset links must point to the configured public frontend origin. */
  private passwordResetUrl(resetLink: string): string {
    const safeUrl = safeHttpUrl(resetLink);
    const frontendOrigin = new URL(this.frontendPath(NotificationRoutes.HOME)).origin;

    if (!safeUrl || new URL(safeUrl).origin !== frontendOrigin) {
      throw new InternalServerErrorException('Invalid password reset link.');
    }

    return safeUrl;
  }

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
      return await this.resend.emails.send(
        {
          from: '2XPredict <register@2xpredict.com>',
          to: email,
          subject: 'Verify Your Email Address',
          html: emailLayout({
            bannerUrl: this.frontendPath(COMMUNICATION_BANNER_PATH),
            siteUrl: this.frontendPath(NotificationRoutes.HOME),
            title: 'Verify Your Email Address',
            preheader: 'Use the verification code to complete your 2xPredict registration.',
            body: `
${sectionTitle('Verify Your Email Address')}
${paragraph('Welcome to <strong>2xPredict</strong>. To complete your registration, enter the verification code below.')}
${codePanel('Verification Code', otp, 'This code expires in 20 minutes.')}
${paragraph('For your security, never share this code with anyone.')}
${warningBox('If you did not create a 2xPredict account, you can safely ignore this email.')}
`,
          }),
        },
        idempotencyKey ? { idempotencyKey } : undefined,
      );
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      if (error instanceof InternalServerErrorException) throw error;
      // Avoid logging OTPs, email addresses or provider payloads.
      throw new InternalServerErrorException('Failed to send OTP email');
    }
  }

  async sendPasswordResetEmail(
    email: string,
    resetLink: string,
    idempotencyKey?: string,
  ) {
    const safeResetLink = this.passwordResetUrl(resetLink);

    return this.resend.emails.send(
      {
        from: '2XPredict <passwordreset@2xpredict.com>',
        to: email,
        subject: 'Reset Your Password',
        html: emailLayout({
          bannerUrl: this.frontendPath(COMMUNICATION_BANNER_PATH),
          siteUrl: this.frontendPath(NotificationRoutes.HOME),
          title: 'Reset Your Password',
          preheader: 'Use the secure link to reset your 2xPredict password.',
          body: `
${sectionTitle('Reset Your Password')}
${paragraph('We received a request to reset the password for your 2xPredict account. Select the button below to continue.')}
${primaryButton('Reset Password', safeResetLink)}
${warningBox('This password reset link expires in <strong>30 minutes</strong>. For your security, do not share it with anyone.')}
${paragraph('If the button does not work, copy and paste this link into your browser:')}
<p style="margin:0 0 20px;word-break:break-all;font-size:12px;line-height:1.7;"><a href="${escapeHtml(safeResetLink)}" style="color:#6b233b;">${escapeHtml(safeResetLink)}</a></p>
${paragraph('If you did not request a password reset, you can safely ignore this email. Your password will remain unchanged.')}
`,
        }),
      },
      idempotencyKey ? { idempotencyKey } : undefined,
    );
  }

  async sendPaymentReceivedEmail(data: {
    email: string;
    amount: number;
    currency: string;
    paymentType: string;
    reference: string;
  }) {
    const homeUrl = this.frontendPath(NotificationRoutes.PROFILE_BILLING);

    const aboutUrl = this.frontendPath(NotificationRoutes.CUSTOMER_CARE);

    const symbol = data.currency === 'USD' ? '$' : '₦';

    return this.resend.emails.send({
      from: '2XPredict <payments@2xpredict.com>',

      to: data.email,

      subject: 'Payment Request Submitted — Awaiting Verification',

      html: emailLayout({
        bannerUrl: this.frontendPath(COMMUNICATION_BANNER_PATH),
        siteUrl: this.frontendPath(NotificationRoutes.HOME),
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

${primaryButton('View Payment & Subscription', homeUrl)}

${secondaryButton('Contact Customer Care', aboutUrl)}

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
    const dashboardUrl = this.frontendPath(NotificationRoutes.PROFILE);

    const predictionsUrl = this.frontendPath(NotificationRoutes.PREDICTIONS);

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
        bannerUrl: this.frontendPath(COMMUNICATION_BANNER_PATH),
        siteUrl: this.frontendPath(NotificationRoutes.HOME),
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
    value: formatEmailDate(data.activatedDate),
  },
  {
    label: 'Expires',
    value: formatEmailDate(data.expiryDate),
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

${primaryButton('View Profile', dashboardUrl)}

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
    const paymentUrl = this.frontendPath(NotificationRoutes.PROFILE_BILLING);

    const supportUrl = this.frontendPath(NotificationRoutes.CUSTOMER_CARE);

    const symbol = data.currency === 'USD' ? '$' : '₦';

    return this.resend.emails.send({
      from: '2XPredict <payments@2xpredict.com>',

      to: data.email,

      subject: 'Your Payment Could Not Be Verified',

      html: emailLayout({
        bannerUrl: this.frontendPath(COMMUNICATION_BANNER_PATH),
        siteUrl: this.frontendPath(NotificationRoutes.HOME),
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
<strong>${escapeHtml(data.reason || 'No reason was provided by the administrator.')}</strong>
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

${secondaryButton('Contact Customer Care', supportUrl)}

${paragraph(`
Thank you for your patience and understanding.

We appreciate your continued support of 2XPredict.
`)}
`,
      }),
    });
  }

  async sendWelcomeEmail(
    data: { email: string; fullName: string },
    idempotencyKey?: string,
  ) {
    const safeFullName = escapeHtml(data.fullName);
    const predictionsUrl = this.frontendPath(NotificationRoutes.PREDICTIONS);

    const betlabUrl = this.frontendPath(NotificationRoutes.BET_LAB);

    return this.resend.emails.send(
      {
        from: '2XPredict <welcome@2xpredict.com>',

        to: data.email,

        subject: 'Welcome to 2XPredict 🎉',

        html: emailLayout({
          bannerUrl: this.frontendPath(COMMUNICATION_BANNER_PATH),
          siteUrl: this.frontendPath(NotificationRoutes.HOME),
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
      },
      idempotencyKey ? { idempotencyKey } : undefined,
    );
  }

  async sendSubscriptionExpiringEmail(data: {
    email: string;
    plan: 'regular' | 'vip' | 'premium';
    expiryDate: Date;
    daysRemaining: number;
  }) {
    const renewalUrl = this.frontendPath(NotificationRoutes.PROFILE_BILLING);

    const dashboardUrl = this.frontendPath(NotificationRoutes.PROFILE);

    return this.resend.emails.send({
      from: '2XPredict <subscriptions@2xpredict.com>',

      to: data.email,

      subject: `Your ${safePlanLabel(data.plan)} Subscription Expires Soon`,

      html: emailLayout({
        bannerUrl: this.frontendPath(COMMUNICATION_BANNER_PATH),
        siteUrl: this.frontendPath(NotificationRoutes.HOME),
        title: 'Subscription Expiring Soon',

        preheader: 'Your subscription will expire soon.',

        body: `
${sectionTitle('Your Subscription is Almost Expiring ⏳')}

${paragraph(`
Hello,

Your <strong>${safePlanLabel(data.plan)}</strong> subscription will expire soon.

To continue enjoying uninterrupted access to premium football predictions and member benefits, please renew your subscription before it expires.
`)}

${warningBox(`
Your subscription expires in <strong>${safeDaysRemaining(data.daysRemaining)} day${
  safeDaysRemaining(data.daysRemaining) === 1 ? '' : 's'
}</strong>.
`)}

${infoCard('Subscription Details', [
  {
    label: 'Plan',
    value: safePlanLabel(data.plan),
  },
  {
    label: 'Expires On',
    value: formatEmailDate(data.expiryDate),
  },
  {
    label: 'Days Remaining',
    value: `${safeDaysRemaining(data.daysRemaining)}`,
  },
])}

${paragraph(`
Renewing before your subscription expires ensures you continue enjoying uninterrupted access to all your current benefits.
`)}

${primaryButton('Renew Subscription', renewalUrl)}

${secondaryButton('View Profile', dashboardUrl)}

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
    const renewalUrl = this.frontendPath(NotificationRoutes.PROFILE_BILLING);

    const predictionsUrl = this.frontendPath(NotificationRoutes.PREDICTIONS);

    return this.resend.emails.send({
      from: '2XPredict <subscriptions@2xpredict.com>',

      to: data.email,

      subject: 'Your Subscription Has Expired',

      html: emailLayout({
        bannerUrl: this.frontendPath(COMMUNICATION_BANNER_PATH),
        siteUrl: this.frontendPath(NotificationRoutes.HOME),
        title: 'Subscription Expired',

        preheader: 'Your subscription has expired.',

        body: `
${sectionTitle('Your Subscription Has Expired')}

${paragraph(`
Hello,

Your <strong>${safePlanLabel(data.plan)}</strong> subscription has now expired.

Premium features are no longer available until your subscription is renewed.
`)}

${dangerBox(`
Your subscription expired on <strong>${formatEmailDate(data.expiryDate)}</strong>.
`)}

${infoCard('Subscription Summary', [
  {
    label: 'Plan',
    value: safePlanLabel(data.plan),
  },
  {
    label: 'Status',
    value: 'Expired',
  },
  {
    label: 'Expired On',
    value: formatEmailDate(data.expiryDate),
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
    const title = String(data.title ?? '').trim();
    const message = escapeHtml(data.message ?? '');
    const actionPath = normalizeNotificationActionUrl(safeLocalActionPath(data.actionUrl));
    const actionUrl = actionPath
      ? this.frontendPath(actionPath)
      : null;
    const details = (data.details ?? []).slice(0, 8).map((item) => ({
      label: String(item.label ?? ''),
      value: String(item.value ?? ''),
    }));
    const safeSubject = safeEmailSubject(data.title, '2xPredict notification');

    return this.resend.emails.send(
      {
        from: '2XPredict <register@2xpredict.com>',
        to: data.email,
        subject: `2xPredict | ${safeSubject}`,
        html: emailLayout({
          bannerUrl: this.frontendPath(COMMUNICATION_BANNER_PATH),
          siteUrl: this.frontendPath(NotificationRoutes.HOME),
          title,
          preheader: String(data.message ?? '').slice(0, 150),
          body: `
${sectionTitle(title)}
${paragraph(message)}
${details.length ? infoCard('Details', details) : ''}
${actionUrl ? primaryButton('View in 2xPredict', actionUrl) : ''}
${paragraph('This message relates to activity on your 2xPredict account. Sign in to your account for more information.')}
`,
        }),
      },
      { idempotencyKey },
    );
  }
}


function safePlanLabel(plan: unknown): string {
  switch (String(plan ?? '').toLowerCase()) {
    case 'regular': return 'REGULAR';
    case 'vip': return 'VIP';
    case 'premium': return 'PREMIUM';
    default: return 'MEMBERSHIP';
  }
}

function safeDaysRemaining(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
}

function safeLocalActionPath(value?: string | null): string | null {
  const path = String(value ?? '').trim();
  if (!path || !path.startsWith('/') || path.startsWith('//')) return null;
  if (/[\\\r\n]/.test(path)) return null;
  return path.slice(0, 300);
}
