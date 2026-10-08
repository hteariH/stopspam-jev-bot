# Moving StopSpam to Telegram Serverless

Date: 2026-10-08. Status: approved (owner delegated the remaining decisions).

## Goal

Run @StopSpam_jev_bot on Telegram Serverless (https://core.telegram.org/bots/serverless)
instead of a Docker container on a VPS. Behaviour for users, admins and payers
does not change. The Python implementation, the Dockerfile, docker-compose and
the VPS deploy are deleted once the cutover is done.

## Decisions

| Question | Decision |
|---|---|
| Old implementation | Replaced outright (no parallel run). Data is carried over. |
| TypeSafe API key | Stored in a `settings` table, written once with `tgcloud run endpoints/ops_set_secret`. Never in git, never in module code. |
| Staging | None. Cutover goes straight to the production bot; safety comes from the ported test suite, `tgcloud run` smoke checks and a rehearsed rollback. |
| Code shape | Straight port: same modules, same function names, same logic, so the diff can be read side by side with the Python. |

## Platform facts this design relies on

From the docs and from the `@tgcloud/cli@0.2.0` package's bundled SDK reference:

- Code is plain ES-module JavaScript under `tgcloud/`, run in a V8 isolate.
  Imports: only `sdk`, `sdk/db`, `sdk/api`, `sdk/fetch` and project modules
  (relative, with `.js`). No npm, no filesystem, no env vars.
- `handlers/<update_type>.js` default export receives the payload and `ctx`
  (`ctx.update` is the raw Update). The platform sets the webhook and its
  `allowed_updates` from the deployed handlers.
- `api.<method>(params)` returns the unwrapped result, throws `BotApiError`
  (`.code`, `.description`, `.parameters`).
- `db.run/all/get(sql\`...\`)` for raw SQL; `get` returns the first row or `null`;
  `run` returns `{rowsAffected, lastInsertRowid, rows}`. Raw results are not
  mode-converted.
- `fetch` is web-like; non-2xx resolves with `ok === false`.
- No cron, no documented wall-clock limit, no runtime secrets.
- **The CLI is `@tgcloud/cli`.** The unscoped npm package `tgcloud` is an
  unrelated 2023 third-party package that logs in through MTProto. It must never
  run: `@tgcloud/cli` is pinned as a devDependency, and `npx tgcloud` is only
  run after `npm ci` in the project.

## Layout

```
package.json              devDependency @tgcloud/cli (pinned), scripts: test, deploy
tgcloud.jsonc             {"static": false}
tgcloud/
  schema.js               chats, trust, reviews, audit, billing, payments, settings, rate_events
  handlers/
    message.js            successful_payment -> payments; private -> admin; group -> setlog / pipeline
    callback_query.js     "cfg:" -> admin, "rv:" -> review
    pre_checkout_query.js payments
    my_chat_member.js     group
  lib/
    config.js             constants (former config.py defaults; no env)
    texts.js              en / ru / uk
    clock.js              now() in the exact Python format, injectable in tests
    core/*.js             one file per core/*.py
    handlers/*.js         one file per handlers/*.py (admin, group, payments, review)
    storage/*.js          one file per storage/*.py, raw SQL kept as is
    bot.js                aiogram-shaped adapter over `api` (parse_mode HTML default, cached getMe)
    html_text.js          message text + entities -> HTML (aiogram's Message.html_text)
    ops.js                guard shared by the ops endpoints
  endpoints/
    ops_set_secret.js     write a setting (TypeSafe key)
    ops_import.js         accept a batch of rows during data migration
    ops_counts.js         row counts per table, to verify the migration
    ops_set_commands.js   setMyCommands (was done at process start)
    ops_classify.js       one TypeSafe call from inside the platform (smoke test)
tools/migrate_from_sqlite.mjs  reads the VPS stopspam.db with node:sqlite, sends batches to ops_import
test/                     node:test; `sdk` replaced by fakes through a module-resolve hook
```

The four platform handlers are thin: they dispatch to the ported routers in
`lib/handlers/`, which keep aiogram's filter order (payments first, then admin,
review, group).

## Behaviour that has to change, and how

1. **Timestamps.** Every stored time is ISO text in Python's
   `isoformat(timespec="seconds")` form (`2026-10-08T21:00:00+00:00`), and SQL
   compares them as strings. `clock.now()` produces exactly that form — not
   `toISOString()` — so migrated rows and new rows compare correctly.
2. **Rate limiters** were in-memory deques; an isolate does not keep memory
   between updates. They become a `rate_events(scope, key, at_ms)` table: allow
   = delete this key's events older than 60 s, count the rest, insert if under
   budget. Same per-key sliding window, same budgets.
3. **Housekeeping loop** is gone. `reviews.purge_expired()` already runs inside
   `reviews.create()`; it also runs at the start of every group update. Text in
   a group with no traffic at all stays until that group's next update — the
   README's 7-day erasure statement is reworded to say so.
4. **TypeSafe** is called with `fetch`: `POST https://api.typesafe.ai/v1/systemone`,
   `Authorization: Bearer <key>`, body `{state, model, questions}` with the same
   six questions as plain objects. The answer maps into the same `Verdict`.
   Non-2xx, network error, timeout or unexpected shape -> `JevError`, which the
   pipeline already handles as "classifier unavailable". One retry on
   408/429/5xx (the Python SDK did two; the platform's time limit is unknown).
   Timeout via `AbortController` if the SDK's `fetch` honours `signal`;
   checked with `tgcloud run` before cutover.
5. **Missing key** -> `JevError("TYPESAFE_API_KEY is not set")`, never a crash.
6. **Startup work** (`set_my_commands`) moves to `endpoints/ops_set_commands`, run
   once after deploy.
7. **Telegram ids** fit in 52 bits, so plain JS numbers are safe.

8. **Ops modules are endpoints.** `tgcloud run` only runs modules in
   `handlers/` and `endpoints/`, so one-off operations are endpoints. Over HTTP
   an endpoint only runs with platform-verified Mini App init data, so every
   ops endpoint refuses when `ctx.initData` is present and requires
   `ctx.ops === true`, which only an authenticated `tgcloud run --ctx` can set.
   The bot has no Mini App (`"static": false`).
9. **Unhandled errors.** Each platform handler wraps its dispatch in a
   try/catch that logs and returns, as aiogram's polling loop did, so a bug
   never makes Telegram redeliver an update and repeat side effects.
10. **`query.message.html_text`** (used when a review card is edited) is
   rebuilt from text + entities in `lib/html_text.js`, offsets in UTF-16 as
   Telegram sends them.
11. **Bot identity** (`getMe`, needed for "can I delete here" and for
   `/cmd@BotName` matching) is cached in module scope and in `settings`.

Everything else — policy, tiers, gate, guards, notices, cards, offer, texts,
billing, payments idempotency by charge id — is ported line for line.

## Tests

The 295 pytest cases are ported file for file to `node:test`. A resolve hook
maps `sdk` and `sdk/db` to fakes:

- `db` backed by an in-memory `node:sqlite` database; `sql` produces the same
  named-parameter form; `table()`/column builders emit `CREATE TABLE` so
  `tgcloud/schema.js` is the single source of the schema in tests too.
- `api` records calls and can be told to throw `BotApiError` per method.
- `fetch` is scripted per test.

CI: `npm ci && npm test`, then on master `npx tgcloud push` with
`TGCLOUD_TOKEN`. Schema migrations are applied by hand with `tgcloud migrate`,
never from CI.

## Cutover

Preconditions the owner provides: Serverless enabled for the bot in BotFather;
a project token (`app<id>:<secret>`) for `tgcloud login` and for the
`TGCLOUD_TOKEN` GitHub secret; a copy of `/data/stopspam.db` from the VPS.

Handlers are what make the platform take the webhook, so they go up last,
after the data is in place:

1. `npm ci`; `npx tgcloud login`.
2. Targeted push of `schema.js`, `lib/` and `endpoints/` (no handlers -> no webhook yet);
   `npx tgcloud migrate`.
3. `tgcloud run endpoints/ops_set_secret` with the TypeSafe key; a `tgcloud run`
   of `endpoints/ops_classify` against a sample message proves fetch, the key and the
   timeout work from inside the platform.
4. Stop the VPS container. Copy `stopspam.db` locally.
5. `node tools/migrate_from_sqlite.mjs stopspam.db` (chunked, idempotent:
   inserts use `ON CONFLICT DO NOTHING`, so a rerun after a failure is safe;
   row counts are compared at the end).
6. Full `npx tgcloud push` (handlers -> webhook set);
   `tgcloud run endpoints/ops_set_commands`. Updates that arrived during steps 4-6
   were queued by Telegram (kept up to 24 h) and are delivered now.
7. Smoke: `tgcloud webhook` shows no error; `/help` in private; a test message
   in a group the owner controls lands as an audit row.

**Rollback:** `api.deleteWebhook` (via `tgcloud run`) and `docker compose up -d`
on the VPS. The VPS database is untouched by the migration, so it is still
valid, minus whatever happened on Serverless in between (payments recorded
there are listed from the `payments` table before rolling back).

The Python code, Dockerfile, docker-compose and the VPS deploy job are deleted
in the same branch: rollback does not need them in the repo, because the VPS
keeps its own copy of the last deployed build. The VPS itself is shut down by
the owner once they are satisfied.

## Out of scope

Mini App, endpoints, any behaviour change, re-tuning thresholds.
