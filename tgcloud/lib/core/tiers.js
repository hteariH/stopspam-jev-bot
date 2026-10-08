// Which tier a chat is in, and whether it may delete.
//
// Pure: no network, no database, and the clock is a parameter. That is what
// lets the two boundaries (200, 1000) and the grace window be tested
// exhaustively rather than through a mock of Telegram.
import * as config from '../config.js';
import { parse } from '../clock.js';

export const FREE = 'free';
export const SMALL = 'small';
export const LARGE = 'large';

// What a chat is allowed to do about spam, and why. `active` is the only
// field the policy sees; the rest exist so the log line, the menu and the
// review card can explain themselves.
export function Entitlement({ tier, active, reason, price }) {
  return Object.freeze({ tier, active, reason, price });
}

// An unknown count reads as the free tier, deliberately. A chat whose count
// has never been fetched is brand new, which means it is inside its 7-day
// observation window and deleting nothing regardless; and if the lookup is
// failing for some other reason, a billing problem must not be what stops a
// group from being moderated.
export function tierFor(memberCount) {
  if (memberCount === null || memberCount === undefined || memberCount <= config.FREE_MEMBER_LIMIT) {
    return FREE;
  }
  if (memberCount <= config.SMALL_MEMBER_LIMIT) return SMALL;
  return LARGE;
}

// Stars per 30 days. Zero means there is nothing to sell.
export function priceFor(tier) {
  return {
    [FREE]: 0,
    [SMALL]: config.PRICE_SMALL_STARS,
    [LARGE]: config.PRICE_LARGE_STARS,
  }[tier] ?? 0;
}

// May this chat have spam deleted automatically, and on what grounds?
//
// The reason string reaches the audit row and the review card, so the order
// here is the order an admin is told about: being on the free tier beats
// having paid, and having paid beats being in the trial. A malformed stamp
// reads as absent rather than crashing the moderation path.
export function entitled(tier, { paidUntil, graceUntil, now }) {
  if (tier === FREE) return [true, 'free_tier'];
  const expiry = parse(paidUntil);
  if (expiry !== null && expiry > now) return [true, 'subscribed'];
  const grace = parse(graceUntil);
  if (grace !== null && grace > now) return [true, 'grace'];
  return [false, 'not_entitled'];
}

export function build(tier, { paidUntil, graceUntil, now }) {
  const [active, reason] = entitled(tier, { paidUntil, graceUntil, now });
  return Entitlement({ tier, active, reason, price: priceFor(tier) });
}

// True when the cached member count is old enough to refetch. Never fetched,
// or fetched at a time we can no longer read, both count as stale.
export function countIsStale(memberCountAt, { now }) {
  const fetched = parse(memberCountAt);
  if (fetched === null) return true;
  return now - fetched >= config.MEMBER_COUNT_TTL_HOURS * 3600 * 1000;
}

// Whole days remaining, rounded up, never negative. Rounded up because
// "1 day left" is the honest thing to tell someone with eleven hours.
export function daysLeft(value, { now }) {
  const when = parse(value);
  if (when === null || when <= now) return 0;
  return Math.ceil((when - now) / 1000 / 86400);
}
