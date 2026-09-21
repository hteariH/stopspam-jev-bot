# Telegram Stars Monetization — Design

**Date:** 2026-09-21
**Status:** approved for planning
**Supersedes nothing.** Extends
`2026-09-20-telegram-spam-moderation-design.md`, which remains the binding
authority for everything about classification and moderation. Where this
document and that one disagree about moderation behaviour, that one wins.

## What this builds

A paid tier for `@StopSpam_jev_bot`, billed in Telegram Stars, that gates
**automatic deletion** — and nothing else — behind a monthly subscription for
groups above a size threshold.

## Why not per-message pricing

The obvious model — charge per classified message with a margin over the API
cost — is arithmetically impossible, and it is worth recording why so nobody
proposes it again.

| | |
|---|---|
| TypeSafe Jev, per checked message | $0.0000168 |
| Telegram Stars payout, per star | ≈ $0.013 |
| So one star buys | ≈ 770 checks |
| A busy group, per month | ~1000 checks ≈ 1.3 stars of cost |

A 2× margin on a typical group is three stars a month — four cents. Telegram's
minimum invoice is one star, and the friction of asking a human to authorize a
recurring payment is worth far more than four cents. **The API cost is not a
meaningful input to the price.** The price is set by what a group admin will
pay for working spam removal; the resulting margin is roughly ×40–×78, and the
API cost matters only as something to watch for abuse (see *Observability*).

## Tiers

Tier is a function of the group's Telegram member count.

| Members | Tier | Price | Automatic deletion |
|---|---|---|---|
| ≤ 200 | `free` | — | yes, free, forever |
| 201 – 1000 | `small` | 50 ⭐ / 30 days | while subscribed |
| > 1000 | `large` | 250 ⭐ / 30 days | while subscribed |

**Unpaid above 200 is not "bot off".** The bot still classifies, still writes
audit rows, and still delivers review cards to the card destination. It simply
does not press delete itself; a message it would have deleted becomes a review
card with an explicit reason and a subscribe button. That card is the product's
strongest sales pitch and it costs nothing extra to produce.

Everything else in the bot — the gate, the thresholds, the confidence floor,
the 7-day observation window, `/setlog`, `/privacy`, the review queue,
allowlisting — is identical on every tier. **Nothing about payment changes how
a message is judged.** Payment changes only what may be done about it.

## Entitlement rules

### The core predicate

`core/tiers.py` is pure and holds all of it:

```python
def tier_for(member_count: int | None) -> str
def price_for(tier: str) -> int          # 0 for "free"
def entitled(tier, *, paid_until, grace_until, now) -> tuple[bool, str]
```

`entitled` resolves in this order, and the reason string it returns is what
reaches the audit row:

1. `tier == "free"` → `(True, "free_tier")`
2. `paid_until` in the future → `(True, "subscribed")`
3. `grace_until` in the future → `(True, "grace")`
4. otherwise → `(False, "not_entitled")`

### Member count is Telegram's fact, not ours

`get_chat_member_count` is an API call and cannot be made per message. The
count is cached on the chat's billing row and refreshed at most once per 24
hours, lazily, on a message the bot is already handling. **The tier is
therefore up to 24 hours stale, by design.** Nobody crosses 200 members and
gets attacked within the same day.

### Grace: 14 days, once, ever

A chat whose tier requires payment and which has never had a grace period gets
`grace_until = now + 14 days`. During it, deletion works exactly as if paid.

Two rules make this safe and honest:

- **Set once, ever.** Once `grace_until` is written it is never rewritten, not
  by a payment, not by a lapse, not by the group shrinking below 200 and
  growing back. A group oscillating around the threshold must not farm an
  unbounded series of free trials.
- **The clock starts when deletion could actually happen.** Grace is written on
  the first message where the tier requires payment *and* the chat is no longer
  inside its 7-day observation window. Starting it earlier would burn half the
  trial during a week in which the bot deletes nothing anyway, so the admin
  would evaluate a product they never saw working.

A group that is already above 200 when the bot is added gets this grace too. It
did not "cross" a line, but the 14 days serve the same purpose — it is the
trial that earns the subscription.

### The price locks at subscribe time

Telegram renews a subscription at whatever amount the invoice named. Changing
the amount requires cancelling the subscription and having the admin buy a new
one. So a group that subscribes at 800 members for 50 ⭐ and grows to 5000
**keeps paying 50 ⭐**, indefinitely.

This is deliberate. The margin at 50 ⭐ is still roughly ×40, and dunning a
paying customer over $3 is a bad trade in both money and goodwill. Re-tiering
happens only if they cancel and subscribe again, at which point the current
tier applies.

### Lapsing is passive

There is no renewal job and no expiry job. Every `successful_payment` — first
or recurring — writes `paid_until` from Telegram's own
`subscription_expiration_date`. If the admin cancels, or a renewal fails, no
further payment arrives, the timestamp falls into the past on its own, and the
chat drops to cards-only at the next message. The absence of a scheduled task
here is a feature: there is no background job that can silently die.

## Architecture

### New modules

```
core/tiers.py         pure. Imports dataclasses and datetime, nothing else.
                      Tier arithmetic and the entitled() predicate.
storage/billing.py    sqlite only. The billing row and the payments ledger.
handlers/payments.py  new router: pre_checkout_query and successful_payment.
```

### Modified

- `core/policy.py` — one new keyword argument.
- `core/pipeline.py` — accepts an `Entitlement`, passes `.active` to policy,
  logs `.tier`.
- `handlers/group.py` — `_entitlement()` beside the existing `_can_delete()`.
- `handlers/admin.py` — subscribe button and "start deleting now" button.
- `core/cards.py`, `texts.py` — the not-entitled line and button.
- `config.py`, `storage/db.py` — constants and schema.
- `bot.py` — register the payments router.

`handlers/payments.py` is registered **first**, before the admin router. No
existing router would swallow a payment — `admin.router` filters to private
chats but declares no catch-all `message` handler, and `group.router`'s
catch-all filters to group chats — so a `successful_payment` message currently
falls through every router unhandled. Registering payments first states the
dependency rather than relying on that absence staying true.

### The change to the heart of the bot

`policy.decide()` gains one keyword argument, `entitled: bool`, and one branch:

```python
if deletable:
    if observing:      return Decision(Action.REVIEW, risk, "observing")
    if not entitled:   return Decision(Action.REVIEW, risk, "not_entitled")
    if not can_delete: return Decision(Action.REVIEW, risk, "no_delete_permission")
    return Decision(Action.DELETE, risk, "high_confidence_spam")
```

Billing enters the moderation path as exactly one more reason a confident
deletion becomes a review card — the same shape as `observing` and
`no_delete_permission`, which already exist. `core/policy.py` stays pure: it
receives a bool and knows nothing about stars, tiers, or Telegram.

The precedence is deliberate: `observing` is checked **before** `not_entitled`,
so a chat inside its observation window reports "observing" rather than
advertising a subscription it does not yet need. Unpaid, not observing, no
delete permission reports `not_entitled` — the billing reason outranks the
permission one, because telling an admin to buy a subscription when the real
problem is that they never gave the bot delete rights would be a lie.

### Data model

Both tables are new, so existing databases pick them up automatically:
`storage/db.py` runs `executescript(SCHEMA)` with `CREATE TABLE IF NOT EXISTS`
on every connect. **No migration is required and none may be written.**

```sql
CREATE TABLE IF NOT EXISTS billing (
  chat_id         INTEGER PRIMARY KEY,
  member_count    INTEGER,
  member_count_at TEXT,
  grace_until     TEXT,
  paid_until      TEXT,
  payer_user_id   INTEGER,
  stars           INTEGER,
  charge_id       TEXT,
  notified_stage  TEXT,
  updated_at      TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS payments (
  telegram_payment_charge_id TEXT PRIMARY KEY,
  chat_id       INTEGER NOT NULL,
  payer_user_id INTEGER NOT NULL,
  stars         INTEGER NOT NULL,
  is_recurring  INTEGER NOT NULL DEFAULT 0,
  expires_at    TEXT,
  created_at    TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_payments_chat ON payments (chat_id, created_at);
```

`payments` is **append-only**. Telegram sends no "payment revoked" update, so
this ledger is the only record that will exist when a charge is disputed or
when `refund_star_payment` has to be called by hand. Nothing deletes from it
and nothing updates it.

`billing.charge_id` holds the most recent charge for convenience; the ledger
holds all of them.

## Payment flow

### Creating the invoice

```python
await bot.create_invoice_link(
    title=...,                       # 1-32 chars, from texts.py
    description=...,                 # 1-255 chars, from texts.py
    payload=f"sub:{chat_id}:{stars}",
    currency="XTR",
    prices=[LabeledPrice(label=..., amount=stars)],
    subscription_period=2592000,
)
```

`subscription_period` must be exactly 2592000 (30 days) — the Bot API accepts
no other value today. The maximum subscription price is 10000 ⭐, far above
either tier. A user may hold any number of concurrent subscriptions to the same
bot, so an admin who runs five paid groups holds five subscriptions, one per
group, each with its own invoice link.

The payload is `sub:<chat_id>:<stars>` — well inside the 128-byte limit even
for the longest Telegram chat id.

### Pre-checkout

Telegram gives **10 seconds** to answer a `pre_checkout_query` or the payment
fails. The handler therefore does no Telegram calls and no network work. It
validates and answers:

- payload parses as `sub:<int>:<int>` — otherwise `ok=False`
- `currency == "XTR"` — otherwise `ok=False`
- `total_amount` equals the payload's star count and is one of the known tier
  prices — otherwise `ok=False`

It deliberately does **not** re-check that the payer is an admin of the chat.
That would cost a Telegram round-trip against a 10-second deadline, and the
failure it would prevent — somebody paying for a group they do not administer —
is a gift, not an attack.

`answer_pre_checkout_query` is wrapped in `try/except TelegramAPIError` like
every other Telegram call in the codebase; a failure is logged, not raised.

### Successful payment

Arrives in the payer's private chat with the bot. In order:

1. `INSERT OR IGNORE` the ledger row keyed on `telegram_payment_charge_id`. If
   nothing was inserted, this update is a **redelivery** — log it and return
   without touching `billing`. Telegram can and does redeliver updates, and
   without this guard one payment would grant 60 days.
2. Upsert `billing`: `paid_until` from `subscription_expiration_date` when
   present, otherwise `now + 30 days`; record `payer_user_id`, `stars`,
   `charge_id`; set `notified_stage = NULL` so a future lapse can be announced
   again.
3. Confirm to the payer, in their chat's language, including how to cancel
   (Telegram's own subscription UI — the bot does not build a cancel flow).

**A payment for a chat the bot does not know is still recorded** — both the
ledger row and the billing row are written, and a warning is logged. Money
moved; the record is not optional. The `chats` row will be created by
`ensure_chat` the next time a message arrives, and the billing row is already
waiting for it.

### Renewals need no code

A renewal is another `successful_payment` with `is_recurring=True`, its own
fresh `telegram_payment_charge_id`, and a new `subscription_expiration_date`.
The same handler, the same idempotency guard, the same upsert.

### Cancellation and refunds

Out of scope for this version. Admins cancel through Telegram's own
subscription interface, which requires nothing from the bot. Refunds are
manual, using the charge ids in the ledger and `refund_star_payment`. The bot
exposes neither a cancel command nor a refund command.

## Where the subscription is offered

Three surfaces, in increasing order of how well they convert:

1. **`/chats` menu** — the chat's line shows its tier, member count, and
   status (`free` / `subscribed until …` / `grace, N days left` / `not
   subscribed`), with a subscribe button carrying the price when one applies.
2. **Notices to the card destination**, evaluated on the same once-per-24-hours
   path as the member-count refresh, so they cost no extra work and cannot fire
   more than once a day. `notified_stage` advances forward only, so each is
   announced once: `grace` when the trial starts,
   `grace_ending` three days before it expires, `lapsed` when entitlement is
   lost. If the chat has no card destination the notice is skipped, exactly as
   review cards are.
3. **On the review card itself**, when `decision.reason == "not_entitled"`: a
   line saying the bot would have deleted this message and a subscribe button.
   This is the moment an admin is looking at real spam the bot caught and did
   not remove, which is when the value of the subscription is most obvious.

All copy is added to `texts.py` in **en, ru and uk**. The existing test that
fails the build when any string is missing from any language covers the new
keys automatically.

## Ending observation early

The 7-day observation window is currently unconditional, which means an admin
who subscribes today gets nothing for a week. `/chats` gains a button that ends
observation immediately: it sets `observe_until` to now and `mode` to `active`.

This is not a billing feature and is not gated by payment — a free group can
use it too. It is listed here because the subscription makes it necessary
rather than merely nice.

## Observability

**Every call to the paid API gets a log line naming the chat it was made for.**
Today there is none: `core/pipeline.py` logs only when Jev is *unavailable*, so
successful spend — which is all of it — is invisible in the logs and can only
be reconstructed by querying the audit table.

Added in `core/pipeline.py`, immediately after `classify()` returns, one line
per billable call:

```
INFO jev call for chat -1001234567890 (user 42, low_history, tier=large, entitled=yes) took 412 ms
```

It carries the chat id, the user, the gate reason that caused the money to be
spent, the chat's tier, and whether the chat is entitled. That is enough to
answer "which chats are costing me money and are any of them paying?" with
`grep` alone. The existing failure line already names its chat and is left
as it is, so **every** call to TypeSafe produces exactly one log line naming
its chat, whether it succeeded or failed.

A second line, at INFO, records each time enforcement was withheld for lack of
a subscription — both the conversion signal and the proof the gate works.

### Why there is no free-tier usage cap

An unpaid large group still costs money, because it is still classified in
order to produce cards. At the observed rate that is about $0.08 per busy
unpaid group per month; a thousand of them would be under $100, and they are
the conversion funnel. A cap would add a failure mode — the bot going quiet
mid-month — to defend against a cost that is currently noise.

The per-chat log line above is the instrument that makes deferring this safe:
if one chat ever starts burning calls, it will be visible by name, and a cap
can be added then against evidence instead of speculation.

## Failure rulings

Every one of these points the same way: **a billing problem must never disarm
moderation.**

| Failure | Ruling |
|---|---|
| sqlite fails on the billing read | Treat the chat as **entitled**. The verdict was sound; only the permission question failed. A lost subscription beats a group silently going unmoderated. |
| `get_chat_member_count` fails | Use the cached count. Never known at all → `free` tier. This is self-correcting: a chat with no count is brand new, so it is inside its observation window and deleting nothing regardless. |
| `create_invoice_link` fails | The `/chats` menu says so and stays usable. No exception escapes the handler. |
| Payment for an unknown chat | Record both rows anyway, log a warning. |
| Redelivered `successful_payment` | Ledger insert is ignored, `billing` untouched. |
| `answer_pre_checkout_query` fails | Logged, not raised. Telegram will fail the payment on its own. |

These follow the existing contracts in the codebase and do not relax them:
`sqlite3.Error` for storage, `TelegramAPIError` for Telegram, never a bare
`Exception`, and no unhandled exception may escape a handler.

## Testing requirements

- **`core/tiers.py`** — exhaustive over the boundaries: 0, 1, 200, 201, 1000,
  1001, and `None`. `entitled()` across every combination of paid / in grace /
  expired / absent, with an injected `now` rather than a real clock.
- **`core/policy.py`** — a verdict that would delete becomes `REVIEW` with
  reason `not_entitled` when `entitled=False`, is unaffected when `True`, and
  reports `observing` rather than `not_entitled` when both apply.
- **`storage/billing.py`** — upsert creates then updates; a renewal extends
  `paid_until`; the ledger refuses a duplicate charge id; `grace_until`
  survives a payment and a lapse unchanged.
- **`handlers/payments.py`** — a malformed payload is refused; a wrong currency
  is refused; a wrong amount is refused; a valid payment writes both rows; a
  **redelivered** payment writes neither and does not extend `paid_until`; a
  payment for an unknown chat still writes both rows.
- **Grace timing** — grace is not written while the chat is observing, is
  written on the first post-observation message, and is never rewritten
  afterwards under any sequence of tier changes.
- **The log line** — asserted by capturing the logger, because its whole
  purpose is to be greppable and a silent regression would be invisible.

Tests must exercise the code they claim to cover. A test that passes against a
deliberately broken implementation is a defect, not coverage.

## Out of scope

- A cancel command (Telegram's own UI does this).
- A refund command (manual, via the ledger).
- Re-tiering an active subscription when a group grows.
- Per-chat or global usage caps.
- Reporting the bot's Stars balance, or withdrawal.
- Any change to how a message is classified or scored. Payment gates the
  action, never the judgment.
