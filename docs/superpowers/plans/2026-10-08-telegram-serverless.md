# Telegram Serverless Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run StopSpam on Telegram Serverless as a JavaScript port with identical behaviour, then remove the Python/Docker/VPS implementation.

**Architecture:** Line-for-line port of every Python module into `tgcloud/lib/` (same names, camelCase), a thin dispatcher in `tgcloud/handlers/`, ops endpoints for one-off operations, and a `node:test` suite that runs the real modules against fakes of `sdk` (node:sqlite-backed `db`, recording `api`, scripted `fetch`).

**Tech Stack:** JavaScript ES modules, Telegram Serverless SDK (`sdk`, `sdk/db`), `@tgcloud/cli@0.2.0`, Node 26 `node:test` + `node:sqlite`.

**Spec:** `docs/superpowers/specs/2026-10-08-telegram-serverless-design.md`

## Global Constraints

- Runtime modules import only `sdk`, `sdk/db`, and relative project modules ending in `.js`. No npm, no `node:*`, no `process`, no `Buffer`.
- Never run `npx tgcloud` unless `node_modules/@tgcloud/cli` is installed (the unscoped `tgcloud` package is unrelated third-party code).
- Stored timestamps: `YYYY-MM-DDTHH:MM:SS+00:00` (Python `isoformat(timespec="seconds")` in UTC).
- Every Bot API send uses `parse_mode: "HTML"` unless the Python passed something else.
- String truncation counts code points (`Array.from`), as Python slicing does.
- `html.escape` semantics: `&`→`&amp;`, `<`→`&lt;`, `>`→`&gt;`, `"`→`&quot;`, `'`→`&#x27;`.
- `f"{x:.2f}"` → `x.toFixed(2)`.
- Python `best_effort` caught `sqlite3.Error`; JS `bestEffort` catches every error except programming errors (`TypeError`, `ReferenceError`, `SyntaxError`, `RangeError`), which it rethrows.
- `except TelegramAPIError` around a Bot API call → `catch (e) { if (isProgrammingError(e)) throw e; ... }`.
- Comments: keep the Python docstrings' substance as JS comments where they explain *why*; do not invent new ones.

## Shared interfaces (produced in Tasks 1–2, consumed everywhere)

```js
// tgcloud/lib/clock.js
export function now(): Date                       // current time (overridable)
export function stamp(date = now()): string       // "2026-01-01T00:00:00+00:00"
export function parse(s): Date | null             // fromisoformat equivalent; null on bad input
export function addDays(date, n): Date
export function _setNow(fnOrNull)                 // tests only

// tgcloud/lib/guards.js  (core/guards.py)
export const AdminCheck = { ADMIN, NOT_ADMIN, UNKNOWN }
export function isProgrammingError(e): boolean
export async function bestEffort(log, what, chatId, fn, ...args)   // awaits fn(...args); null on storage error
export async function adminCheck(bot, chatId, userId)
export async function isAdmin(bot, chatId, userId)

// tgcloud/lib/log.js
export function logger(name) -> { info, warning, error }   // console.* with "[name]" prefix

// tgcloud/lib/bot.js
export function makeBot(api) -> {
  sendMessage(chatId, text, { replyMarkup } = {}),
  deleteMessage(chatId, messageId), banChatMember(chatId, userId),
  getChatMember(chatId, userId), getChatMemberCount(chatId),
  createInvoiceLink(params), answerCallbackQuery(id, { text, showAlert } = {}),
  editMessageText(chatId, messageId, text, { replyMarkup } = {}),
  answerPreCheckoutQuery(id, { ok, errorMessage }), setMyCommands(commands),
  me(),   // getMe, cached in module scope and settings table key "bot_me"
}
```

Storage modules return plain objects with the Python dataclass field names (snake_case, as the columns are), e.g. `ChatConfig` → `{chat_id, title, mode, ..., jev_enabled: boolean}`.

---

### Task 1: Project skeleton, sdk fakes, schema, clock, settings

**Files:**
- Create: `package.json`, `tgcloud.jsonc`, `tgcloud/schema.js`, `tgcloud/lib/clock.js`, `tgcloud/lib/log.js`, `tgcloud/lib/config.js`, `tgcloud/lib/storage/settings.js`
- Create: `test/fakes/sdk.js`, `test/fakes/sdk-db.js`, `test/fakes/hooks.mjs`, `test/fakes/register.mjs`, `test/helpers.js`
- Test: `test/schema.test.js`, `test/clock.test.js`

- [ ] `package.json`: `"type": "module"`, devDependency `"@tgcloud/cli": "0.2.0"` (exact), scripts `"test": "node --import ./test/fakes/register.mjs --test test/"`, `"deploy": "tgcloud push"`.
- [ ] Fakes: `register.mjs` calls `module.register('./hooks.mjs')`; `hooks.mjs` resolves `sdk`, `sdk/db`, `sdk/api`, `sdk/fetch` to the fake files. `sdk-db.js` implements `table`, column factories (`text`, `integer`, `real`), modifiers (`primaryKey({autoIncrement})`, `notNull`, `default`), extras (`index().on()`, `primaryKey({columns})`) emitting `CREATE TABLE`/`CREATE INDEX`; `sql` tag → `{text, params}` with `:pN` names; `db.run/all/get` over a `node:sqlite` `DatabaseSync(':memory:')` with `run` → `{rowsAffected, lastInsertRowid, rows}`; `resetDb()` recreates the DB from `tgcloud/schema.js`. `sdk.js` exports `db`, `api` (Proxy recording `{method, params}` into `api.calls`, with `api.respond(method, fnOrValue)`), `fetch` (scripted via `fetch.script(fn)`), `BotApiError(code, description, method, parameters)`.
- [ ] Schema: the seven Python tables verbatim (types, defaults, NOT NULL, composite PK on trust, four indexes) plus `settings(name text pk, value text not null)` and `rate_events(scope text, key integer, at_ms integer)` with index `(scope, key, at_ms)`.
- [ ] `config.js`: every constant from `config.py` with its default (no env), plus `TYPESAFE_BASE_URL = "https://api.typesafe.ai"`.
- [ ] `settings.js`: `get(name) -> string|null`, `set(name, value)`.
- [ ] Tests: schema creates all tables; clock `stamp` format and `parse` round-trip, `parse("garbage") === null`, parse accepts `+00:00` and `Z`.
- [ ] Run `npm test`; commit "Serverless skeleton: schema, sdk fakes, clock".

### Task 2: Pure core (verdict, policy, gate, state, tiers, texts, cards)

**Files:** Create `tgcloud/lib/texts.js` (generated from `texts.py` by `tools/gen_texts.py`, committed), `tgcloud/lib/core/{verdict,policy,gate,state,tiers,cards}.js`, `tgcloud/lib/html.js` (`escape`, `trim`). Tests: port `test_policy`, `test_gate`, `test_state`, `test_tiers`, `test_cards`, `test_config` (the "every key in every language" check).
- [ ] `t(key, lang="en", kwargs)` implements `str.format` for `{name}` and `{{`/`}}`.
- [ ] `state.js`: `_domain` reimplements `urlparse(...).netloc.lower()` (text between `//` and the first of `/?#`; `""` when brackets are unbalanced), strips `www.`; regexes with `gi`.
- [ ] Port tests file for file, same case names. Run; commit.

### Task 3: Storage (db helpers, chats, trust, reviews, audit, billing)

Port each `storage/*.py` to `tgcloud/lib/storage/*.js` with the same SQL, using `db.run/get/all(sql\`...\`)`. `record_payment` keeps ledger-then-credit as two separate statements. Tests: port `test_chats`, `test_trust`, `test_reviews`, `test_billing`. Commit.

### Task 4: Telegram-facing core (guards, bot adapter, ratelimit, offer, jev, pipeline, actions, notices, html_text)

- [ ] `ratelimit.js`: `new RateLimiter(scope, perMinute).allow(key)` async, over `rate_events` (delete key's rows older than 60 s, count, insert if under budget).
- [ ] `jev.js`: `TypeSafeJevClient({apiKey?, model, timeout}).classify(state)` — key from `settings` (`typesafe_api_key`) when not given; POST `/v1/systemone`; one retry on 408/429/5xx/network; `AbortController` timeout; maps answers to `Verdict`; `JevError`. `FakeJevClient` moves to `test/fakes/jev.js`.
- [ ] `html_text.js`: `htmlText(text, entities)` for bold, italic, underline, strikethrough, spoiler, code, pre (with language), text_link, text_mention, blockquote, expandable_blockquote, custom_emoji; other types plain; nested entities; UTF-16 offsets; escapes text.
- [ ] Port `pipeline`, `actions`, `notices`, `offer`. Tests: port `test_jev` (wire format against scripted fetch), `test_pipeline`, `test_actions`, `test_notices`, `test_offer`, plus `ratelimit` and `html_text` tests. Commit.

### Task 5: Handlers and dispatch

- [ ] `tgcloud/lib/handlers/{group,admin,review,payments}.js` port the routers' functions. `tgcloud/lib/dispatch.js`: `dispatchMessage(message)`, `dispatchCallback(query)`, `dispatchPreCheckout(q)`, `dispatchMyChatMember(u)` reproducing aiogram's order and filters (payments → admin[private] → review → group[group/supergroup]; commands match `/cmd` or `/cmd@<bot username>` case-sensitively at the start of `text` only; `/start` accepts arguments).
- [ ] `tgcloud/handlers/{message,callback_query,pre_checkout_query,my_chat_member}.js`: call dispatch inside try/catch that logs.
- [ ] Group messages run `reviews.purgeExpired()` best-effort before the pipeline (replaces the housekeeping loop).
- [ ] Tests: port `test_group_handler`, `test_admin_handler`, `test_review_handler`, `test_payments_handler`, `test_flow`; `test_startup` becomes a test that `ops_set_commands` sends the same four commands. Commit.

### Task 6: Ops endpoints and migration tool

- [ ] `tgcloud/lib/ops.js`: `requireOps(ctx)` throws `EndpointError('forbidden')` unless `ctx && ctx.ops === true && !ctx.initData`.
- [ ] `endpoints/ops_set_secret.js` (`{name, value}` → settings; returns `{ok: true}` only), `ops_import.js` (`{table, rows}`; whitelisted tables and columns; `INSERT ... ON CONFLICT DO NOTHING`; returns `{inserted}`), `ops_counts.js`, `ops_set_commands.js`, `ops_classify.js` (`{text}` → verdict).
- [ ] `tools/migrate_from_sqlite.mjs <db>`: reads each table with `node:sqlite`, batches rows (≤ 24 KB of JSON5 per call, Windows command-line safe), calls `npx tgcloud run endpoints/ops_import <json> --ctx "{ops:true}"` via `execFileSync`, then `ops_counts` and compares.
- [ ] Tests: guard refuses HTTP-shaped ctx; import is idempotent and preserves ids; tool's batching function. Commit.

### Task 7: CI, docs, removal of Python

- [ ] `.github/workflows/deploy.yml`: Node 22, `npm ci`, `npm test`; deploy job on master: `npx tgcloud push --force` with `TGCLOUD_TOKEN`, skipped with a summary when the secret is missing.
- [ ] README: deployment section, 7-day erasure wording, ops commands. `.env.example`, `Dockerfile`, `docker-compose.yml`, `*.py`, `core/`, `handlers/`, `storage/`, `tests/`, `pytest.ini`, `requirements*.txt` removed. `tools/gen_texts.py` removed after `texts.js` is generated (texts are edited in JS from now on).
- [ ] `npm test` green; commit.

### Task 8: Cutover (needs the owner)

Follow the spec's Cutover section. Owner provides: Serverless enabled, `tgcloud login`, the VPS database copy, the TypeSafe key.
