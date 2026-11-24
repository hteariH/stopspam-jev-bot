// The Mini App's side of the settings: who is calling, what they may change,
// and the JSON shape of a chat. Nothing here calls Telegram; app_chat.js does.
//
// Every endpoint under endpoints/app_* starts with requireUser. ops endpoints
// start with requireOps, which refuses init data, so each endpoint can be
// reached from exactly one side: the CLI or the Mini App.
import { EndpointError } from 'sdk';

import * as config from './config.js';
import * as tiers from './core/tiers.js';
import * as chats from './storage/chats.js';
import { now, stamp } from './clock.js';
import { LANGS } from './texts.js';

export const STEP = 0.05;
export const MAX_TRUST_AFTER = 50;
const THRESHOLDS = new Set(['delete_threshold', 'review_threshold', 'confidence_floor']);

export function fail(code, description = code) {
  throw new EndpointError(description, { code });
}

// The platform verified ctx.initData before the endpoint ran; a call
// without it came from the CLI, which only ops endpoints serve.
export function requireUser(ctx) {
  const id = ctx && ctx.initData && ctx.initData.user && ctx.initData.user.id;
  if (!Number.isSafeInteger(id) || id <= 0) fail('FORBIDDEN');
  return id;
}

// Groups and supergroups have negative ids; anything else is not a chat
// this bot moderates.
export function chatIdOf(input) {
  const id = input && input.chat_id;
  if (!Number.isSafeInteger(id) || id >= 0) fail('INVALID', 'chat_id');
  return id;
}

function onGrid(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) return null;
  const steps = value / STEP;
  if (Math.abs(steps - Math.round(steps)) > 1e-6) return null;
  return Math.round(Math.round(steps) * STEP * 10000) / 10000;
}

// The stored fields a request asks for, or INVALID. Nothing partial: one bad
// field refuses the whole request, and so does a result where review would
// fire above delete.
export function changes(chat, fields, userId) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) fail('INVALID', 'fields');
  const out = {};
  for (const [name, value] of Object.entries(fields)) {
    if (name === 'mode') {
      if (value !== 'active' && value !== 'observe') fail('INVALID', name);
      out.mode = value;
    } else if (name === 'end_observe') {
      // The old menu's "Seen enough - start deleting".
      if (value !== true) fail('INVALID', name);
      out.mode = 'active';
      out.observe_until = stamp();
    } else if (name === 'jev_enabled') {
      if (typeof value !== 'boolean') fail('INVALID', name);
      out.jev_enabled = value;
    } else if (THRESHOLDS.has(name)) {
      const v = onGrid(value);
      if (v === null) fail('INVALID', name);
      out[name] = v;
    } else if (name === 'trust_after') {
      if (!Number.isInteger(value) || value < 0 || value > MAX_TRUST_AFTER) fail('INVALID', name);
      out.trust_after = value;
    } else if (name === 'lang') {
      if (!LANGS.includes(value)) fail('INVALID', name);
      out.lang = value;
    } else if (name === 'log_to_me') {
      // The caller's admin rights were checked by loadChat; they can only
      // point the cards at themselves, never at an arbitrary id.
      if (value !== true) fail('INVALID', name);
      out.log_chat_id = userId;
    } else {
      fail('INVALID', name);
    }
  }
  if (!Object.keys(out).length) fail('INVALID', 'fields');
  const merged = { ...chat, ...out };
  if (merged.review_threshold > merged.delete_threshold) fail('INVALID', 'review_above_delete');
  return out;
}

// The whole price list, so the app can show every tier and not only the
// one this group is on.
export function priceList() {
  return [
    { tier: tiers.FREE, up_to: config.FREE_MEMBER_LIMIT, stars: null },
    { tier: tiers.SMALL, up_to: config.SMALL_MEMBER_LIMIT, stars: tiers.priceFor(tiers.SMALL) },
    { tier: tiers.LARGE, up_to: null, stars: tiers.priceFor(tiers.LARGE) },
  ];
}

export function planView(row, at = now()) {
  const members = row.member_count || 0;
  const tier = tiers.tierFor(row.member_count);
  const base = { members, limit: config.FREE_MEMBER_LIMIT, tier, tiers: priceList(), grace_days: config.GRACE_DAYS };
  if (tier === tiers.FREE) return { kind: 'free', days: null, ...base, offer_stars: null };
  const ent = tiers.build(tier, { paidUntil: row.paid_until, graceUntil: row.grace_until, now: at });
  // The same condition the old menu used to show the subscribe button.
  const offer = ent.price && ent.reason !== 'subscribed' ? ent.price : null;
  if (ent.reason === 'subscribed') {
    return { kind: 'subscribed', days: tiers.daysLeft(row.paid_until, { now: at }), ...base, offer_stars: null };
  }
  if (ent.reason === 'grace') {
    return { kind: 'grace', days: tiers.daysLeft(row.grace_until, { now: at }), ...base, offer_stars: offer };
  }
  return { kind: 'none', days: null, ...base, offer_stars: offer };
}

// User ids are positive and chat ids negative, which is what tells a DM
// from a moderator group.
export function cardsView(chat, userId) {
  const id = chat.log_chat_id;
  if (id === null || id === undefined || id === chat.chat_id) return { kind: 'unset', id: null };
  if (id === userId) return { kind: 'me', id };
  return { kind: id > 0 ? 'dm' : 'group', id };
}

function observeDaysLeft(chat) {
  return tiers.daysLeft(chat.observe_until, { now: now() });
}

export function chatView(chat, row, userId, subscribeUrl = null) {
  const plan = planView(row);
  return {
    chat_id: chat.chat_id,
    title: chat.title || String(chat.chat_id),
    mode: chat.mode,
    observing: chats.isObserving(chat),
    observe_days_left: observeDaysLeft(chat),
    jev_enabled: chat.jev_enabled,
    delete_threshold: chat.delete_threshold,
    review_threshold: chat.review_threshold,
    confidence_floor: chat.confidence_floor,
    trust_after: chat.trust_after,
    lang: chat.lang,
    cards: cardsView(chat, userId),
    plan,
    subscribe_url: plan.offer_stars ? subscribeUrl : null,
    subscribe_stars: plan.offer_stars,
  };
}

export function summaryView(chat, row) {
  return {
    chat_id: chat.chat_id,
    title: chat.title || String(chat.chat_id),
    mode: chat.mode,
    observing: chats.isObserving(chat),
    observe_days_left: observeDaysLeft(chat),
    plan: planView(row).kind,
  };
}
