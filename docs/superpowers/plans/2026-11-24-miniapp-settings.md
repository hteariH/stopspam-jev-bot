# Chat settings Mini App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the inline `/chats` settings menu with a Mini App (Vite + Preact) hosted by Telegram Serverless, backed by three `app_*` endpoints.

**Architecture:** Endpoints in `tgcloud/endpoints/app_*.js` authorize by `ctx.initData.user.id` and re-check admin rights against Telegram on every call. Validation and the JSON view of a chat live in `tgcloud/lib/app.js` (pure), loading/rendering in `tgcloud/lib/app_chat.js`. The front-end in `app/` builds into `dist/`, which `tgcloud push` deploys next to the modules. `/chats` becomes a single `web_app` button.

**Tech Stack:** Telegram Serverless (`@tgcloud/cli` 0.2.0), JS ES modules, `node:test`, Vite 8.3.8, Preact 10.29.8, `@preact/preset-vite` 2.10.6.

**Spec:** `docs/superpowers/specs/2026-11-23-miniapp-settings-design.md`

## Global Constraints

- Work on branch `miniapp`; nothing reaches `master` before Task 7 (a push to `master` deploys).
- Modules under `tgcloud/` import only `sdk`, `sdk/db`, `sdk/api`, `sdk/fetch` and relative `.js` paths; no `process`, `Buffer`, `fs` (checked by `test/platform_rules.test.js`).
- App URL: `https://app8792794574.tgcloud.ai/` (exported as `APP_URL` from `tgcloud/lib/config.js`).
- Error codes thrown to the Mini App: `NOT_ADMIN`, `RATE_LIMITED`, `INVALID`, `NOT_FOUND`, plus `FORBIDDEN` from the guard. Always `new EndpointError(description, { code })`.
- Thresholds: number in [0, 1], multiple of 0.05. `trust_after`: integer in [0, 50]. Resulting `review_threshold <= delete_threshold` or nothing is written.
- `log_chat_id` is never accepted from the client; only `log_to_me: true`.
- `app_chat` / `app_update`: per-user limiter `new RateLimiter('app', 30)`. `app_chats`: the existing `chats` limiter (`CHATS_PER_MINUTE = 3`) and `MAX_MENU_CHATS = 20`.
- Admin check before any storage read of the chat.
- No schema change. Run all tests with `npm test`.
- On Windows run `npx tgcloud run …` through Bash (PowerShell mangles quotes).

## File map

| File | Responsibility |
|---|---|
| `tgcloud/lib/core/admins.js` (new) | `adminChats`, `chatsLimiter`, `MAX_MENU_CHATS`, `CHATS_PER_MINUTE` (moved from `handlers/admin.js`) |
| `tgcloud/lib/app.js` (new) | `requireUser`, `fail`, `chatIdOf`, `changes`, `planView`, `cardsView`, `chatView`, `summaryView` — no Bot API calls |
| `tgcloud/lib/app_chat.js` (new) | `appLimiter`, `spend`, `loadChat`, `render` — admin check, storage, invoice link |
| `tgcloud/endpoints/app_chats.js`, `app_chat.js`, `app_update.js` (new) | the three endpoints |
| `tgcloud/lib/handlers/admin.js` | loses the menu; `/chats` sends the button; `onMovedMenu` |
| `tgcloud/lib/dispatch.js` | `cfg:` → `admin.onMovedMenu` |
| `tgcloud/lib/texts.js` | drops menu-only strings, adds `chats_open`, `btn_open_settings`, `menu_moved` |
| `tgcloud/lib/config.js` | `APP_URL` |
| `tgcloud/endpoints/ops_set_commands.js` | also sets the menu button |
| `app/index.html`, `app/src/*` (new) | front-end |
| `vite.config.js`, `package.json`, `tgcloud.jsonc`, `.gitignore` | build and hosting |
| `.github/workflows/deploy.yml` | build before push |
| `test/admins.test.js`, `test/app.test.js`, `test/app_endpoints.test.js`, `test/app_ui.test.js` (new) | tests |
| `test/admin_handler.test.js`, `test/ops.test.js`, `test/cards.test.js` | updated |

---

### Task 0: Branch

- [ ] **Step 1:** `git checkout -b miniapp` (from an up-to-date `master`), then `npm test` — expected: all tests pass (463 at time of writing).

---

### Task 1: Move the admin-chat lookup into `lib/core/admins.js`

Pure refactor: `/chats` and the future `app_chats` must share one implementation.

**Files:**
- Create: `tgcloud/lib/core/admins.js`
- Modify: `tgcloud/lib/handlers/admin.js` (lines with `MAX_MENU_CHATS`, `CHATS_PER_MINUTE`, `chatsLimiter`, `adminChats`)
- Test: `test/admins.test.js`

**Interfaces:**
- Produces: `adminChats(bot, userId) -> Promise<ChatConfig[]>` (frozen rows from `chats.getChat`), `chatsLimiter: RateLimiter`, `MAX_MENU_CHATS = 20`, `CHATS_PER_MINUTE = 3`.

- [ ] **Step 1: Write the failing test** — `test/admins.test.js`:

```js
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { fresh, respond } from './helpers.js';
import { bot, calls } from './telegram.js';
import { adminChats, MAX_MENU_CHATS } from '../tgcloud/lib/core/admins.js';
import * as chats from '../tgcloud/lib/storage/chats.js';
import * as trust from '../tgcloud/lib/storage/trust.js';

const ADMIN = 777;
const STRANGER = 888;

beforeEach(() => {
  fresh();
  respond('getChatMember', (p) => ({ status: p.user_id === ADMIN ? 'administrator' : 'member' }));
});

test('only chats Telegram confirms the user administers are returned', async () => {
  await chats.ensureChat(-1, 'Mine');
  await chats.ensureChat(-2, 'Not mine');
  await trust.seen(-1, ADMIN);
  await trust.seen(-2, ADMIN);
  respond('getChatMember', (p) => ({ status: p.chat_id === -1 && p.user_id === ADMIN ? 'creator' : 'member' }));
  assert.deepEqual((await adminChats(bot(), ADMIN)).map((c) => c.title), ['Mine']);
});

test('a stranger costs no Telegram lookups', async () => {
  for (let i = 0; i < 5; i++) await chats.ensureChat(-200 - i, `Group ${i}`);
  assert.deepEqual(await adminChats(bot(), STRANGER), []);
  assert.deepEqual(calls('getChatMember'), []);
});

test('the candidate set is capped however many chats match', async () => {
  for (let i = 0; i < MAX_MENU_CHATS + 10; i++) {
    await chats.ensureChat(-300 - i, `Group ${i}`);
    await trust.seen(-300 - i, ADMIN);
  }
  await adminChats(bot(), ADMIN);
  assert.ok(calls('getChatMember').length <= MAX_MENU_CHATS);
});
```

- [ ] **Step 2: Run it** — `npm test` — expected: FAIL, `Cannot find module …/tgcloud/lib/core/admins.js`.

- [ ] **Step 3: Create `tgcloud/lib/core/admins.js`**

```js
// Which chats a user administers, and the budget for asking.
//
// Shared by every caller that lists "your chats", so the bound on Telegram
// lookups (MAX_MENU_CHATS candidates, CHATS_PER_MINUTE per user) is one
// piece of code, not one per screen.
import * as guards from './guards.js';
import { RateLimiter } from './ratelimit.js';
import * as chats from '../storage/chats.js';
import { logger } from '../log.js';

const log = logger('stopspam.admins');

// Hard cap on how many chats one listing can look up, which bounds what a
// stranger can make the bot spend in one request...
export const MAX_MENU_CHATS = 20;
// ...and a per-user limit on how often they can spend it at all.
export const CHATS_PER_MINUTE = 3;
export const chatsLimiter = new RateLimiter('chats', CHATS_PER_MINUTE);

const bestEffort = (...args) => guards.bestEffort(log, ...args);

// Chats the caller administers, re-verified against Telegram, not cached.
// The candidate set is narrowed in storage first, so the number of
// getChatMember calls is bounded by MAX_MENU_CHATS.
export async function adminChats(bot, userId) {
  const candidates = (await bestEffort('candidate_chats', userId, chats.candidateChatIds,
    userId, MAX_MENU_CHATS)) || [];
  const result = [];
  for (const chatId of candidates) {
    if (await guards.isAdmin(bot, chatId, userId)) {
      const chat = await bestEffort('get_chat', chatId, chats.getChat, chatId);
      if (chat !== null) result.push(chat);
    }
  }
  return result;
}
```

- [ ] **Step 4: Use it from `handlers/admin.js`.** Delete the local `MAX_MENU_CHATS`, `CHATS_PER_MINUTE`, `chatsLimiter` declarations, the `RateLimiter` import and the local `adminChats` function, and add:

```js
import { adminChats, chatsLimiter } from '../core/admins.js';
export { MAX_MENU_CHATS, CHATS_PER_MINUTE } from '../core/admins.js';
```

(the re-export keeps `test/admin_handler.test.js` compiling until Task 4 rewrites it).

- [ ] **Step 5: Run** `npm test` — expected: all pass, including the 3 new tests.

- [ ] **Step 6: Commit**

```bash
git add tgcloud/lib/core/admins.js tgcloud/lib/handlers/admin.js test/admins.test.js
git commit -m "Move the admin-chat lookup into lib/core/admins.js"
```

---

### Task 2: `lib/app.js` — guard, validation, views

**Files:**
- Create: `tgcloud/lib/app.js`
- Test: `test/app.test.js`

**Interfaces:**
- Consumes: `chats.isObserving(chat)`, `tiers.tierFor/build/daysLeft`, `tiers.FREE`, `config.FREE_MEMBER_LIMIT`, `LANGS`, `now()`, `stamp()`.
- Produces:
  - `fail(code, description = code) -> never` (throws `EndpointError(description, { code })`)
  - `requireUser(ctx) -> number` (user id, or throws `FORBIDDEN`)
  - `chatIdOf(input) -> number` (negative safe integer, or throws `INVALID`)
  - `changes(chat, fields, userId) -> object` (DB fields for `chats.updateChat`, or throws `INVALID`)
  - `planView(row, at = now()) -> { kind: 'free'|'subscribed'|'grace'|'none', days: number|null, members: number, limit: number, offer_stars: number|null }`
  - `cardsView(chat, userId) -> { kind: 'me'|'dm'|'group'|'unset', id: number|null }`
  - `chatView(chat, row, userId, subscribeUrl) -> ChatView` (fields in the spec, plus `subscribe_stars`)
  - `summaryView(chat, row) -> { chat_id, title, mode, observing, observe_days_left, plan }` where `plan` is `planView(row).kind`

- [ ] **Step 1: Write the failing tests** — `test/app.test.js`:

```js
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { fresh } from './helpers.js';
import * as app from '../tgcloud/lib/app.js';
import * as chats from '../tgcloud/lib/storage/chats.js';
import * as billing from '../tgcloud/lib/storage/billing.js';
import { addDays, stamp, now, _setNow } from '../tgcloud/lib/clock.js';

const ADMIN = 777;
let chat;

beforeEach(async () => {
  fresh();
  chat = await chats.ensureChat(-100123, 'G');
});

const code = (fn) => {
  try { fn(); } catch (e) { return e.parameters && e.parameters.code; }
  return null;
};

test('requireUser returns the verified user id', () => {
  assert.equal(app.requireUser({ initData: { user: { id: ADMIN } } }), ADMIN);
});

test('requireUser refuses anything without init data', () => {
  for (const ctx of [undefined, {}, { ops: true }, { initData: {} }, { initData: { user: {} } },
    { initData: { user: { id: '777' } } }, { initData: { user: { id: -5 } } }]) {
    assert.equal(code(() => app.requireUser(ctx)), 'FORBIDDEN');
  }
});

test('chatIdOf accepts only a negative safe integer', () => {
  assert.equal(app.chatIdOf({ chat_id: -100123 }), -100123);
  for (const input of [undefined, {}, { chat_id: '-1' }, { chat_id: 5 }, { chat_id: -1.5 }, { chat_id: -(2 ** 60) }]) {
    assert.equal(code(() => app.chatIdOf(input)), 'INVALID');
  }
});

test('each accepted field maps to the stored column', () => {
  assert.deepEqual(app.changes(chat, { mode: 'active' }, ADMIN), { mode: 'active' });
  assert.deepEqual(app.changes(chat, { jev_enabled: false }, ADMIN), { jev_enabled: false });
  assert.deepEqual(app.changes(chat, { lang: 'uk' }, ADMIN), { lang: 'uk' });
  assert.deepEqual(app.changes(chat, { trust_after: 0 }, ADMIN), { trust_after: 0 });
  assert.deepEqual(app.changes(chat, { confidence_floor: 0.15 }, ADMIN), { confidence_floor: 0.15 });
  assert.deepEqual(app.changes(chat, { log_to_me: true }, ADMIN), { log_chat_id: ADMIN });
  _setNow(new Date(Date.UTC(2026, 0, 1)));
  const end = app.changes(chat, { end_observe: true }, ADMIN);
  assert.equal(end.mode, 'active');
  assert.equal(end.observe_until, stamp());
});

test('bad values are refused', () => {
  for (const fields of [
    null, [], {}, { mode: 'off' }, { jev_enabled: 1 }, { lang: 'de' },
    { delete_threshold: 1.05 }, { delete_threshold: -0.05 }, { delete_threshold: 0.93 },
    { delete_threshold: '0.9' }, { delete_threshold: Number.NaN },
    { trust_after: 51 }, { trust_after: -1 }, { trust_after: 2.5 },
    { log_to_me: false }, { end_observe: false }, { log_chat_id: 5 }, { title: 'x' }, { evil: 1 },
  ]) {
    assert.equal(code(() => app.changes(chat, fields, ADMIN)), 'INVALID', JSON.stringify(fields));
  }
});

test('review above delete is refused on the merged values', () => {
  // defaults: delete 0.90, review 0.55
  assert.equal(code(() => app.changes(chat, { review_threshold: 0.95 }, ADMIN)), 'INVALID');
  assert.equal(code(() => app.changes(chat, { delete_threshold: 0.5 }, ADMIN)), 'INVALID');
  assert.deepEqual(app.changes(chat, { delete_threshold: 0.5, review_threshold: 0.5 }, ADMIN),
    { delete_threshold: 0.5, review_threshold: 0.5 });
});

test('cardsView says where cards go, relative to the caller', () => {
  const at = (log_chat_id) => app.cardsView({ ...chat, log_chat_id }, ADMIN);
  assert.deepEqual(at(null), { kind: 'unset', id: null });
  assert.deepEqual(at(chat.chat_id), { kind: 'unset', id: null });
  assert.deepEqual(at(ADMIN), { kind: 'me', id: ADMIN });
  assert.deepEqual(at(999), { kind: 'dm', id: 999 });
  assert.deepEqual(at(-100777), { kind: 'group', id: -100777 });
});

test('planView names the plan', () => {
  const at = now();
  const row = (fields) => billing.BillingRow(-1, fields);
  assert.equal(app.planView(row({ member_count: 50 }), at).kind, 'free');
  assert.equal(app.planView(row({ member_count: 50 }), at).offer_stars, null);
  const none = app.planView(row({ member_count: 640 }), at);
  assert.equal(none.kind, 'none');
  assert.ok(none.offer_stars > 0);
  const paid = app.planView(row({ member_count: 640, paid_until: stamp(addDays(at, 10)) }), at);
  assert.deepEqual([paid.kind, paid.days, paid.offer_stars], ['subscribed', 10, null]);
  const grace = app.planView(row({ member_count: 640, grace_until: stamp(addDays(at, 3)) }), at);
  assert.equal(grace.kind, 'grace');
  assert.ok(grace.offer_stars > 0);
});

test('chatView carries every setting and the offer', () => {
  const view = app.chatView(chat, billing.empty(chat.chat_id), ADMIN, 'https://t.me/$x');
  for (const key of ['chat_id', 'title', 'mode', 'observing', 'observe_days_left', 'jev_enabled',
    'delete_threshold', 'review_threshold', 'confidence_floor', 'trust_after', 'lang', 'cards',
    'plan', 'subscribe_url', 'subscribe_stars']) {
    assert.ok(key in view, key);
  }
  assert.equal(view.observing, true);
  assert.equal(view.observe_days_left, 7);
  assert.equal(view.subscribe_url, 'https://t.me/$x');
});

test('summaryView is the list entry', () => {
  assert.deepEqual(app.summaryView(chat, billing.empty(chat.chat_id)), {
    chat_id: chat.chat_id, title: 'G', mode: 'observe', observing: true, observe_days_left: 7, plan: 'free',
  });
});
```

- [ ] **Step 2: Run** `npm test` — expected: FAIL, cannot find `tgcloud/lib/app.js`.

- [ ] **Step 3: Create `tgcloud/lib/app.js`**

```js
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

export function planView(row, at = now()) {
  const members = row.member_count || 0;
  const base = { members, limit: config.FREE_MEMBER_LIMIT };
  const tier = tiers.tierFor(row.member_count);
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

export function chatView(chat, row, userId, subscribeUrl) {
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
```

- [ ] **Step 4: Run** `npm test` — expected: all pass. If `planView`'s `grace`/`none` cases fail, read `tgcloud/lib/core/tiers.js` `build()` for the exact `reason` strings and fix the comparison, not the test.

- [ ] **Step 5: Commit**

```bash
git add tgcloud/lib/app.js test/app.test.js
git commit -m "lib/app.js: Mini App guard, field validation and chat views"
```

---

### Task 3: The three `app_*` endpoints

**Files:**
- Create: `tgcloud/lib/app_chat.js`, `tgcloud/endpoints/app_chats.js`, `tgcloud/endpoints/app_chat.js`, `tgcloud/endpoints/app_update.js`
- Modify: `test/ops.test.js` (guard tests, lines 22–44)
- Test: `test/app_endpoints.test.js`

**Interfaces:**
- Consumes: Task 1 `adminChats`, `chatsLimiter`; Task 2 `requireUser`, `fail`, `chatIdOf`, `changes`, `chatView`, `summaryView`, `planView`; `guards.isAdmin(bot, chatId, userId)`; `offer.subscribeLink(bot, { chatId, title, stars, lang })`; `billing.get(chatId)`; `chats.getChat/updateChat`.
- Produces: `app_chats({}) -> { chats: Summary[] }`, `app_chat({ chat_id }) -> ChatView`, `app_update({ chat_id, fields }) -> ChatView`. `lib/app_chat.js`: `APP_PER_MINUTE = 30`, `spend(userId)`, `loadChat(bot, chatId, userId) -> ChatConfig`, `render(bot, chat, userId) -> ChatView`.

- [ ] **Step 1: Write the failing tests** — `test/app_endpoints.test.js`:

```js
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { fresh, respond, rows } from './helpers.js';
import { calls } from './telegram.js';
import appChats from '../tgcloud/endpoints/app_chats.js';
import appChat from '../tgcloud/endpoints/app_chat.js';
import appUpdate from '../tgcloud/endpoints/app_update.js';
import { APP_PER_MINUTE } from '../tgcloud/lib/app_chat.js';
import { CHATS_PER_MINUTE } from '../tgcloud/lib/core/admins.js';
import * as chats from '../tgcloud/lib/storage/chats.js';
import * as billing from '../tgcloud/lib/storage/billing.js';
import * as trust from '../tgcloud/lib/storage/trust.js';

const GROUP = -100123;
const ADMIN = 777;
const BYSTANDER = 888;
const as = (id) => ({ initData: { user: { id } } });

async function refusal(promise) {
  try { await promise; } catch (e) { return e.parameters && e.parameters.code; }
  return null;
}

beforeEach(async () => {
  fresh();
  await chats.ensureChat(GROUP, 'Python Chat');
  await trust.seen(GROUP, ADMIN);
  respond('getChatMember', (p) => ({ status: p.user_id === ADMIN ? 'administrator' : 'member' }));
});

test('app_chats lists the chats the caller administers', async () => {
  const result = await appChats({}, as(ADMIN));
  assert.deepEqual(result.chats.map((c) => [c.chat_id, c.title, c.plan]), [[GROUP, 'Python Chat', 'free']]);
});

test('app_chats is rate-limited per user', async () => {
  for (let i = 0; i < CHATS_PER_MINUTE; i++) await appChats({}, as(ADMIN));
  assert.equal(await refusal(appChats({}, as(ADMIN))), 'RATE_LIMITED');
  assert.equal(await refusal(appChats({}, as(BYSTANDER))), null);
});

test('app_chat returns the full view to an admin', async () => {
  const view = await appChat({ chat_id: GROUP }, as(ADMIN));
  assert.equal(view.title, 'Python Chat');
  assert.equal(view.delete_threshold, 0.9);
  assert.deepEqual(view.cards, { kind: 'unset', id: null });
});

test('a non-admin learns nothing, not even whether the chat is known', async () => {
  assert.equal(await refusal(appChat({ chat_id: GROUP }, as(BYSTANDER))), 'NOT_ADMIN');
  assert.equal(await refusal(appChat({ chat_id: -555 }, as(BYSTANDER))), 'NOT_ADMIN');
  assert.equal(await refusal(appUpdate({ chat_id: GROUP, fields: { jev_enabled: false } }, as(BYSTANDER))), 'NOT_ADMIN');
  assert.equal((await chats.getChat(GROUP)).jev_enabled, true);
});

test('an admin of a chat the bot has no row for gets NOT_FOUND', async () => {
  assert.equal(await refusal(appChat({ chat_id: -555 }, as(ADMIN))), 'NOT_FOUND');
});

test('a failed admin lookup fails closed', async () => {
  respond('getChatMember', () => { throw new Error('telegram down'); });
  assert.equal(await refusal(appChat({ chat_id: GROUP }, as(ADMIN))), 'NOT_ADMIN');
});

test('app_update writes the change and returns the new view', async () => {
  const view = await appUpdate({ chat_id: GROUP, fields: { delete_threshold: 0.8, lang: 'ru' } }, as(ADMIN));
  assert.equal(view.delete_threshold, 0.8);
  assert.equal(view.lang, 'ru');
  assert.equal((await chats.getChat(GROUP)).delete_threshold, 0.8);
});

test('an invalid update writes nothing', async () => {
  const before = await chats.getChat(GROUP);
  assert.equal(await refusal(appUpdate({ chat_id: GROUP, fields: { lang: 'ru', review_threshold: 0.95 } }, as(ADMIN))), 'INVALID');
  assert.equal(await refusal(appUpdate({ chat_id: GROUP, fields: { log_chat_id: 1 } }, as(ADMIN))), 'INVALID');
  assert.deepEqual(await chats.getChat(GROUP), before);
});

test('log_to_me points the cards at the caller', async () => {
  const view = await appUpdate({ chat_id: GROUP, fields: { log_to_me: true } }, as(ADMIN));
  assert.deepEqual(view.cards, { kind: 'me', id: ADMIN });
  assert.equal((await chats.getChat(GROUP)).log_chat_id, ADMIN);
});

test('end_observe ends the observation window', async () => {
  const view = await appUpdate({ chat_id: GROUP, fields: { end_observe: true } }, as(ADMIN));
  assert.equal(view.mode, 'active');
  assert.equal(view.observing, false);
});

test('the subscribe link is offered exactly when the plan allows it', async () => {
  assert.equal((await appChat({ chat_id: GROUP }, as(ADMIN))).subscribe_url, null);
  assert.deepEqual(calls('createInvoiceLink'), []);
  await billing.setMemberCount(GROUP, 640);
  const view = await appChat({ chat_id: GROUP }, as(ADMIN));
  assert.ok(view.subscribe_url);
  assert.ok(view.subscribe_stars > 0);
});

test('app_chat and app_update share a per-user budget', async () => {
  for (let i = 0; i < APP_PER_MINUTE; i++) await appChat({ chat_id: GROUP }, as(ADMIN));
  assert.equal(await refusal(appUpdate({ chat_id: GROUP, fields: { lang: 'ru' } }, as(ADMIN))), 'RATE_LIMITED');
  assert.equal(rows('SELECT lang FROM chats')[0].lang, 'en');
});
```

- [ ] **Step 2: Update the guard tests in `test/ops.test.js`.** Add imports:

```js
import appChats from '../tgcloud/endpoints/app_chats.js';
import appChat from '../tgcloud/endpoints/app_chat.js';
import appUpdate from '../tgcloud/endpoints/app_update.js';
```

Replace the `ENDPOINTS` constant and the two guard tests (`every ops endpoint refuses…`, `every endpoint file is guarded`) with:

```js
const OPS = { ops: true };
const OPS_ENDPOINTS = [setSecret, importRows, counts, setCommands, classify, deleteWebhook, status];
const APP_ENDPOINTS = [appChats, appChat, appUpdate];

// Over HTTP an endpoint only runs with verified Mini App init data; no ops
// endpoint may run that way, or without the explicit flag only the CLI sets.
test('every ops endpoint refuses a Mini App call and a call without the flag', async () => {
  for (const endpoint of OPS_ENDPOINTS) {
    for (const ctx of [undefined, {}, { ops: 'true' }, { initData: { user: { id: 1 } } },
      { ops: true, initData: { user: { id: 1 } } }]) {
      await assert.rejects(endpoint({ value: 'k', table: 'chats', rows: [] }, ctx), { name: 'EndpointError' });
    }
  }
  assert.equal(await settings.get(settings.TYPESAFE_API_KEY), null);
  assert.deepEqual(calls('setMyCommands'), []);
});

// And the other way round: a Mini App endpoint never runs from the CLI.
test('every app endpoint refuses a call without init data', async () => {
  for (const endpoint of APP_ENDPOINTS) {
    for (const ctx of [undefined, {}, OPS, { initData: {} }]) {
      await assert.rejects(endpoint({ chat_id: -1, fields: { lang: 'ru' } }, ctx),
        (e) => e.name === 'EndpointError' && e.parameters.code === 'FORBIDDEN');
    }
  }
  assert.deepEqual(calls('getChatMember'), []);
});

test('every endpoint file is guarded', () => {
  const files = readdirSync(new URL('../tgcloud/endpoints/', import.meta.url));
  assert.equal(files.length, OPS_ENDPOINTS.length + APP_ENDPOINTS.length,
    'a new endpoint needs adding to OPS_ENDPOINTS or APP_ENDPOINTS');
  assert.equal(files.filter((f) => f.startsWith('app_')).length, APP_ENDPOINTS.length);
});
```

- [ ] **Step 3: Run** `npm test` — expected: FAIL, cannot find `tgcloud/endpoints/app_chats.js`.

- [ ] **Step 4: Create `tgcloud/lib/app_chat.js`**

```js
// Loading and rendering one chat for the Mini App.
//
// Admin rights are asked of Telegram on every call, before the chat is read
// from storage, exactly as the old /chats menu did on every button press:
// a stale row must never be enough to grant control over a group, and a
// non-admin must not learn whether a chat id is known to the bot at all.
import * as guards from './core/guards.js';
import * as offer from './core/offer.js';
import { RateLimiter } from './core/ratelimit.js';
import * as billing from './storage/billing.js';
import * as chats from './storage/chats.js';
import { chatView, fail, planView } from './app.js';
import { logger } from './log.js';

const log = logger('stopspam.app');

// One getChatMember per call; a settings screen with sliders makes a few
// calls a minute, a script making hundreds is refused.
export const APP_PER_MINUTE = 30;
const appLimiter = new RateLimiter('app', APP_PER_MINUTE);

export async function spend(userId) {
  if (!(await appLimiter.allow(userId))) fail('RATE_LIMITED');
}

export async function loadChat(bot, chatId, userId) {
  if (!(await guards.isAdmin(bot, chatId, userId))) fail('NOT_ADMIN');
  const chat = await chats.getChat(chatId);
  if (chat === null) fail('NOT_FOUND');
  return chat;
}

export async function render(bot, chat, userId) {
  const row = (await guards.bestEffort(log, 'billing_get', chat.chat_id, billing.get, chat.chat_id))
    || billing.empty(chat.chat_id);
  const stars = planView(row).offer_stars;
  const url = stars
    ? await offer.subscribeLink(bot, { chatId: chat.chat_id, title: chat.title, stars, lang: chat.lang })
    : null;
  return chatView(chat, row, userId, url);
}
```

- [ ] **Step 5: Create the endpoints.**

`tgcloud/endpoints/app_chats.js`:

```js
// Mini App: the chats the caller administers.
//
//   npx tgcloud run endpoints/app_chats '{}' --ctx '{initData:{user:{id:<id>}}}'
import { api } from 'sdk';

import { fail, requireUser, summaryView } from '../lib/app.js';
import { makeBot } from '../lib/bot.js';
import { adminChats, chatsLimiter } from '../lib/core/admins.js';
import { bestEffort } from '../lib/core/guards.js';
import { logger } from '../lib/log.js';
import * as billing from '../lib/storage/billing.js';

const log = logger('stopspam.app');

export default async function (_input, ctx) {
  const userId = requireUser(ctx);
  if (!(await chatsLimiter.allow(userId))) fail('RATE_LIMITED');
  const owned = await adminChats(makeBot(api), userId);
  const result = [];
  for (const chat of owned) {
    const row = (await bestEffort(log, 'billing_get', chat.chat_id, billing.get, chat.chat_id))
      || billing.empty(chat.chat_id);
    result.push(summaryView(chat, row));
  }
  return { chats: result };
}
```

`tgcloud/endpoints/app_chat.js`:

```js
// Mini App: one chat's settings.
import { api } from 'sdk';

import { chatIdOf, requireUser } from '../lib/app.js';
import { loadChat, render, spend } from '../lib/app_chat.js';
import { makeBot } from '../lib/bot.js';

export default async function (input, ctx) {
  const userId = requireUser(ctx);
  const chatId = chatIdOf(input);
  await spend(userId);
  const bot = makeBot(api);
  return render(bot, await loadChat(bot, chatId, userId), userId);
}
```

`tgcloud/endpoints/app_update.js`:

```js
// Mini App: change some of one chat's settings; returns the new view.
import { api } from 'sdk';

import { changes, chatIdOf, requireUser } from '../lib/app.js';
import { loadChat, render, spend } from '../lib/app_chat.js';
import { makeBot } from '../lib/bot.js';
import * as chats from '../lib/storage/chats.js';

export default async function (input, ctx) {
  const userId = requireUser(ctx);
  const chatId = chatIdOf(input);
  await spend(userId);
  const bot = makeBot(api);
  const chat = await loadChat(bot, chatId, userId);
  const fields = changes(chat, input.fields, userId);
  return render(bot, await chats.updateChat(chatId, fields), userId);
}
```

- [ ] **Step 6: Run** `npm test` — expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add tgcloud/lib/app_chat.js tgcloud/endpoints/app_*.js test/app_endpoints.test.js test/ops.test.js
git commit -m "Mini App endpoints: app_chats, app_chat, app_update"
```

---

### Task 4: Bot side — `/chats` button, menu removed, menu button

**Files:**
- Modify: `tgcloud/lib/config.js`, `tgcloud/lib/handlers/admin.js`, `tgcloud/lib/dispatch.js:7,67`, `tgcloud/lib/texts.js`, `tgcloud/endpoints/ops_set_commands.js`
- Modify tests: `test/admin_handler.test.js`, `test/cards.test.js:121-124`, `test/ops.test.js` (commands test)

**Interfaces:**
- Consumes: Task 1 `adminChats` is no longer used by `admin.js`.
- Produces: `config.APP_URL`, `admin.onChats(bot, message)` (button), `admin.onMovedMenu(bot, query)`, texts `chats_open`, `btn_open_settings`, `menu_moved`.

- [ ] **Step 1: Rewrite the menu tests in `test/admin_handler.test.js`.** Delete every test that taps a `cfg:` button or reads the menu body — by name: `toggling jev persists`, `the mode toggle persists`, `the threshold step is clamped to the unit interval`, `a non-admin cannot change anything`, `the language switch changes the menu language`, `the mode toggle does not touch observe_until`, `a bare chat callback re-renders the menu without changing state`, `malformed callback data is answered without touching anything`, `a group title with markup is escaped and does not crash /chats`, `a stranger costs no Telegram lookups`, `the candidate set is capped however many chats match`, `repeated /chats from one user is rate-limited`, `the budget is per user, not global`, `the log button redirects cards to the pressing admin`, `a non-admin cannot claim the review queue`, `the menu says where cards go when nowhere`, `the menu names the admin whose DM receives the cards`, `the menu names the plan for a free group`, `the menu tells an unpaid large group that nothing is deleted`, `the start-deleting button appears only while observing`, `pressing start deleting ends the observation window`, `a non-admin cannot end the observation window`, `gonow is an accepted callback field`, `the subscribe button survives a button press`, `a language toggle does not lose the subscribe button either`, `a re-render says so when no invoice link can be made`, `a subscribed chat is not offered the button again`, `/chats offers the subscription to an unpaid large group`. (Their security cases now live in `test/admins.test.js`, `test/app.test.js` and `test/app_endpoints.test.js`.) Remove imports that become unused (`billing`, `addDays`, `stamp`, the `edits`/`lookups`/`buttons` helpers, `invoiceFails` and its responder if nothing else uses them). Then add:

```js
import * as config from '../tgcloud/lib/config.js';

test('/chats replies with one button that opens the Mini App', async () => {
  await dm('/chats');
  const markup = sent().at(-1).reply_markup;
  assert.deepEqual(markup.inline_keyboard, [[{ text: STRINGS.btn_open_settings.en, web_app: { url: config.APP_URL } }]]);
  assert.deepEqual(calls('getChatMember'), [], '/chats itself asks Telegram nothing');
});

test('/chats speaks the user’s language', async () => {
  await dispatchMessage({ message_id: 1, date: 1, chat: { id: ADMIN, type: 'private' },
    from: { id: ADMIN, is_bot: false, first_name: 'Boss', language_code: 'ru' }, text: '/chats' }, bot());
  assert.equal(sent().at(-1).text, STRINGS.chats_open.ru);
});

test('a button on an old menu says the settings moved', async () => {
  const before = await chats.getChat(GROUP);
  await tap(`cfg:${GROUP}:jev`);
  const answer = calls('answerCallbackQuery').at(-1);
  assert.equal(answer.text, STRINGS.menu_moved.en);
  assert.equal(answer.show_alert, true);
  assert.deepEqual(await chats.getChat(GROUP), before);
});
```

In `test/cards.test.js` (`every billing key exists in every language`), remove `'menu_billing', 'billing_free', 'billing_subscribed', 'billing_grace', 'billing_none', 'btn_start_deleting', 'invoice_unavailable'` from `keys` and add `'chats_open', 'btn_open_settings', 'menu_moved'`.

In `test/ops.test.js`, extend `the commands are the ones the Python bot set at start`:

```js
test('the commands are the ones the Python bot set at start', async () => {
  await setCommands({}, OPS);
  assert.deepEqual(calls('setMyCommands')[0].commands.map((c) => c.command), ['chats', 'setlog', 'privacy', 'help']);
  assert.deepEqual(calls('setChatMenuButton')[0].menu_button.web_app, { url: config.APP_URL });
});
```

(with `import * as config from '../tgcloud/lib/config.js';`).

- [ ] **Step 2: Run** `npm test` — expected: the 4 new/changed tests FAIL (`STRINGS.btn_open_settings` undefined, `config.APP_URL` undefined).

- [ ] **Step 3: `tgcloud/lib/config.js`** — append:

```js
// The Mini App, served by Telegram Serverless next to the bot (tgcloud.jsonc "static").
export const APP_URL = 'https://app8792794574.tgcloud.ai/';
```

- [ ] **Step 4: `tgcloud/lib/texts.js`.** Delete the entries `no_chats`, `menu_title`, `menu_mode`, `menu_jev`, `menu_lang`, `menu_thresholds`, `menu_delete_threshold`, `menu_review_threshold`, `menu_log_chat`, `log_chat_unset`, `log_chat_dm`, `log_chat_group`, `btn_log_here`, `menu_not_admin`, `btn_mode_observe`, `btn_mode_active`, `btn_jev_on`, `btn_jev_off`, `menu_billing`, `billing_free`, `billing_subscribed`, `billing_grace`, `billing_none`, `btn_start_deleting`, `invoice_unavailable`. Keep `btn_subscribe` and `too_many_requests` (used by cards, notices and group). Change the comment on `LANGS` to "The languages the bot speaks." Add:

```js
  "chats_open": {
    en: "Your groups' settings are in the app below.",
    ru: "Настройки ваших групп — в приложении по кнопке ниже.",
    uk: "Налаштування ваших груп — у застосунку за кнопкою нижче.",
  },
  "btn_open_settings": {
    en: "⚙️ Settings",
    ru: "⚙️ Настройки",
    uk: "⚙️ Налаштування",
  },
  "menu_moved": {
    en: "Settings have moved to the app: send /chats.",
    ru: "Настройки переехали в приложение: отправьте /chats.",
    uk: "Налаштування переїхали в застосунок: надішліть /chats.",
  },
```

- [ ] **Step 5: `tgcloud/lib/handlers/admin.js`.** Replace the file with:

```js
// Commands in a private chat with the bot.
//
// Chat settings live in the Mini App (endpoints/app_*); /chats only opens it.
// Admin rights are checked there, against Telegram, on every call.
import * as config from '../config.js';
import * as guards from '../core/guards.js';
import { logger } from '../log.js';
import { LANGS, t } from '../texts.js';

const log = logger('stopspam.admin');

function langOf(user) {
  const code = user && user.language_code;
  return LANGS.includes(code) ? code : 'en';
}

// Answers a DM without letting a Telegram failure escape the handler.
async function say(bot, message, body, options = {}) {
  try {
    await bot.answer(message, body, options);
  } catch (exc) {
    if (guards.isProgrammingError(exc)) throw exc;
    log.warning('could not reply to user %s: %s', message.chat.id, exc);
  }
}

export async function onStart(bot, message) {
  await say(bot, message, t('welcome'));
}

export async function onHelp(bot, message) {
  await say(bot, message, t('help'));
}

export async function onPrivacy(bot, message) {
  await say(bot, message, t('privacy'));
}

export async function onChats(bot, message) {
  const lang = langOf(message.from);
  await say(bot, message, t('chats_open', lang), { replyMarkup: { inline_keyboard: [[
    { text: t('btn_open_settings', lang), web_app: { url: config.APP_URL } },
  ]] } });
}

// A button on a menu sent before the Mini App existed.
export async function onMovedMenu(bot, query) {
  try {
    await bot.answerCallbackQuery(query.id, { text: t('menu_moved', langOf(query.from)), showAlert: true });
  } catch (exc) {
    if (guards.isProgrammingError(exc)) throw exc;
    log.warning('could not answer callback %s: %s', query.id, exc);
  }
}
```

Before replacing, check that nothing else imports from `handlers/admin.js` what is being removed: `grep -rn "handlers/admin.js" tgcloud test` — `payments.js`'s `chatIdFrom` was imported *by* admin.js, not from it; if another module imports `menu`, `THRESHOLD_STEP` or `parseCallback`, stop and report.

- [ ] **Step 6: `tgcloud/lib/dispatch.js`** — line 7 comment: `//   callback_query: "cfg:" -> admin (old menu: "settings moved"), "rv:" -> review`; line 67: `if (data.startsWith('cfg:')) return admin.onMovedMenu(bot, query);`.

- [ ] **Step 7: `tgcloud/endpoints/ops_set_commands.js`** — import `* as config from '../lib/config.js'` and, after `setMyCommands`:

```js
  // The button next to the message field opens the Mini App in every
  // private chat with the bot; no manual BotFather step.
  await api.setChatMenuButton({ menu_button: { type: 'web_app', text: 'Settings', web_app: { url: config.APP_URL } } });
```

Update its header comment to say it also sets the menu button, and the return value to `{ ok: true, commands: …, menu_button: config.APP_URL }`.

- [ ] **Step 8: Run** `npm test` — expected: all pass. A failure in `test/flow.test.js` (`a button press erases review text…`, data `cfg:x`) means `onMovedMenu` threw; it must not.

- [ ] **Step 9: Commit**

```bash
git add tgcloud test
git commit -m "/chats opens the Mini App; the inline settings menu is gone"
```

---

### Task 5: Front-end scaffold and pure logic

**Files:**
- Create: `vite.config.js`, `app/index.html`, `app/src/i18n.js`, `app/src/logic.js`
- Modify: `package.json`, `tgcloud.jsonc`, `.gitignore`
- Test: `test/app_ui.test.js`

**Interfaces:**
- Produces (`app/src/logic.js`): `uiLang(code) -> 'en'|'ru'|'uk'`, `badge(summary) -> { key, days? }`, `errorKey(err) -> string`, `cardsKey(cards) -> string`, `fmt(x) -> string`, `applyLocal(view, fields) -> view`, `STEP = 0.05`.
- Produces (`app/src/i18n.js`): `STRINGS = { en, ru, uk }`, `tr(lang, key, vars = {}) -> string`.

- [ ] **Step 1: Install the build tools** (exact versions):

```bash
npm install --save-dev --save-exact vite@8.3.8 @preact/preset-vite@2.10.6 preact@10.29.8
```

Then edit `package.json` scripts to:

```json
"scripts": {
  "test": "node --import ./test/fakes/register.mjs --test \"test/**/*.test.js\"",
  "dev": "vite",
  "build": "vite build",
  "status": "tgcloud status",
  "deploy": "vite build && tgcloud push"
}
```

- [ ] **Step 2: Config files.**

`vite.config.js`:

```js
import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

// The Mini App lives in app/ and builds into dist/, which tgcloud.jsonc
// hands to `tgcloud push` as the static site.
export default defineConfig({
  root: 'app',
  plugins: [preact()],
  build: { outDir: '../dist', emptyOutDir: true },
});
```

`tgcloud.jsonc`:

```jsonc
// The Mini App's build output, served at https://app8792794574.tgcloud.ai/.
// Build first (npm run build): push never builds.
{
  "static": { "source": "dist", "immutable": ["/assets/*"] }
}
```

`.gitignore`: add a line `dist/`.

`app/index.html`:

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>StopSpam</title>
    <script src="https://telegram.org/js/telegram-web-app.js"></script>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
```

- [ ] **Step 3: Write the failing tests** — `test/app_ui.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as logic from '../app/src/logic.js';
import { STRINGS, tr } from '../app/src/i18n.js';

test('the UI language follows the Telegram client, else English', () => {
  assert.equal(logic.uiLang('ru'), 'ru');
  assert.equal(logic.uiLang('uk'), 'uk');
  assert.equal(logic.uiLang('de'), 'en');
  assert.equal(logic.uiLang(undefined), 'en');
});

test('every string exists in every language', () => {
  const keys = Object.keys(STRINGS.en).sort();
  for (const lang of ['ru', 'uk']) assert.deepEqual(Object.keys(STRINGS[lang]).sort(), keys, lang);
});

test('tr fills placeholders and falls back to the key', () => {
  assert.equal(tr('en', 'badge_observe', { days: 3 }), 'observing · 3 days left');
  assert.equal(tr('en', 'no_such_key'), 'no_such_key');
});

test('the badge says what matters most', () => {
  assert.deepEqual(logic.badge({ observing: true, observe_days_left: 3, plan: 'none' }), { key: 'badge_observe', days: 3 });
  assert.deepEqual(logic.badge({ observing: false, plan: 'none' }), { key: 'badge_unpaid' });
  assert.deepEqual(logic.badge({ observing: false, plan: 'free' }), { key: 'badge_active' });
});

test('endpoint error codes map to messages', () => {
  const endpoint = (code) => ({ type: 'ENDPOINT_ERROR', message: code, parameters: { code } });
  assert.equal(logic.errorKey(endpoint('NOT_ADMIN')), 'err_not_admin');
  assert.equal(logic.errorKey(endpoint('RATE_LIMITED')), 'err_rate_limited');
  assert.equal(logic.errorKey(endpoint('INVALID')), 'err_invalid');
  assert.equal(logic.errorKey(endpoint('NOT_FOUND')), 'err_not_found');
  assert.equal(logic.errorKey({ type: 'UNAUTHORIZED' }), 'err_generic');
  assert.equal(logic.errorKey(new Error('x')), 'err_generic');
  for (const key of ['err_not_admin', 'err_rate_limited', 'err_invalid', 'err_not_found', 'err_generic']) {
    assert.ok(key in STRINGS.en, key);
  }
});

test('cards and numbers are labelled', () => {
  assert.equal(logic.cardsKey({ kind: 'me' }), 'cards_me');
  assert.equal(logic.cardsKey({ kind: 'group' }), 'cards_group');
  assert.equal(logic.fmt(0.9), '0.90');
});

test('the optimistic view shows the change before the server answers', () => {
  const view = { mode: 'observe', observing: true, lang: 'en', cards: { kind: 'unset', id: null } };
  assert.equal(logic.applyLocal(view, { lang: 'ru' }).lang, 'ru');
  assert.deepEqual(logic.applyLocal(view, { end_observe: true }), { ...view, mode: 'active', observing: false });
  assert.equal(logic.applyLocal(view, { log_to_me: true }).cards.kind, 'me');
  assert.equal(view.lang, 'en', 'the input view is not mutated');
});
```

- [ ] **Step 4: Run** `npm test` — expected: FAIL, cannot find `app/src/logic.js`.

- [ ] **Step 5: Create `app/src/logic.js`**

```js
// Pure helpers for the Mini App. No DOM, no Telegram: tested under node.

export const STEP = 0.05;

export function uiLang(code) {
  return code === 'ru' || code === 'uk' ? code : 'en';
}

// The one thing a chat card in the list should say about the chat.
export function badge(summary) {
  if (summary.observing) return { key: 'badge_observe', days: summary.observe_days_left };
  if (summary.plan === 'none') return { key: 'badge_unpaid' };
  return { key: 'badge_active' };
}

const ERRORS = {
  NOT_ADMIN: 'err_not_admin',
  RATE_LIMITED: 'err_rate_limited',
  INVALID: 'err_invalid',
  NOT_FOUND: 'err_not_found',
};

// Serverless.call's err: type 'ENDPOINT_ERROR' when the endpoint threw an
// EndpointError, with our { code } in err.parameters.
export function errorKey(err) {
  const code = err && err.type === 'ENDPOINT_ERROR' && err.parameters && err.parameters.code;
  return ERRORS[code] || 'err_generic';
}

export function cardsKey(cards) {
  return `cards_${cards.kind}`;
}

export function fmt(x) {
  return Number(x).toFixed(2);
}

// What the screen shows between sending a change and the server's answer.
export function applyLocal(view, fields) {
  const next = { ...view };
  for (const [name, value] of Object.entries(fields)) {
    if (name === 'end_observe') {
      next.mode = 'active';
      next.observing = false;
    } else if (name === 'log_to_me') {
      next.cards = { kind: 'me', id: view.cards.id };
    } else {
      next[name] = value;
    }
  }
  return next;
}
```

- [ ] **Step 6: Create `app/src/i18n.js`**

```js
// The Mini App's own strings, in the language of the Telegram client.
// Separate from the bot's texts.js, which speaks the chat's language.

export const STRINGS = {
  en: {
    title: 'Your groups',
    loading: 'Loading…',
    empty: 'No groups yet. Add the bot to a group, make it an admin, and write any message there — then the group appears here.',
    badge_observe: 'observing · {days} days left',
    badge_unpaid: 'no subscription',
    badge_active: 'active',
    sec_moderation: 'Moderation',
    mode_active: 'Delete',
    mode_observe: 'Only report',
    jev: 'Classification',
    jev_hint: 'When off, messages are not sent to the classifier at all.',
    start_deleting: 'Seen enough — start deleting',
    start_deleting_confirm: 'End the observation period and start deleting spam now?',
    sec_thresholds: 'Thresholds',
    delete_threshold: 'Delete at',
    delete_hint: 'Messages scoring at least this are deleted.',
    review_threshold: 'Review at',
    review_hint: 'Messages scoring at least this become a review card.',
    confidence_floor: 'Confidence floor',
    confidence_hint: 'Below this confidence a message goes to review instead of being deleted.',
    trust_after: 'Trust after',
    trust_hint: 'Clean messages before a member stops being checked.',
    sec_cards: 'Review cards',
    cards_me: 'Go to your private chat with the bot.',
    cards_dm: 'Go to another admin’s private chat ({id}).',
    cards_group: 'Go to a moderator group ({id}).',
    cards_unset: 'Go nowhere — nobody receives them.',
    cards_to_me: 'Send them to me',
    sec_lang: 'Bot language in this group',
    sec_plan: 'Plan',
    plan_free: 'Free ({members} members, under {limit}).',
    plan_subscribed: 'Paid, {days} days left.',
    plan_grace: 'Free trial, {days} days left.',
    plan_none: 'No subscription — spam is reported but not deleted.',
    subscribe: 'Subscribe — {stars} ⭐/month',
    err_not_admin: 'You are not an admin of this group.',
    err_rate_limited: 'Too many requests. Try again in a minute.',
    err_invalid: 'This value cannot be saved. Review cannot be above delete.',
    err_not_found: 'The bot does not know this group yet.',
    err_generic: 'Something went wrong. Try again.',
  },
  ru: {
    title: 'Ваши группы',
    loading: 'Загрузка…',
    empty: 'Групп пока нет. Добавьте бота в группу, сделайте его админом и напишите там любое сообщение — тогда группа появится здесь.',
    badge_observe: 'наблюдение · ещё {days} дн.',
    badge_unpaid: 'нет подписки',
    badge_active: 'активен',
    sec_moderation: 'Модерация',
    mode_active: 'Удалять',
    mode_observe: 'Только сообщать',
    jev: 'Классификация',
    jev_hint: 'Если выключено, сообщения вообще не отправляются классификатору.',
    start_deleting: 'Достаточно — начать удалять',
    start_deleting_confirm: 'Закончить период наблюдения и начать удалять спам прямо сейчас?',
    sec_thresholds: 'Пороги',
    delete_threshold: 'Удалять от',
    delete_hint: 'Сообщения с оценкой не ниже этой удаляются.',
    review_threshold: 'На проверку от',
    review_hint: 'Сообщения с оценкой не ниже этой становятся карточкой на проверку.',
    confidence_floor: 'Минимальная уверенность',
    confidence_hint: 'При уверенности ниже этой сообщение уходит на проверку, а не удаляется.',
    trust_after: 'Доверять после',
    trust_hint: 'Сколько чистых сообщений нужно, чтобы участника перестали проверять.',
    sec_cards: 'Карточки на проверку',
    cards_me: 'Приходят вам в личный чат с ботом.',
    cards_dm: 'Приходят в личный чат другого админа ({id}).',
    cards_group: 'Приходят в группу модераторов ({id}).',
    cards_unset: 'Никуда не приходят — их никто не получает.',
    cards_to_me: 'Присылать мне',
    sec_lang: 'Язык бота в этой группе',
    sec_plan: 'Тариф',
    plan_free: 'Бесплатно ({members} участников, меньше {limit}).',
    plan_subscribed: 'Оплачено, осталось {days} дн.',
    plan_grace: 'Пробный период, осталось {days} дн.',
    plan_none: 'Нет подписки — спам показывается, но не удаляется.',
    subscribe: 'Подписаться — {stars} ⭐/мес.',
    err_not_admin: 'Вы не админ этой группы.',
    err_rate_limited: 'Слишком много запросов. Попробуйте через минуту.',
    err_invalid: 'Это значение нельзя сохранить. Порог проверки не может быть выше порога удаления.',
    err_not_found: 'Бот пока не знает эту группу.',
    err_generic: 'Что-то пошло не так. Попробуйте ещё раз.',
  },
  uk: {
    title: 'Ваші групи',
    loading: 'Завантаження…',
    empty: 'Груп поки немає. Додайте бота до групи, зробіть його адміністратором і напишіть там будь-яке повідомлення — тоді група з’явиться тут.',
    badge_observe: 'спостереження · ще {days} дн.',
    badge_unpaid: 'немає підписки',
    badge_active: 'активний',
    sec_moderation: 'Модерація',
    mode_active: 'Видаляти',
    mode_observe: 'Лише повідомляти',
    jev: 'Класифікація',
    jev_hint: 'Якщо вимкнено, повідомлення взагалі не надсилаються класифікатору.',
    start_deleting: 'Досить — почати видаляти',
    start_deleting_confirm: 'Завершити період спостереження і почати видаляти спам просто зараз?',
    sec_thresholds: 'Пороги',
    delete_threshold: 'Видаляти від',
    delete_hint: 'Повідомлення з оцінкою не нижче цієї видаляються.',
    review_threshold: 'На перевірку від',
    review_hint: 'Повідомлення з оцінкою не нижче цієї стають карткою на перевірку.',
    confidence_floor: 'Мінімальна впевненість',
    confidence_hint: 'За впевненості нижче цієї повідомлення йде на перевірку, а не видаляється.',
    trust_after: 'Довіряти після',
    trust_hint: 'Скільки чистих повідомлень потрібно, щоб учасника перестали перевіряти.',
    sec_cards: 'Картки на перевірку',
    cards_me: 'Надходять вам в особистий чат із ботом.',
    cards_dm: 'Надходять в особистий чат іншого адміністратора ({id}).',
    cards_group: 'Надходять у групу модераторів ({id}).',
    cards_unset: 'Нікуди не надходять — їх ніхто не отримує.',
    cards_to_me: 'Надсилати мені',
    sec_lang: 'Мова бота в цій групі',
    sec_plan: 'Тариф',
    plan_free: 'Безкоштовно ({members} учасників, менше {limit}).',
    plan_subscribed: 'Оплачено, залишилось {days} дн.',
    plan_grace: 'Пробний період, залишилось {days} дн.',
    plan_none: 'Немає підписки — спам показується, але не видаляється.',
    subscribe: 'Підписатися — {stars} ⭐/міс.',
    err_not_admin: 'Ви не адміністратор цієї групи.',
    err_rate_limited: 'Забагато запитів. Спробуйте за хвилину.',
    err_invalid: 'Це значення не можна зберегти. Поріг перевірки не може бути вищим за поріг видалення.',
    err_not_found: 'Бот ще не знає цю групу.',
    err_generic: 'Щось пішло не так. Спробуйте ще раз.',
  },
};

export function tr(lang, key, vars = {}) {
  const template = (STRINGS[lang] && STRINGS[lang][key]) || STRINGS.en[key] || key;
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match));
}
```

- [ ] **Step 7: Run** `npm test` — expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json vite.config.js tgcloud.jsonc .gitignore app test/app_ui.test.js
git commit -m "Mini App scaffold: Vite + Preact, strings and pure helpers"
```

---

### Task 6: The two screens

**Files:**
- Create: `app/src/main.jsx`, `app/src/api.js`, `app/src/ChatList.jsx`, `app/src/ChatSettings.jsx`, `app/src/styles.css`, `app/src/dev_stub.js`

**Interfaces:**
- Consumes: Task 5 `logic.*`, `tr`; endpoint contracts from Task 3.
- Produces: `call(name, input) -> Promise` in `api.js`.

- [ ] **Step 1: `app/src/api.js`**

```js
// Serverless.call as a promise. The platform sends the init data itself.
export function call(name, input = {}) {
  return new Promise((resolve, reject) => {
    window.Telegram.WebApp.Serverless.call(name, input, (err, result) => (err ? reject(err) : resolve(result)));
  });
}
```

- [ ] **Step 2: `app/src/dev_stub.js`** — only loaded by `npm run dev` outside Telegram:

```js
// A fake Telegram.WebApp for `npm run dev` in a plain browser. Never built
// into dist/: main.jsx imports it only under import.meta.env.DEV.
const chat = {
  chat_id: -1001, title: 'Demo group', mode: 'observe', observing: true, observe_days_left: 5,
  jev_enabled: true, delete_threshold: 0.9, review_threshold: 0.55, confidence_floor: 0.75,
  trust_after: 5, lang: 'en', cards: { kind: 'unset', id: null },
  plan: { kind: 'none', days: null, members: 640, limit: 200, offer_stars: 250 },
  subscribe_url: 'https://t.me/$demo', subscribe_stars: 250,
};
const noop = () => {};
window.Telegram = { WebApp: {
  initData: 'dev', initDataUnsafe: { user: { id: 1, language_code: navigator.language.slice(0, 2) } },
  ready: noop, expand: noop,
  BackButton: { show: noop, hide: noop, onClick: noop, offClick: noop },
  HapticFeedback: { impactOccurred: noop },
  showAlert: (m) => window.alert(m),
  showConfirm: (m, cb) => cb(window.confirm(m)),
  openInvoice: (_u, cb) => cb('cancelled'),
  Serverless: { call(name, input, cb) {
    setTimeout(() => {
      if (name === 'app_chats') return cb(null, { chats: [{ chat_id: chat.chat_id, title: chat.title, mode: chat.mode, observing: chat.observing, observe_days_left: 5, plan: 'none' }] });
      if (name === 'app_chat') return cb(null, chat);
      if (name === 'app_update') {
        if (input.fields.review_threshold > chat.delete_threshold) return cb({ type: 'ENDPOINT_ERROR', parameters: { code: 'INVALID' } });
        Object.assign(chat, input.fields);
        if (input.fields.end_observe) Object.assign(chat, { mode: 'active', observing: false });
        if (input.fields.log_to_me) chat.cards = { kind: 'me', id: 1 };
        return cb(null, { ...chat });
      }
      return cb({ type: 'UNKNOWN' });
    }, 200);
  } },
} };
```

- [ ] **Step 3: `app/src/main.jsx`** — no top-level `await` (older Telegram webviews), and nothing reads `window.Telegram` until `start()` runs, so the dev stub can install itself first:

```jsx
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';

import { ChatList } from './ChatList.jsx';
import { ChatSettings } from './ChatSettings.jsx';
import { uiLang } from './logic.js';
import './styles.css';

function App({ lang }) {
  const [chatId, setChatId] = useState(null);
  const tg = window.Telegram.WebApp;

  useEffect(() => {
    if (chatId === null) {
      tg.BackButton.hide();
      return undefined;
    }
    const back = () => setChatId(null);
    tg.BackButton.show();
    tg.BackButton.onClick(back);
    return () => tg.BackButton.offClick(back);
  }, [chatId]);

  // The list stays mounted (hidden) so going back does not refetch it and
  // spend the 3-per-minute listing budget.
  return (
    <>
      <div hidden={chatId !== null}><ChatList lang={lang} onOpen={setChatId} /></div>
      {chatId !== null && <ChatSettings lang={lang} chatId={chatId} />}
    </>
  );
}

function start() {
  const tg = window.Telegram.WebApp;
  tg.ready();
  tg.expand();
  const user = tg.initDataUnsafe && tg.initDataUnsafe.user;
  render(<App lang={uiLang(user && user.language_code)} />, document.getElementById('root'));
}

// Outside Telegram (npm run dev in a browser) there is no init data; the
// stub fakes the WebApp object. import.meta.env.DEV is false in a build,
// so the stub never reaches dist/.
if (import.meta.env.DEV && !(window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initData)) {
  import('./dev_stub.js').then(start);
} else {
  start();
}
```

- [ ] **Step 4: `app/src/ChatList.jsx`**

```jsx
import { useEffect, useState } from 'preact/hooks';

import { call } from './api.js';
import { tr } from './i18n.js';
import { badge, errorKey } from './logic.js';

export function ChatList({ lang, onOpen }) {
  const [chats, setChats] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    call('app_chats').then((r) => setChats(r.chats), (e) => setError(errorKey(e)));
  }, []);

  if (error) return <p class="note">{tr(lang, error)}</p>;
  if (chats === null) return <p class="note">{tr(lang, 'loading')}</p>;
  return (
    <main>
      <h1>{tr(lang, 'title')}</h1>
      {chats.length === 0 && <p class="note">{tr(lang, 'empty')}</p>}
      {chats.map((c) => {
        const b = badge(c);
        return (
          <button class="card" key={c.chat_id} onClick={() => onOpen(c.chat_id)}>
            <span class="card-title">{c.title}</span>
            <span class={`badge ${b.key}`}>{tr(lang, b.key, { days: b.days })}</span>
          </button>
        );
      })}
    </main>
  );
}
```

- [ ] **Step 5: `app/src/ChatSettings.jsx`**

```jsx
import { useEffect, useState } from 'preact/hooks';

import { call } from './api.js';
import { tr } from './i18n.js';
import { applyLocal, cardsKey, errorKey, fmt, STEP } from './logic.js';

const LANGS = ['en', 'ru', 'uk'];
// Read on use, not at import: in dev the stub installs it after this module loads.
const tg = () => window.Telegram.WebApp;

function Section({ title, children }) {
  return <section><h2>{title}</h2><div class="group">{children}</div></section>;
}

function Slider({ label, hint, value, onSave }) {
  const [local, setLocal] = useState(value);
  useEffect(() => setLocal(value), [value]);
  return (
    <label class="row column">
      <span class="row-line"><span>{label}</span><b>{fmt(local)}</b></span>
      <input type="range" min="0" max="1" step={STEP} value={local}
        onInput={(e) => setLocal(Number(e.currentTarget.value))}
        onChange={(e) => onSave(Number(e.currentTarget.value))} />
      <small>{hint}</small>
    </label>
  );
}

function Segments({ options, value, onPick }) {
  return (
    <div class="segments">
      {options.map(([key, label]) => (
        <button key={key} class={key === value ? 'on' : ''} onClick={() => key !== value && onPick(key)}>{label}</button>
      ))}
    </div>
  );
}

export function ChatSettings({ lang, chatId }) {
  const [view, setView] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    setView(null);
    call('app_chat', { chat_id: chatId }).then(setView, (e) => setError(errorKey(e)));
  }, [chatId]);

  // Optimistic: show the change, then replace it with the server's view, or
  // put the last server view back and say why.
  function save(fields) {
    const before = view;
    setView(applyLocal(view, fields));
    call('app_update', { chat_id: chatId, fields }).then((next) => {
      setView(next);
      tg().HapticFeedback.impactOccurred('light');
    }, (e) => {
      setView(before);
      tg().showAlert(tr(lang, errorKey(e)));
    });
  }

  function startDeleting() {
    tg().showConfirm(tr(lang, 'start_deleting_confirm'), (ok) => ok && save({ end_observe: true }));
  }

  function subscribe() {
    tg().openInvoice(view.subscribe_url, (status) => {
      if (status === 'paid') call('app_chat', { chat_id: chatId }).then(setView, () => {});
    });
  }

  if (error) return <p class="note">{tr(lang, error)}</p>;
  if (view === null) return <p class="note">{tr(lang, 'loading')}</p>;
  const plan = view.plan;
  return (
    <main>
      <h1>{view.title}</h1>

      <Section title={tr(lang, 'sec_moderation')}>
        <div class="row">
          <Segments value={view.mode} onPick={(mode) => save({ mode })}
            options={[['active', tr(lang, 'mode_active')], ['observe', tr(lang, 'mode_observe')]]} />
        </div>
        <label class="row column">
          <span class="row-line">
            <span>{tr(lang, 'jev')}</span>
            <input type="checkbox" class="switch" checked={view.jev_enabled}
              onChange={(e) => save({ jev_enabled: e.currentTarget.checked })} />
          </span>
          <small>{tr(lang, 'jev_hint')}</small>
        </label>
        {view.observing && (
          <div class="row column">
            <small>{tr(lang, 'badge_observe', { days: view.observe_days_left })}</small>
            <button class="primary" onClick={startDeleting}>{tr(lang, 'start_deleting')}</button>
          </div>
        )}
      </Section>

      <Section title={tr(lang, 'sec_thresholds')}>
        <Slider label={tr(lang, 'delete_threshold')} hint={tr(lang, 'delete_hint')}
          value={view.delete_threshold} onSave={(v) => save({ delete_threshold: v })} />
        <Slider label={tr(lang, 'review_threshold')} hint={tr(lang, 'review_hint')}
          value={view.review_threshold} onSave={(v) => save({ review_threshold: v })} />
        <Slider label={tr(lang, 'confidence_floor')} hint={tr(lang, 'confidence_hint')}
          value={view.confidence_floor} onSave={(v) => save({ confidence_floor: v })} />
        <div class="row column">
          <span class="row-line">
            <span>{tr(lang, 'trust_after')}</span>
            <span class="stepper">
              <button disabled={view.trust_after <= 0} onClick={() => save({ trust_after: view.trust_after - 1 })}>−</button>
              <b>{view.trust_after}</b>
              <button disabled={view.trust_after >= 50} onClick={() => save({ trust_after: view.trust_after + 1 })}>+</button>
            </span>
          </span>
          <small>{tr(lang, 'trust_hint')}</small>
        </div>
      </Section>

      <Section title={tr(lang, 'sec_cards')}>
        <div class="row column">
          <span>{tr(lang, cardsKey(view.cards), { id: view.cards.id })}</span>
          {view.cards.kind !== 'me' && <button onClick={() => save({ log_to_me: true })}>{tr(lang, 'cards_to_me')}</button>}
        </div>
      </Section>

      <Section title={tr(lang, 'sec_lang')}>
        <div class="row">
          <Segments value={view.lang} onPick={(l) => save({ lang: l })}
            options={LANGS.map((l) => [l, l.toUpperCase()])} />
        </div>
      </Section>

      <Section title={tr(lang, 'sec_plan')}>
        <div class="row column">
          <span>{tr(lang, `plan_${plan.kind}`, plan)}</span>
          {view.subscribe_url && (
            <button class="primary" onClick={subscribe}>{tr(lang, 'subscribe', { stars: view.subscribe_stars })}</button>
          )}
        </div>
      </Section>
    </main>
  );
}
```

- [ ] **Step 6: `app/src/styles.css`** — Telegram theme variables only, with fallbacks for the dev stub:

```css
:root {
  --bg: var(--tg-theme-secondary-bg-color, #efeff4);
  --card: var(--tg-theme-section-bg-color, var(--tg-theme-bg-color, #fff));
  --text: var(--tg-theme-text-color, #000);
  --hint: var(--tg-theme-hint-color, #8e8e93);
  --accent: var(--tg-theme-button-color, #2481cc);
  --accent-text: var(--tg-theme-button-text-color, #fff);
  --link: var(--tg-theme-link-color, #2481cc);
  --header: var(--tg-theme-section-header-text-color, var(--hint));
  --sep: var(--tg-theme-section-separator-color, rgba(0, 0, 0, 0.08));
  color-scheme: light dark;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text);
  font: 15px/1.4 -apple-system, system-ui, "Segoe UI", Roboto, sans-serif; }
main { padding: 12px 16px 32px; max-width: 640px; margin: 0 auto; }
h1 { font-size: 20px; margin: 8px 4px 16px; }
h2 { font-size: 13px; font-weight: 500; text-transform: uppercase; color: var(--header); margin: 20px 4px 6px; }
.note { color: var(--hint); padding: 24px 20px; text-align: center; }
.group { background: var(--card); border-radius: 12px; overflow: hidden; }
.row { padding: 12px 14px; border-bottom: 1px solid var(--sep); display: flex; gap: 8px; }
.row:last-child { border-bottom: 0; }
.row.column { flex-direction: column; }
.row-line { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
small { color: var(--hint); font-size: 13px; }
button { font: inherit; border: 0; border-radius: 10px; padding: 10px 14px; cursor: pointer;
  background: transparent; color: var(--link); }
button.primary { background: var(--accent); color: var(--accent-text); }
button:disabled { opacity: 0.4; cursor: default; }
.card { width: 100%; display: flex; justify-content: space-between; align-items: center; gap: 12px;
  background: var(--card); color: var(--text); margin-bottom: 8px; padding: 14px; text-align: left; }
.card-title { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.badge { font-size: 12px; color: var(--hint); white-space: nowrap; }
.badge.badge_unpaid { color: #e53935; }
.segments { display: flex; width: 100%; background: var(--bg); border-radius: 10px; padding: 2px; }
.segments button { flex: 1; color: var(--text); padding: 8px; }
.segments button.on { background: var(--card); font-weight: 600; box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12); }
input[type="range"] { width: 100%; accent-color: var(--accent); }
.switch { width: 22px; height: 22px; accent-color: var(--accent); }
.stepper { display: flex; align-items: center; gap: 4px; }
.stepper b { min-width: 2ch; text-align: center; }
.stepper button { padding: 4px 12px; font-size: 18px; }
```

- [ ] **Step 7: Build** — `npm run build` — expected: exits 0, writes `dist/index.html` and `dist/assets/*.js|css`. Check the stub is not in the bundle: `grep -l "Demo group" dist/assets/*.js` prints nothing.

- [ ] **Step 8 (only if the owner asks to see it before deploying): look at it locally.** `npm run dev` (background), open the printed URL at phone width, check: the list shows "Demo group" with its badge; tapping opens settings; a slider moves and saves; setting "Review at" above 0.90 shows the error alert and snaps back; the subscribe button shows. Fix what is wrong, then stop the dev server.

- [ ] **Step 9: Run** `npm test` — expected: all pass.

- [ ] **Step 10: Commit**

```bash
git add app
git commit -m "Mini App screens: chat list and chat settings"
```

---

### Task 7: Deploy and verify

**Files:**
- Modify: `.github/workflows/deploy.yml` (deploy job), `README.md` (the `/chats` paragraphs and the deploy section)

- [ ] **Step 1: CI builds before pushing.** In `.github/workflows/deploy.yml`, deploy job, between `Install dependencies` and `Push modules`, add:

```yaml
      # push never builds, and the static site comes from dist/.
      - name: Build the Mini App
        if: steps.secrets.outputs.ready == 'true'
        run: npm run build
```

and change the comment above `Push modules` to `# Pushes the modules and the Mini App in dist/. Database schema changes …` (keep the rest).

- [ ] **Step 2: README.** Where it says settings are adjusted "with `/chats`", say `/chats` opens the settings app. In the deploy section, replace `tgcloud push` with `npm run deploy` (build + push). Keep it short.

- [ ] **Step 3: Run** `npm test` and `npm run build` — expected: both succeed.

- [ ] **Step 4: Commit and merge** (merging to `master` deploys):

```bash
git add .github/workflows/deploy.yml README.md
git commit -m "Deploy builds the Mini App; README points /chats at it"
git checkout master && git merge --ff-only miniapp && git push origin master
```

Watch the `CI & Deploy` run to completion (`gh run watch <id> --exit-status`). The `Push modules` log must print the site address `https://app8792794574.tgcloud.ai/`.

- [ ] **Step 5: Set the menu button and smoke-test the endpoints on the platform.** Needs a CLI token: run these through a one-off `workflow_dispatch` job or locally with the owner's token (`request_secret`, `delivery: "file"`, then `TGCLOUD_TOKEN="$(cat "$file")"`). Never echo the token.

```bash
npx --no-install tgcloud run endpoints/ops_set_commands '{}' --ctx '{ops: true}'
npx --no-install tgcloud run endpoints/app_chats '{}' --ctx '{initData:{user:{id:<owner id>}}}'
npx --no-install tgcloud run endpoints/app_chat '{chat_id: -1002590623139}' --ctx '{initData:{user:{id:<owner id>}}}'
npx --no-install tgcloud run endpoints/app_chats '{}' --ctx '{ops: true}'
```

Expected: menu button set; the owner's chats listed; one chat's view; the last call refused with `FORBIDDEN`. The owner id is a question for the owner if it is not known.

- [ ] **Step 6: `curl -s https://app8792794574.tgcloud.ai/ | head -5`** — expected: the built `index.html`.

- [ ] **Step 7: Hand over to the owner** to check in Telegram: `/chats` → "⚙️ Settings" opens the app; change a threshold, reopen, it stuck; the menu button opens the same app; a button on an old menu message says the settings moved.
