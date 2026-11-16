import { NotificationCategory } from './enums/notification-category.enum';
import { NotificationType } from './enums/notification-type.enum';

/** Single approved image used by branded in-app communications. */
export const COMMUNICATION_BANNER_PATH = '/banner.png' as const;

export const NOTIFICATION_VARIANTS = [
  'default',
  'info',
  'success',
  'warning',
  'danger',
  'promotion',
] as const;

export const NOTIFICATION_ICONS = [
  'user',
  'shield',
  'users',
  'gift',
  'wallet',
  'ticket',
  'trophy',
  'headset',
  'megaphone',
  'bell',
] as const;

export type NotificationVariant = (typeof NOTIFICATION_VARIANTS)[number];
export type NotificationIcon = (typeof NOTIFICATION_ICONS)[number];

export interface NotificationPresentation {
  variant: NotificationVariant;
  icon: NotificationIcon;
  imageUrl: string | null;
  actionLabel: string | null;
}

export type NotificationPresentationInput = Partial<NotificationPresentation>;

/**
 * Makes user-facing event copy consistent without removing event-specific facts.
 * It deliberately does not invent punctuation, amounts, reasons or outcomes.
 */
export function normalizeNotificationCopy(
  title: unknown,
  message: unknown,
): { title: string; message: string } {
  return {
    title: toNotificationText(title).replace(/\s+/g, ' ').trim(),
    message: toNotificationText(message).replace(/\s+/g, ' ').trim(),
  };
}

function toNotificationText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  )
    return String(value);
  return '';
}

/**
 * Resolves every notification to the same presentation contract. Older stored
 * records and queued events are given the same defaults at read/dispatch time.
 */
export function resolveNotificationPresentation(
  type: NotificationType,
  category: NotificationCategory,
  actionUrl?: string | null,
  supplied?: NotificationPresentationInput | null,
): NotificationPresentation {
  const hasAction = isLocalPath(actionUrl);
  const suppliedVariant = supplied?.variant;
  const suppliedIcon = supplied?.icon;
  const suppliedActionLabel = cleanActionLabel(supplied?.actionLabel);

  const imageUrl =
    supplied?.imageUrl === null
      ? null
      : supplied?.imageUrl === COMMUNICATION_BANNER_PATH
        ? COMMUNICATION_BANNER_PATH
        : category === NotificationCategory.PROMOTIONS
          ? COMMUNICATION_BANNER_PATH
          : null;

  return {
    variant: isNotificationVariant(suppliedVariant)
      ? suppliedVariant
      : defaultVariant(type, category),
    icon: isNotificationIcon(suppliedIcon)
      ? suppliedIcon
      : defaultIcon(type, category),
    imageUrl,
    actionLabel: hasAction
      ? (suppliedActionLabel ?? defaultActionLabel(actionUrl))
      : null,
  };
}

function defaultVariant(
  type: NotificationType,
  category: NotificationCategory,
): NotificationVariant {
  if (category === NotificationCategory.PROMOTIONS) return 'promotion';

  if (
    type === NotificationType.ACCOUNT_SUSPENDED ||
    type === NotificationType.PAYMENT_REJECTED
  )
    return 'danger';

  if (
    type === NotificationType.ACCOUNT_SECURITY_ALERT ||
    type === NotificationType.BONUS_EXPIRED ||
    type === NotificationType.SUBSCRIPTION_EXPIRING ||
    type === NotificationType.SUBSCRIPTION_EXPIRED ||
    type === NotificationType.BET_LAB_TICKET_LOST ||
    type === NotificationType.BET_LAB_TICKET_PARTIALLY_LOST ||
    type === NotificationType.WALLET_ALLOWANCE_EXPIRED
  )
    return 'warning';

  if (
    type === NotificationType.ACCOUNT_WELCOME ||
    type === NotificationType.ACCOUNT_EMAIL_VERIFIED ||
    type === NotificationType.ACCOUNT_RESTORED ||
    type === NotificationType.REFERRAL_REWARD_RECEIVED ||
    type === NotificationType.BONUS_POINTS_GRANTED ||
    type === NotificationType.BONUS_SUBSCRIPTION_GRANTED ||
    type === NotificationType.PAYMENT_SUCCESSFUL ||
    type === NotificationType.SUBSCRIPTION_ACTIVATED ||
    type === NotificationType.SUBSCRIPTION_RENEWED ||
    type === NotificationType.SUBSCRIPTION_UPGRADED ||
    type === NotificationType.BET_LAB_TICKET_WON ||
    type === NotificationType.BET_LAB_TICKET_PARTIALLY_WON ||
    type === NotificationType.WALLET_CREDITED ||
    type === NotificationType.PROMOTION_REWARD_UNLOCKED ||
    type === NotificationType.PROMOTION_REWARD_GRANTED ||
    type === NotificationType.PROMOTION_COMPLETED ||
    type === NotificationType.SUPPORT_TICKET_RESOLVED
  )
    return 'success';

  return 'info';
}

function defaultIcon(
  type: NotificationType,
  category: NotificationCategory,
): NotificationIcon {
  if (
    type === NotificationType.ACCOUNT_SECURITY_ALERT ||
    type === NotificationType.ACCOUNT_PASSWORD_CHANGED ||
    type === NotificationType.ACCOUNT_EMAIL_CHANGED ||
    type === NotificationType.ACCOUNT_SUSPENDED
  )
    return 'shield';

  switch (category) {
    case NotificationCategory.ACCOUNT:
      return 'user';
    case NotificationCategory.REFERRALS:
      return 'users';
    case NotificationCategory.BONUSES:
      return 'gift';
    case NotificationCategory.PAYMENTS:
    case NotificationCategory.SUBSCRIPTIONS:
    case NotificationCategory.WALLET:
      return 'wallet';
    case NotificationCategory.BET_LAB:
      return type === NotificationType.BET_LAB_TICKET_WON ||
        type === NotificationType.BET_LAB_TICKET_PARTIALLY_WON
        ? 'trophy'
        : 'ticket';
    case NotificationCategory.PROMOTIONS:
      return 'gift';
    case NotificationCategory.CUSTOMER_CARE:
      return 'headset';
    case NotificationCategory.SYSTEM:
    default:
      return type === NotificationType.SYSTEM_ANNOUNCEMENT
        ? 'megaphone'
        : 'bell';
  }
}

function defaultActionLabel(actionUrl: string): string {
  const path = actionUrl.toLowerCase();
  if (path.startsWith('/profile#account-billing')) return 'View billing';
  if (path.startsWith('/profile#security')) return 'Review security';
  if (path.startsWith('/profile#rewards')) return 'View rewards';
  if (path.startsWith('/profile#wallet')) return 'View wallet';
  if (path.startsWith('/profile#referrals')) return 'View referrals';
  if (path.startsWith('/profile#personal-details') || path === '/profile')
    return 'View profile';
  if (path.startsWith('/promos')) return 'View promotion';
  if (path.startsWith('/customer-care')) return 'Open conversation';
  if (path.startsWith('/bet-lab/tickets/')) return 'View ticket';
  if (path.startsWith('/bet-lab')) return 'Open Bet Lab';
  if (path.startsWith('/predictions')) return 'View predictions';
  return 'View details';
}

function cleanActionLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const label = value
    .replace(/\p{Cc}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  return label && label.length <= 36 ? label : null;
}

function isLocalPath(value?: string | null): value is string {
  return Boolean(
    value &&
    value.startsWith('/') &&
    !value.startsWith('//') &&
    value.length <= 300,
  );
}

function isNotificationVariant(value: unknown): value is NotificationVariant {
  return (
    typeof value === 'string' &&
    (NOTIFICATION_VARIANTS as readonly string[]).includes(value)
  );
}

function isNotificationIcon(value: unknown): value is NotificationIcon {
  return (
    typeof value === 'string' &&
    (NOTIFICATION_ICONS as readonly string[]).includes(value)
  );
}
