# Chat settings as a Mini App

Date: 2026-11-23. Status: design approved in chat, spec awaiting review.

## Goal

Replace the inline `/chats` menu (one message per chat, ±0.05 buttons, every
press re-renders the whole message) with a Mini App hosted by Telegram
Serverless next to the bot. The first version covers chat settings only:
everything `/chats` does today, plus the two settings that exist in the
database but have no buttons (`confidence_floor`, `trust_after`).

## Decisions

| Question | Decision |
|---|---|
| Scope of v1 | Chat settings only. Statistics, the review queue and choosing a moderator group are out of scope. |
| Old `/chats` menu | Removed. `/chats` replies with a single `web_app` button; the bot's menu button opens the same app. |
| Front-end stack | Vite + Preact, built into `dist/`, hosted by `tgcloud push`. |
| Saving | Per control, no Save button. Switches save on tap, sliders on release. Optimistic UI with rollback on error. |
| Authorization | `ctx.initData.user.id`, verified by the platform; admin rights re-checked against Telegram on every call, never trusted from the `chats` table. |

## Architecture

```
app/                      Vite + Preact source (index.html, src/)
dist/                     build output, git-ignored, deployed as static
tgcloud/endpoints/app_*   Mini App endpoints
tgcloud/lib/app.js        requireUser guard, field validation, chat view
tgcloud/lib/core/admins.js  adminChats + the shared /chats rate limiter
```

- `tgcloud.jsonc`: `"static": { "source": "dist", "immutable": ["/assets/*"] }`.
- The app is served at `https://app8792794574.tgcloud.ai/`; endpoints answer
  on the same host under `/api/`. The front-end calls them only through
  `Telegram.WebApp.Serverless.call`.
- `npm run build` builds `app/` into `dist/`; `npm run deploy` = build + push.
  The CI deploy job gains a build step before `tgcloud push --force`, since
  push never builds: without a fresh `dist/` it would deploy a stale or missing site.
- Vite and Preact are devDependencies; nothing from npm reaches `tgcloud/`.

## Endpoints

All three start with `requireUser(ctx)`.

| Endpoint | Input | Returns |
|---|---|---|
| `app_chats` | `{}` | `{ chats: [{ chat_id, title, mode, observe_days_left, plan }] }` for chats the caller administers |
| `app_chat` | `{ chat_id }` | the chat view (below) |
| `app_update` | `{ chat_id, fields }` | the chat view after the change |

**Chat view:** `chat_id, title, mode, observing, observe_days_left,
jev_enabled, delete_threshold, review_threshold, confidence_floor,
trust_after, lang, cards` (`{ kind: 'me' | 'dm' | 'group' | 'unset', id }`,
where `me` means this caller's DM), `plan` (`{ kind: 'free' | 'subscribed' |
'grace' | 'none', days, members, limit }`), `subscribe_url` (an invoice link
or `null`, from `offer.subscribeLink` under the same condition `withOffer`
uses today), `subscribe_stars`.

**`app_update` fields** (any subset; anything else is `INVALID`):

| Field | Rule |
|---|---|
| `mode` | `'active'` or `'observe'` |
| `end_observe` | `true` only: sets `mode: 'active', observe_until: now` (today's `gonow`) |
| `jev_enabled` | boolean |
| `delete_threshold`, `review_threshold`, `confidence_floor` | number in [0, 1], a multiple of 0.05 (checked after rounding to 4 places) |
| `trust_after` | integer in [0, 50] |
| `lang` | one of `LANGS` |
| `log_to_me` | `true` only: sets `log_chat_id` to the caller's id. `log_chat_id` itself is never accepted. |

After applying the fields, `review_threshold <= delete_threshold` must hold
on the resulting values, or the whole update is refused with `INVALID` and
nothing is written.

## Security

- `requireUser(ctx)` refuses any call without `ctx.initData.user.id`. Ops
  endpoints keep `requireOps`, which refuses calls *with* `initData`, so each
  endpoint is reachable from exactly one side. The "every endpoint file is
  guarded" test is extended: ops endpoints must refuse Mini App calls, app
  endpoints must refuse calls without init data, and every file in
  `endpoints/` must be in one of the two lists.
- `app_chat` and `app_update` call `guards.isAdmin(bot, chat_id, user)` before
  reading the chat from storage, as `onConfig` does, so a non-admin cannot
  learn whether a chat id is known to the bot. Failure → `NOT_ADMIN`.
- `app_chats` uses `adminChats` (≤ `MAX_MENU_CHATS` candidates, each
  verified with `getChatMember`) and the `CHATS_PER_MINUTE` limiter, moved
  from `handlers/admin.js` into `lib/core/admins.js`. Over the limit →
  `RATE_LIMITED`. `app_chat`/`app_update` cost one `getChatMember` each and
  get their own per-user limiter (30 per minute).
- Error codes: `NOT_ADMIN`, `RATE_LIMITED`, `INVALID`, `NOT_FOUND` (admin of
  a chat the bot has no row for). Any other exception reaches the client as
  the platform's generic error and is logged.

## Bot side

- `/chats` sends one message with an inline `web_app` button
  (`t('btn_open_settings')`) pointing at the app URL. The URL lives in
  `config.js` as `APP_URL`.
- `ops_set_commands` additionally calls `setChatMenuButton` with a
  `web_app` button to the same URL, so the menu button needs no manual
  BotFather step.
- `menu()`, `onConfig`, `parseCallback` and the `cfg:` route are removed.
  A `cfg:` press from an old menu message is answered with an alert
  `t('menu_moved')` ("Settings moved: send /chats").
- Texts `welcome`, `help` and `privacy` keep saying `/chats`; they stay true.

## Front-end

Two screens, navigation with `Telegram.WebApp.BackButton`.

1. **Chat list.** One card per chat: title and a badge (`active`,
   `observe · N days left`, or `no subscription` when `plan.kind === 'none'`).
   Empty state explains how a chat gets listed: add the bot, make it an
   admin, and post once in the group (what `candidateChatIds` requires).
2. **Chat settings**, in sections:
   - Moderation: Active/Observe segmented control, Jev switch, "Start
     deleting now" (only while observing, confirmed with `showConfirm`).
   - Thresholds: three sliders (step 0.05, value shown) and a stepper for
     `trust_after`, each with a one-line hint.
   - Cards: where they go now, in words; a "Send to me" button unless
     `cards.kind === 'me'`.
   - Bot language in this chat: en / ru / uk segments.
   - Plan: the plan line, and when `subscribe_url` is set a "Subscribe for
     N ⭐" button → `Telegram.WebApp.openInvoice(url)`; on `paid` the chat is
     reloaded.

Behaviour:
- Each control calls `app_update` with just its field. The UI shows the new
  value at once; on error it restores the server's last view and shows the
  mapped message with `showAlert`. Success gives a light
  `HapticFeedback.impactOccurred('light')`. The view returned by the server
  always replaces local state.
- Colours only from `--tg-theme-*` CSS variables, so the app follows the
  Telegram theme. `Telegram.WebApp.ready()` and `expand()` on load.
- UI language from `initDataUnsafe.user.language_code` (`ru`, `uk`, else
  `en`), strings in `app/src/i18n.js`. This is independent of the chat's
  `lang` setting.
- Error codes map to localized messages; unknown errors show "Something went
  wrong, try again".

## Testing

- Endpoints, under `node:test` with the existing fakes: refused without
  init data; non-admin can neither read nor change a chat and gets
  `NOT_ADMIN` before any storage read; every field rule above (ranges, step,
  integer, unknown fields, `log_chat_id` refused, review ≤ delete checked on
  the merged result with nothing written on refusal); `log_to_me` and
  `end_observe`; `subscribe_url` present exactly when today's menu would show
  the subscribe button; rate limits.
- Bot: `/chats` sends a single `web_app` button; a `cfg:` callback gets the
  `menu_moved` alert; `ops_set_commands` sets the menu button. The removed
  menu tests go away with the code.
- Front-end: pure modules (labels, badge, error map, i18n fallback) tested
  with plain node. Screens checked locally with Vite and a stub
  `Telegram.WebApp`, then on the platform with
  `tgcloud run endpoints/app_chats '{}' --ctx '{initData:{user:{id:<owner>}}}'`
  and finally by the owner in Telegram.

## Out of scope

Per-chat statistics, the review queue in the app, picking a moderator group
from a list (`/setlog` stays), any schema change.
