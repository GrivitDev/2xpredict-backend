/**
 * Canonical public frontend destinations used by backend communications.
 * Keep these routes in sync with frontend/app/(public) route definitions.
 */
export const NotificationRoutes = {
  HOME: '/',
  PREDICTIONS: '/predictions',
  PROFILE: '/profile',
  PROFILE_PERSONAL: '/profile#personal-details',
  PROFILE_SECURITY: '/profile#security',
  PROFILE_BILLING: '/profile#account-billing',
  PROFILE_REWARDS: '/profile#rewards',
  PROFILE_REFERRALS: '/profile#referrals',
  PROFILE_WALLET: '/profile#wallet',
  BET_LAB: '/bet-lab',
  BET_LAB_TICKETS: '/bet-lab/tickets',
  CUSTOMER_CARE: '/customer-care',
  PROMOTIONS: '/promos',
  PRICING: '/pricing',
} as const;

export const COMMUNICATION_BANNER_PATH = '/banner.png';

const DEFAULT_FRONTEND_URL = 'https://www.2xpredict.com';

/**
 * Resolve the public website origin from FRONTEND_URL. Only HTTP(S) origins
 * are accepted; malformed configuration safely falls back to production.
 */
export function resolveFrontendBaseUrl(configuredUrl?: string | null): string {
  const candidate = String(configuredUrl ?? '').trim() || DEFAULT_FRONTEND_URL;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return DEFAULT_FRONTEND_URL;
    }
    return parsed.origin;
  } catch {
    return DEFAULT_FRONTEND_URL;
  }
}

/**
 * Build an absolute website URL from a validated local application path.
 * Prevents notification data from becoming an arbitrary external redirect.
 */
export function buildFrontendUrl(
  configuredBaseUrl: string | null | undefined,
  localPath: string,
): string {
  const path = String(localPath ?? '').trim();
  const safePath = path.startsWith('/') && !path.startsWith('//')
    ? path
    : NotificationRoutes.HOME;
  return new URL(safePath, `${resolveFrontendBaseUrl(configuredBaseUrl)}/`).toString();
}

export function customerCareConversationRoute(conversationId: string): string {
  return `${NotificationRoutes.CUSTOMER_CARE}/conversations/${encodeURIComponent(conversationId)}`;
}

export function betLabTicketRoute(ticketId: string): string {
  return `${NotificationRoutes.BET_LAB_TICKETS}/${encodeURIComponent(ticketId)}`;
}

export function promotionRoute(promoId: string): string {
  return `${NotificationRoutes.PROMOTIONS}?promoId=${encodeURIComponent(promoId)}`;
}


/**
 * Convert historical notification destinations to the current public route
 * structure. This is applied both when legacy notification records are read
 * and when older durable outbox events are delivered after an upgrade.
 */
export function normalizeNotificationActionUrl(value?: string | null): string | null {
  const raw = String(value ?? '').trim();
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || /[\\\r\n]/.test(raw)) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(raw, 'https://2xpredict-routing.invalid');
  } catch {
    return null;
  }

  const legacyRoutes: Record<string, string> = {
    '/payments': NotificationRoutes.PROFILE_BILLING,
    '/subscription': NotificationRoutes.PROFILE_BILLING,
    '/subscriptions': NotificationRoutes.PROFILE_BILLING,
    '/purchases': NotificationRoutes.PROFILE_BILLING,
    '/dashboard': NotificationRoutes.PROFILE,
    '/account': NotificationRoutes.PROFILE,
    '/account/security': NotificationRoutes.PROFILE_SECURITY,
    '/account/bonuses': NotificationRoutes.PROFILE_REWARDS,
    '/bonuses': NotificationRoutes.PROFILE_REWARDS,
    '/referrals': NotificationRoutes.PROFILE_REFERRALS,
    '/bet-lab/wallet': NotificationRoutes.PROFILE_WALLET,
    '/wallet': NotificationRoutes.PROFILE_WALLET,
    '/pick-center': NotificationRoutes.PREDICTIONS,
    '/slip-center': NotificationRoutes.PREDICTIONS,
    '/odds-center': '/matches',
  };

  if (parsed.pathname === NotificationRoutes.CUSTOMER_CARE) {
    const conversationId = parsed.searchParams.get('conversationId');
    if (conversationId) return customerCareConversationRoute(conversationId);
    return NotificationRoutes.CUSTOMER_CARE;
  }

  return legacyRoutes[parsed.pathname]
    ?? `${parsed.pathname}${parsed.search}${parsed.hash}`;
}
