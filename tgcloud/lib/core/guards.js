// Shared safety primitives.
//
// Both things here are exactly the kind of code that must not drift:
//
// - isAdmin is the security primitive the whole product rests on. The spec
//   makes "administrators and group owners are never acted upon" a
//   hard-coded, unconfigurable guard, so one copy of this check going wrong
//   is a wrong deletion in somebody else's group.
// - bestEffort is the contract that a decision already made still reaches
//   Telegram when the database fails.
import { logger } from '../log.js';

const log = logger('stopspam.guards');

const ADMIN_STATUSES = new Set(['administrator', 'creator']);

// The three honest answers to "does this user administer this chat?"
//
// UNKNOWN exists because Telegram can simply fail to answer, and the two
// kinds of caller want opposite things from that failure. A caller deciding
// whether to *act on* a user must not read a failed lookup as "ordinary
// member"; a caller deciding whether to *grant* someone control must not
// read it as "administrator".
export const AdminCheck = Object.freeze({
  ADMIN: 'admin',
  NOT_ADMIN: 'not_admin',
  UNKNOWN: 'unknown',
});

// A bug, as opposed to a failure of the outside world. The Python code
// caught sqlite3.Error and TelegramAPIError by type; the platform's error
// types are not all documented, so the JS catches everything that is not
// one of these and lets these propagate, which keeps a typo from being
// logged as "storage unavailable" forever.
export function isProgrammingError(exc) {
  return exc instanceof TypeError
    || exc instanceof ReferenceError
    || exc instanceof SyntaxError
    || exc instanceof RangeError;
}

// Runs a storage call without letting a DB failure escape the caller.
//
// Returns the call's result, or null if it failed. Losing one row here - a
// trust bump, an audit line, a resolved decision - is the accepted trade
// against dropping a message from moderation entirely or leaving a button
// press unanswered. The warning is what keeps a persistent storage problem
// from going unnoticed.
export async function bestEffort(callerLog, what, chatId, fn, ...args) {
  try {
    return await fn(...args);
  } catch (exc) {
    if (isProgrammingError(exc)) throw exc;
    callerLog.warning('storage call failed (%s) for chat %s: %s', what, chatId, exc);
    return null;
  }
}

// Asks Telegram whether the user administers or owns the chat, right now.
//
// Never reads a cached value: a stale row in our own database must not be
// enough to grant control over a group's moderation. A Telegram failure
// returns UNKNOWN rather than a guess.
export async function adminCheck(bot, chatId, userId) {
  let member;
  try {
    member = await bot.getChatMember(chatId, userId);
  } catch (exc) {
    if (isProgrammingError(exc)) throw exc;
    log.warning('admin lookup failed for user %s in chat %s: %s', userId, chatId, exc);
    return AdminCheck.UNKNOWN;
  }
  return ADMIN_STATUSES.has(member && member.status) ? AdminCheck.ADMIN : AdminCheck.NOT_ADMIN;
}

// True only when Telegram positively confirms the user is an admin.
//
// Use this where false *denies* something - a settings menu, a review-card
// button - so that a failed lookup fails closed. Do NOT use it to decide
// whether a user may be acted upon: call adminCheck() and handle UNKNOWN.
export async function isAdmin(bot, chatId, userId) {
  return (await adminCheck(bot, chatId, userId)) === AdminCheck.ADMIN;
}
