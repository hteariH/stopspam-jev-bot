// Settings. The Python bot read these from .env with these defaults; the
// platform has no environment, so the defaults are the values.

export const TYPESAFE_BASE_URL = 'https://api.typesafe.ai';
export const JEV_MODEL = 'jev-latest';
export const JEV_TIMEOUT = 2.0;

// Defaults for a freshly added chat. Admins can change these per chat.
export const DEFAULT_DELETE_THRESHOLD = 0.90;
export const DEFAULT_REVIEW_THRESHOLD = 0.55;
export const DEFAULT_CONFIDENCE_FLOOR = 0.75;
export const DEFAULT_TRUST_AFTER = 5;

export const OBSERVE_DAYS = 7;
export const REVIEW_TTL_DAYS = 7;
export const RECHECK_AFTER_DAYS = 30;
export const ENFORCEMENT_PER_MINUTE = 10;

// Billing. Tier is a function of the group's Telegram member count; the API
// cost is not an input to the price (see the monetization design), so these
// are product decisions, not derived numbers.
export const FREE_MEMBER_LIMIT = 200;
export const SMALL_MEMBER_LIMIT = 1000;
export const PRICE_SMALL_STARS = 50;
export const PRICE_LARGE_STARS = 250;

// The free trial of enforcement, and how long before it ends we say so.
export const GRACE_DAYS = 14;
export const GRACE_WARN_DAYS = 3;

// getChatMemberCount is an API call, so the answer is cached this long.
export const MEMBER_COUNT_TTL_HOURS = 24;

// Not tunable: createInvoiceLink rejects every other value today.
export const SUBSCRIPTION_PERIOD = 2592000;
