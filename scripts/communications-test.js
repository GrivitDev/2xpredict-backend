#!/usr/bin/env node
'use strict';

/**
 * 2xPredict local communications test harness.
 * Uses the compiled, real EmailService and TelegramService. No MongoDB,
 * notification workers, schedulers, prediction engine or payment modules run.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const BACKEND_ROOT = path.resolve(__dirname, '..');
const FIXTURE_PATH = path.join(
  BACKEND_ROOT,
  'communication-test',
  'fixtures',
  'communications.json',
);
const DEFAULT_OUTPUT = path.join(
  BACKEND_ROOT,
  'communication-test',
  'output',
  'latest',
);

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

function parseArgs(argv) {
  const result = { email: null, telegram: null, send: false, output: DEFAULT_OUTPUT, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      result.help = true;
    } else if (arg === '--send') {
      result.send = true;
    } else if (arg === '--email' || arg === '--telegram' || arg === '--out') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`Missing value after ${arg}.`);
      }
      result[arg.slice(2)] = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return result;
}

function printHelp() {
  console.log(`
2xPredict Communications Test Harness

Preview (no messages are sent):
  node .\\scripts\\communications-test.js --email all
  node .\\scripts\\communications-test.js --telegram all
  node .\\scripts\\communications-test.js --email all --telegram all

Send real test messages:
  node .\\scripts\\communications-test.js --email all --send
  node .\\scripts\\communications-test.js --telegram all --send
  node .\\scripts\\communications-test.js --email all --telegram all --send

Individual email keys:
  otp, password-reset, payment-received, subscription-activated,
  payment-rejected, welcome, subscription-expiring, subscription-expired,
  notification

Individual Telegram keys:
  daily-pick, promotion, internal-ad

Options:
  --email <key|all>       Preview or send email test(s)
  --telegram <key|all>    Preview or send Telegram test(s)
  --send                  Actually contact Resend and/or Telegram
  --out <directory>       Output directory for generated previews/reports
  --help                  Show this help

Without --send, the harness only renders local previews and makes no API calls.
`);
}

function requireCompiledModule(relativeCandidates, label) {
  for (const candidate of relativeCandidates) {
    const fullPath = path.join(BACKEND_ROOT, 'dist', candidate);
    if (fs.existsSync(fullPath)) return require(fullPath);
  }
  throw new Error(
    `${label} was not found in backend/dist. Run "npm run build" from the backend directory first.`,
  );
}

function getFrontendUrl() {
  const configured =
    process.env.COMMUNICATION_TEST_FRONTEND_URL ||
    process.env.FRONTEND_URL ||
    'https://www.2xpredict.com';
  let parsed;
  try {
    parsed = new URL(configured);
  } catch {
    throw new Error('FRONTEND_URL / COMMUNICATION_TEST_FRONTEND_URL must be a valid absolute URL.');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(
      'Communication test sending requires an HTTPS frontend URL so Resend and Telegram can retrieve /banner.png. Set COMMUNICATION_TEST_FRONTEND_URL=https://www.2xpredict.com when your local FRONTEND_URL is localhost.',
    );
  }
  return parsed.origin;
}

function readFixtures() {
  if (!fs.existsSync(FIXTURE_PATH)) {
    throw new Error(`Fixture JSON not found: ${FIXTURE_PATH}`);
  }
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
}

function ensureOutput(outputPath) {
  fs.mkdirSync(outputPath, { recursive: true });
  return outputPath;
}

function safeFileName(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '');
}

function htmlEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

function htmlIndex(emails) {
  const rows = emails.map((email) => `
    <tr>
      <td>${htmlEscape(email.label)}</td>
      <td>${htmlEscape(email.subject || '')}</td>
      <td><a href="${encodeURIComponent(email.fileName)}">Open preview</a></td>
    </tr>`).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>2xPredict Email Previews</title>
<style>body{font:15px/1.5 Arial,sans-serif;background:#f4f1f2;color:#26313d;padding:24px}main{max-width:900px;margin:auto;background:white;padding:24px;border-radius:14px}h1{color:#6b233b}table{width:100%;border-collapse:collapse}td,th{padding:12px;border-bottom:1px solid #e5e7eb;text-align:left}a{color:#6b233b;font-weight:700}.note{padding:12px;background:#fff7e8;border-radius:8px}</style></head>
<body><main><h1>2xPredict Email Previews</h1><p class="note">Local render only. These HTML files were generated through the compiled EmailService with a mocked Resend transport. No email was sent.</p>
<table><thead><tr><th>Template</th><th>Subject</th><th>Preview</th></tr></thead><tbody>${rows}</tbody></table></main></body></html>`;
}

function buildEmailCases(service, fixtures, recipient, frontendUrl, runId) {
  const payment = fixtures.payment;
  const subscription = fixtures.subscription;
  const notification = fixtures.notification;
  const resetLink = `${frontendUrl}/reset-password?token=${encodeURIComponent(fixtures.security.resetToken)}`;
  const expiry = (value) => new Date(value);

  return [
    {
      key: 'otp', label: 'Email verification / OTP',
      run: () => service.sendOtpEmail(recipient, fixtures.security.otp, `comm-test-${runId}-otp`),
    },
    {
      key: 'password-reset', label: 'Password reset',
      run: () => service.sendPasswordResetEmail(recipient, resetLink, `comm-test-${runId}-password-reset`),
    },
    {
      key: 'payment-received', label: 'Payment submitted',
      run: () => service.sendPaymentReceivedEmail({
        email: recipient,
        amount: payment.amount,
        currency: payment.currency,
        paymentType: payment.paymentType,
        reference: payment.reference,
      }),
    },
    {
      key: 'subscription-activated', label: 'Subscription activated',
      run: () => service.sendSubscriptionActivatedEmail({
        email: recipient,
        plan: subscription.plan,
        amount: subscription.amount,
        currency: subscription.currency,
        activatedDate: expiry(subscription.activatedDate),
        expiryDate: expiry(subscription.expiryDate),
      }),
    },
    {
      key: 'payment-rejected', label: 'Payment rejected',
      run: () => service.sendPaymentRejectedEmail({
        email: recipient,
        paymentType: payment.paymentType,
        amount: payment.amount,
        currency: payment.currency,
        reason: payment.rejectionReason,
      }),
    },
    {
      key: 'welcome', label: 'Welcome email',
      run: () => service.sendWelcomeEmail({
        email: recipient,
        fullName: fixtures.recipient.fullName,
      }, `comm-test-${runId}-welcome`),
    },
    {
      key: 'subscription-expiring', label: 'Subscription expiring',
      run: () => service.sendSubscriptionExpiringEmail({
        email: recipient,
        plan: subscription.plan,
        expiryDate: expiry(subscription.expiringDate),
        daysRemaining: subscription.daysRemaining,
      }),
    },
    {
      key: 'subscription-expired', label: 'Subscription expired',
      run: () => service.sendSubscriptionExpiredEmail({
        email: recipient,
        plan: subscription.plan,
        expiryDate: expiry(subscription.expiredDate),
      }),
    },
    {
      key: 'notification', label: 'General notification',
      run: () => service.sendNotificationEmail({
        email: recipient,
        title: notification.title,
        message: notification.message,
        actionUrl: notification.actionUrl,
        details: notification.details,
      }, `comm-test-${runId}-notification`),
    },
  ];
}

function getEmailService(previewMode, frontendUrl) {
  const { EmailService } = requireCompiledModule(
    ['notifications/email.service.js', 'src/notifications/email.service.js'],
    'Compiled EmailService',
  );
  const config = {
    get(key) {
      if (key === 'FRONTEND_URL') return frontendUrl;
      if (key === 'RESEND_API_KEY') return process.env.RESEND_API_KEY || '';
      return process.env[key];
    },
  };
  const service = new EmailService(config);
  const captured = [];
  if (previewMode) {
    Object.defineProperty(service, 'resend', {
      configurable: true,
      get() {
        return {
          emails: {
            async send(payload, options) {
              captured.push({ payload, options });
              return { data: { id: `preview-${captured.length}` }, error: null };
            },
          },
        };
      },
    });
  }
  return { service, captured };
}

async function runEmailTests(selection, send, fixtures, outputPath, frontendUrl, report) {
  const recipient = (process.env.COMMUNICATION_TEST_EMAIL || fixtures.recipient.email).trim();
  if (!recipient || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
    throw new Error('COMMUNICATION_TEST_EMAIL is not a valid email address.');
  }
  if (send && recipient.toLowerCase() !== 'grivitdev@gmail.com') {
    throw new Error('This harness is locked to the authorised test recipient grivitdev@gmail.com. Update the fixture only if the test recipient is intentionally changed.');
  }

  const { service, captured } = getEmailService(!send, frontendUrl);
  const runId = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const cases = buildEmailCases(service, fixtures, recipient, frontendUrl, runId);
  const selected = selectCases(cases, selection, 'email');
  const results = [];

  for (let index = 0; index < selected.length; index += 1) {
    const item = selected[index];
    try {
      const response = await item.run();
      if (send && response && response.error) {
        throw new Error(response.error.message || 'Resend returned an error.');
      }
      const payload = send
        ? response && response.data
          ? { subject: undefined, to: recipient, id: response.data.id }
          : { to: recipient }
        : captured[captured.length - 1].payload;

      if (!send) {
        const fileName = `${safeFileName(item.key)}.html`;
        fs.writeFileSync(path.join(outputPath, fileName), payload.html, 'utf8');
        results.push({ key: item.key, label: item.label, subject: payload.subject, fileName, status: 'PREVIEWED' });
        console.log(`PREVIEW  ${item.label} -> ${fileName}`);
      } else {
        results.push({ key: item.key, label: item.label, to: recipient, providerId: response?.data?.id || null, status: 'SENT' });
        console.log(`SENT     ${item.label} -> ${recipient}${response?.data?.id ? ` (Resend ID: ${response.data.id})` : ''}`);
      }
    } catch (error) {
      results.push({ key: item.key, label: item.label, status: 'FAILED', error: error.message || String(error) });
      console.error(`FAILED   ${item.label}: ${error.message || error}`);
    }
    if (index < selected.length - 1) await sleep(750);
  }

  if (!send) {
    fs.writeFileSync(path.join(outputPath, 'index.html'), htmlIndex(results), 'utf8');
  }
  report.email = { recipient, mode: send ? 'LIVE_SEND' : 'PREVIEW_ONLY', results };
  if (results.some((item) => item.status === 'FAILED')) report.hasFailures = true;
}

function selectCases(cases, selection, kind) {
  const normalized = String(selection || '').trim().toLowerCase();
  if (normalized === 'all') return cases;
  const found = cases.find((item) => item.key === normalized);
  if (!found) {
    throw new Error(`Unknown ${kind} test "${selection}". Use --help to list supported keys.`);
  }
  return [found];
}

function escapeTelegramHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function buildTelegramCases(fixtures, frontendUrl) {
  const item = fixtures.telegram;
  const predictionUrl = `${frontendUrl}/predictions?communication-test=1`;
  const homeUrl = `${frontendUrl}/?communication-test=1`;
  const pricingUrl = `${frontendUrl}/pricing?communication-test=1`;
  const bannerUrl = `${frontendUrl}/banner.png`;

  const dailyPickCaption = [
    '🧪 <b>COMMUNICATION TEST — NOT A LIVE TIP</b>',
    '⚽ <b>2XPREDICT</b>',
    '<b>DAILY PICK</b>',
    '━━━━━━━━━━━━━━━━━━',
    `🏆 ${escapeTelegramHtml(item.leagueName)}`,
    `<b>${escapeTelegramHtml(item.homeTeamName)} vs ${escapeTelegramHtml(item.awayTeamName)}</b>`,
    `🕒 ${escapeTelegramHtml(item.fixtureDate)}`,
    `• ${escapeTelegramHtml(item.marketName)}: <b>${escapeTelegramHtml(item.selectionName)}</b> · <b>${Number(item.odds).toFixed(2)}</b>`,
    `📊 Confidence: <b>${Math.round(Number(item.confidence))}%</b>`,
    '',
    '<i>Preview message only. This is synthetic test data, not a real prediction or betting recommendation.</i>',
  ].join('\n');

  const promotionText = [
    '🧪 <b>COMMUNICATION TEST — NOT A LIVE PROMOTION</b>',
    '🎁 <b>2XPREDICT</b>',
    `<b>${escapeTelegramHtml(item.promotionTitle)}</b>`,
    '━━━━━━━━━━━━━━━━━━',
    escapeTelegramHtml(item.promotionMessage),
    '',
    `📣 <a href="${escapeTelegramHtml(`${frontendUrl}/promos?communication-test=1`)}">View promotions</a>`,
    `🌐 <a href="${escapeTelegramHtml(homeUrl)}">Visit 2xPredict</a>`,
    '<i>Administrative test message. No offer or promo code is being activated.</i>',
  ].join('\n');

  const adCaption = [
    '🧪 <b>COMMUNICATION TEST — INTERNAL AD PREVIEW</b>',
    '📣 <b>2XPREDICT</b>',
    `<b>${escapeTelegramHtml(item.adTitle)}</b>`,
    '━━━━━━━━━━━━━━━━━━',
    escapeTelegramHtml(item.adMessage),
    '',
    '<i>Test advertisement only. No active campaign or paid offer is being announced.</i>',
  ].join('\n');

  return [
    {
      key: 'daily-pick',
      label: 'Daily Pick photo post',
      type: 'photo',
      photoUrl: bannerUrl,
      caption: dailyPickCaption,
      keyboard: [[
        { text: '⚽ View Prediction', url: predictionUrl },
        { text: '🌐 Explore 2xPredict', url: homeUrl },
      ]],
    },
    {
      key: 'promotion',
      label: 'Promotion text post',
      type: 'text',
      message: promotionText,
    },
    {
      key: 'internal-ad',
      label: 'Internal Ad photo post',
      type: 'photo',
      photoUrl: bannerUrl,
      caption: adCaption,
      keyboard: [[{ text: 'Explore VIP Plans', url: pricingUrl }]],
    },
  ];
}

function getTelegramService(frontendUrl, testChatId) {
  const { TelegramService } = requireCompiledModule(
    ['telegram/telegram.service.js', 'src/telegram/telegram.service.js'],
    'Compiled TelegramService',
  );
  const config = {
    get(key) {
      if (key === 'TELEGRAM_BOT_TOKEN') return process.env.TELEGRAM_BOT_TOKEN || '';
      // Redirect the existing production transport abstraction to the
      // isolated admin test group; the public INFO group is never selected.
      if (key === 'TELEGRAM_INFO_GROUP_ID') return testChatId;
      if (key === 'FRONTEND_URL') return frontendUrl;
      return process.env[key];
    },
  };
  return new TelegramService(config);
}

function resolveTelegramTestChat() {
  const adminId = String(process.env.TELEGRAM_ADMIN_GROUP_ID || '').trim();
  const publicInfoId = String(process.env.TELEGRAM_INFO_GROUP_ID || '').trim();
  const testChatId = String(
    process.env.COMMUNICATION_TEST_TELEGRAM_CHAT_ID || adminId,
  ).trim();

  if (!adminId) {
    throw new Error('TELEGRAM_ADMIN_GROUP_ID is required. The harness defaults to your existing admin group for test messages.');
  }
  if (!testChatId) throw new Error('No Telegram test destination is configured.');
  if (testChatId === publicInfoId) {
    throw new Error('Safety stop: the Telegram test destination matches TELEGRAM_INFO_GROUP_ID. The public info channel is blocked by this harness.');
  }
  if (!/^(-100\d+|-?\d+)$/.test(testChatId)) {
    throw new Error('Telegram test destination must be a numeric group/channel ID.');
  }
  return testChatId;
}

async function runTelegramTests(selection, send, fixtures, outputPath, frontendUrl, report) {
  const cases = buildTelegramCases(fixtures, frontendUrl);
  const selected = selectCases(cases, selection, 'Telegram');
  const target = send ? resolveTelegramTestChat() : null;
  const results = [];

  if (!send) {
    fs.writeFileSync(
      path.join(outputPath, 'telegram-preview.json'),
      JSON.stringify({ note: 'Preview only; no Telegram API request was made.', cases }, null, 2),
      'utf8',
    );
    for (const item of selected) {
      results.push({ key: item.key, label: item.label, status: 'PREVIEWED', type: item.type });
      console.log(`PREVIEW  ${item.label}`);
    }
  } else {
    if (!process.env.TELEGRAM_BOT_TOKEN?.trim()) {
      throw new Error('TELEGRAM_BOT_TOKEN is missing from the backend .env or process environment.');
    }
    console.log(`Telegram test destination: ${target} (admin/test group; public info group blocked).`);
    const telegram = getTelegramService(frontendUrl, target);

    for (let index = 0; index < selected.length; index += 1) {
      const item = selected[index];
      try {
        const response = item.type === 'photo'
          ? await telegram.sendPublicChannelPhoto(item.photoUrl, item.caption, item.keyboard)
          : await telegram.sendPublicChannelMessage(item.message);

        if (!response?.success) {
          const suffix = response?.deliveryUnknown
            ? ' Delivery outcome is UNKNOWN; check the admin group before attempting another send.'
            : '';
          throw new Error(`Telegram rejected the test message.${suffix}`);
        }
        results.push({ key: item.key, label: item.label, status: 'SENT', messageId: response.messageId || null, destination: target });
        console.log(`SENT     ${item.label} -> ${target}${response.messageId ? ` (message ID: ${response.messageId})` : ''}`);
      } catch (error) {
        results.push({ key: item.key, label: item.label, status: 'FAILED', error: error.message || String(error), destination: target });
        console.error(`FAILED   ${item.label}: ${error.message || error}`);
      }
      if (index < selected.length - 1) await sleep(1800);
    }
  }

  report.telegram = {
    destination: target || 'Not applicable — preview only',
    mode: send ? 'LIVE_SEND' : 'PREVIEW_ONLY',
    results,
  };
  if (results.some((item) => item.status === 'FAILED')) report.hasFailures = true;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function main() {
  loadEnvFile(path.join(BACKEND_ROOT, '.env'));
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return printHelp();
  if (args.send && String(process.env.COMMUNICATION_TEST_MODE || '').toLowerCase() !== 'true') {
    throw new Error('Live sending is disabled. Set COMMUNICATION_TEST_MODE=true in backend/.env after checking the test recipient and Telegram group IDs.');
  }
  if (!args.email && !args.telegram) {
    printHelp();
    throw new Error('Choose --email, --telegram, or both.');
  }

  const fixtures = readFixtures();
  const frontendUrl = getFrontendUrl();
  const outputPath = ensureOutput(path.resolve(BACKEND_ROOT, args.output));
  const report = {
    createdAt: new Date().toISOString(),
    mode: args.send ? 'LIVE_SEND' : 'PREVIEW_ONLY',
    frontendUrl,
    outputPath,
    hasFailures: false,
  };

  console.log(`\n2xPredict communications test — ${args.send ? 'LIVE SEND' : 'PREVIEW ONLY'}`);
  console.log(`Frontend: ${frontendUrl}`);
  console.log(`Output:   ${outputPath}`);
  console.log(args.send
    ? 'External services will be contacted. Only the configured test email/admin Telegram group are targeted.'
    : 'No external service will be contacted. Rendering local previews only.');

  if (args.email) {
    await runEmailTests(args.email, args.send, fixtures, outputPath, frontendUrl, report);
  }
  if (args.telegram) {
    await runTelegramTests(args.telegram, args.send, fixtures, outputPath, frontendUrl, report);
  }

  fs.writeFileSync(path.join(outputPath, 'communications-test-report.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(`\nReport saved: ${path.join(outputPath, 'communications-test-report.json')}`);
  if (!args.send && args.email) console.log(`Email previews: ${path.join(outputPath, 'index.html')}`);
  if (report.hasFailures) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`\nCommunications test stopped: ${error.message || error}`);
  process.exitCode = 1;
});
