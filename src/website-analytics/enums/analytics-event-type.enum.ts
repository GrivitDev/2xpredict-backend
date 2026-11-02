export enum AnalyticsEventType {
  // ==========================================
  // PAGE / NAVIGATION
  // ==========================================

  PAGE_VIEW = 'page_view',

  PAGE_EXIT = 'page_exit',

  SESSION_START = 'session_start',

  SESSION_END = 'session_end',

  HEARTBEAT = 'heartbeat',

  // ==========================================
  // USER INTERACTION
  // ==========================================

  CLICK = 'click',

  LINK_CLICK = 'link_click',

  BUTTON_CLICK = 'button_click',

  FORM_START = 'form_start',

  FORM_SUBMIT = 'form_submit',

  FORM_ERROR = 'form_error',

  INPUT_FOCUS = 'input_focus',

  SEARCH = 'search',

  FILTER = 'filter',

  TAB_CHANGE = 'tab_change',

  MODAL_OPEN = 'modal_open',

  MODAL_CLOSE = 'modal_close',

  DROPDOWN_OPEN = 'dropdown_open',

  // ==========================================
  // CONTENT
  // ==========================================

  SCROLL = 'scroll',

  CONTENT_VIEW = 'content_view',

  VIDEO_PLAY = 'video_play',

  VIDEO_COMPLETE = 'video_complete',

  // ==========================================
  // ACCOUNT
  // ==========================================

  LOGIN = 'login',

  LOGOUT = 'logout',

  REGISTRATION = 'registration',

  // ==========================================
  // BUSINESS
  // ==========================================

  PREDICTION_VIEW = 'prediction_view',

  SUBSCRIPTION_VIEW = 'subscription_view',

  SUBSCRIPTION_PURCHASE = 'subscription_purchase',

  PRICING_VIEW = 'pricing_view',

  PROMO_VIEW = 'promo_view',

  PROMO_CLAIM = 'promo_claim',

  REFERRAL_VIEW = 'referral_view',

  REFERRAL_SHARE = 'referral_share',

  COMMUNITY_VIEW = 'community_view',

  COMMUNITY_POST_CREATE = 'community_post_create',

  COMMUNITY_REPLY_CREATE = 'community_reply_create',

  // ==========================================
  // ADS
  // ==========================================

  AD_VIEW = 'ad_view',

  AD_CLICK = 'ad_click',

  // ==========================================
  // APPLICATION
  // ==========================================

  ERROR = 'error',

  CUSTOM = 'custom',
}

