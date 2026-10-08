// The database. The first six tables are the Python bot's schema column for
// column, so the VPS database can be imported row for row. Every time column
// is ISO text ("2026-01-01T00:00:00+00:00", see lib/clock.js) because the SQL
// compares them as strings.
import { table, integer, text, real, index, primaryKey } from 'sdk/db';

export const chats = table('chats', {
  chat_id: integer('chat_id').primaryKey(),
  title: text('title'),
  mode: text('mode').notNull().default('observe'),
  delete_threshold: real('delete_threshold').notNull().default(0.90),
  review_threshold: real('review_threshold').notNull().default(0.55),
  confidence_floor: real('confidence_floor').notNull().default(0.75),
  trust_after: integer('trust_after').notNull().default(5),
  log_chat_id: integer('log_chat_id'),
  lang: text('lang').notNull().default('en'),
  jev_enabled: integer('jev_enabled').notNull().default(1),
  observe_until: text('observe_until'),
  created_at: text('created_at').notNull(),
});

// The primary key is (chat_id, user_id), so "which chats has this user been
// seen in" - the candidate set behind /chats - needs idx_trust_user to avoid
// scanning every member of every group the bot is in.
export const trust = table('trust', {
  chat_id: integer('chat_id').notNull(),
  user_id: integer('user_id').notNull(),
  clean_count: integer('clean_count').notNull().default(0),
  status: text('status').notNull().default('unknown'),
  joined_at: text('joined_at'),
  last_checked_at: text('last_checked_at'),
  last_seen_at: text('last_seen_at'),
}, (t) => ({
  pk: primaryKey({ columns: [t.chat_id, t.user_id] }),
  byUser: index('idx_trust_user').on(t.user_id),
}));

export const reviews = table('reviews', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chat_id: integer('chat_id').notNull(),
  message_id: integer('message_id').notNull(),
  user_id: integer('user_id').notNull(),
  text: text('text'),
  verdict_json: text('verdict_json').notNull(),
  risk: real('risk').notNull(),
  decision: text('decision'),
  decided_by: integer('decided_by'),
  decided_at: text('decided_at'),
  created_at: text('created_at').notNull(),
  expires_at: text('expires_at').notNull(),
}, (t) => ({
  byChat: index('idx_reviews_chat').on(t.chat_id, t.decided_at),
  // The 7-day erasure runs on every update (lib/dispatch.js), so finding
  // the expired rows must not scan the table.
  byExpiry: index('idx_reviews_expires').on(t.expires_at),
}));

export const audit = table('audit', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chat_id: integer('chat_id').notNull(),
  user_id: integer('user_id').notNull(),
  message_id: integer('message_id'),
  risk: real('risk'),
  action: text('action').notNull(),
  reason: text('reason').notNull(),
  model: text('model'),
  created_at: text('created_at').notNull(),
}, (t) => ({
  byChat: index('idx_audit_chat').on(t.chat_id, t.created_at),
}));

// Billing state per chat. Separate from `chats` so the moderation config and
// the money stay independently readable.
export const billing = table('billing', {
  chat_id: integer('chat_id').primaryKey(),
  member_count: integer('member_count'),
  member_count_at: text('member_count_at'),
  grace_until: text('grace_until'),
  paid_until: text('paid_until'),
  payer_user_id: integer('payer_user_id'),
  stars: integer('stars'),
  charge_id: text('charge_id'),
  notified_stage: text('notified_stage'),
  updated_at: text('updated_at').notNull(),
});

// Append-only. Telegram sends no "payment revoked" update, so this is the
// only record that will exist when a charge is disputed or when
// refundStarPayment has to be called by hand. The charge id is the primary
// key because that is what makes a redelivered update harmless.
export const payments = table('payments', {
  telegram_payment_charge_id: text('telegram_payment_charge_id').primaryKey(),
  chat_id: integer('chat_id').notNull(),
  payer_user_id: integer('payer_user_id').notNull(),
  stars: integer('stars').notNull(),
  is_recurring: integer('is_recurring').notNull().default(0),
  expires_at: text('expires_at'),
  created_at: text('created_at').notNull(),
}, (t) => ({
  byChat: index('idx_payments_chat').on(t.chat_id, t.created_at),
}));

// What the Python bot read from its environment and nothing else can hold:
// the TypeSafe API key, written with endpoints/ops_set_secret, and the
// bot's own getMe, cached.
export const settings = table('settings', {
  name: text('name').primaryKey(),
  value: text('value').notNull(),
});

// The rate limiters' sliding windows. An isolate keeps no memory between
// updates, so the deques the Python kept in process live here.
export const rate_events = table('rate_events', {
  scope: text('scope').notNull(),
  key: integer('key').notNull(),
  at_ms: integer('at_ms').notNull(),
}, (t) => ({
  byKey: index('idx_rate_events_key').on(t.scope, t.key, t.at_ms),
}));
