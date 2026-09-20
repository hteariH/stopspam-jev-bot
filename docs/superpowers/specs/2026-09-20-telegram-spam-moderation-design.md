# Telegram Spam & Scam Moderation Bot — Design

- **Date:** 2026-09-20
- **Bot:** `@StopSpam_jev_bot`
- **Status:** Approved design, not yet implemented

## Problem

Public Telegram groups are flooded with unsolicited promotion and outright fraud:
fake earnings schemes, crypto giveaways, phishing links, impersonated support
accounts. Keyword blocklists miss rephrased spam and punish legitimate messages
that happen to contain a link. Human admins cannot watch a busy group around the
clock.

## Goal

A reusable, publicly available moderation bot that any group admin can add. It
deletes high-confidence spam and scam messages automatically, escalates
everything uncertain to human admins, and never acts when it is unsure.

## Non-goals

- Toxicity, harassment, off-topic or rule-enforcement moderation. Spam and scam only.
- Assistant features: answering questions, summarising, welcoming new members.
- A web dashboard. All configuration happens inside Telegram.
- Moderating media content itself. Images and video are judged by their caption
  and metadata, not by their pixels.

## Key decisions

| Decision | Choice |
|---|---|
| Classifier | Jev (TypeSafe System One), hosted API. No local model. |
| Enforcement | Auto-delete above a high confidence bar; grey zone goes to admins. |
| Coverage | Trust-based: new and low-history users are checked; trusted users are re-checked on triggers. |
| Admin surface | Inline menu in DM with the bot, review cards in a linked log chat. |
| UI language | English, with Russian as a per-chat option. |
| Storage | SQLite. |
| Hosting | VPS, deployed from GitHub Actions. |

### Why Jev rather than a local model

Jev returns typed decisions with *calibrated* confidence: higher confidence means
higher accuracy, consistently. Automated moderation lives or dies on knowing when
the model is unsure, and a chat-tuned local model does not provide that — it is
confident either way. Jev also answers in 70–500 ms at $0.042 per million input
tokens with free output, which makes per-message checking across many groups
practical. A locally hosted 27B model at roughly 3 tokens per second does not.

The cost is a hard dependency on a third-party API and on network availability.
This is accepted: the bot runs on a VPS, and every failure path degrades to
"do nothing" rather than to a wrong deletion.

## Architecture

```
handlers/       Telegram updates, admin DM menu, review-card callbacks
core/gate.py    Decides whether a message needs checking at all
core/state.py   Builds the structured state payload for Jev
core/jev.py     The only module that talks to the TypeSafe API
core/policy.py  Pure function: probabilities in, decision out
core/actions.py Executes the decision against Telegram
storage/        SQLite: chat config, trust ledger, review queue, audit log
```

Message path: **update → gate → state → Jev → policy → action**.

Two boundaries carry the design:

- `core/policy.py` is pure. It knows nothing about Telegram or HTTP, takes model
  outputs and chat thresholds as arguments, and returns a decision. Thresholds can
  therefore be tuned and regression-tested against a recorded corpus without a
  network or a bot running.
- `core/jev.py` is the single network seam. Tests substitute a fake with recorded
  responses, so every other module is testable offline.

## Jev integration

### Questions

TypeSafe's guidance is to ask atomic questions and combine them in code rather
than asking one broad question and hoping. All questions are evaluated in
parallel against the same state in a single call, so the extra questions cost
almost nothing in latency.

| Key | Type | Instruction |
|---|---|---|
| `is_spam` | Noul | The message is unsolicited promotion, advertising, or mass-posted content. |
| `is_scam` | Noul | The message attempts to defraud the reader: fake earnings, crypto giveaways, phishing, impersonated support, credential or seed-phrase requests. |
| `solicits_contact` | Noul | The message pushes the reader to move to a private message or an external channel. |
| `looks_like_member` | Noul | This reads as an ordinary message from a community member. |
| `kind` | Choice | Which category best describes the message: `crypto`, `job_mule`, `phishing`, `porn`, `channel_promo`, `impersonation`, `none`. |
| `severity` | Score | `0` — harmless self-promotion · `1` — clear unsolicited spam · `2` — active fraud attempt. |

`looks_like_member` is a deliberate counterweight. Asking only "is this bad?"
biases the decision toward acting; a question that can argue the other way pulls
borderline community chatter back out of the delete band.

`kind` does not feed the risk score. It labels the review card and the stats, so
an admin can see at a glance what kind of spam a group is getting.

### State payload

Jev is built for structured program state, so the state is a compact structured
document rather than raw text:

- message text (truncated to 2000 characters)
- link domains, count of links, presence of a Telegram invite link
- forwarded flag and forward origin type
- media type and whether the text is a caption
- author signals: messages already sent in this group, days since joining,
  whether a username is set
- group context: title and description, so that "selling a guitar, 200 euro" is
  not spam in a marketplace group

Author and group signals are included because identical text means different
things from a five-year member and from an account that joined ninety seconds
ago.

## Decision policy

All numbers live in per-chat config; the values below are defaults.

```
base = max(is_spam, is_scam)
sev  = severity.score / 2.0
risk = clamp(0.60*base + 0.30*sev + 0.10*solicits_contact - 0.25*looks_like_member, 0, 1)
```

- **Delete** — `risk >= 0.90` **and** `severity.score >= 1` **and**
  `severity.confidence >= 0.75` **and** `looks_like_member <= 0.30`
- **Review** — `risk >= 0.55`
- **Ignore** — otherwise

Automatic deletion is gated on `severity.confidence`, not on the probability
alone. When Jev reports that it is uncertain, the message goes to a human
regardless of how high the raw risk looks. This is the single property that the
whole choice of model rests on.

### Guards outside the model

These are hard-coded and cannot be configured away:

- Administrators and group owners are never acted upon.
- Allowlisted users are never acted upon.
- If the bot lacks delete permission, any delete decision degrades to a review card.
- **Observation mode.** For its first 7 days in a new group the bot only posts
  review cards and deletes nothing. Admins see the quality of its judgment on
  their own traffic before they enable enforcement, and enabling it is their
  explicit action.
- Per-group rate limit on enforcement actions, so a raid cannot turn the bot into
  a flood source and get it banned.

## Trust ledger

Checking every message from every member would spend most calls on people who
have never spammed. Checking only messages with triggers would miss plain-text
fraud that carries no link.

A member is checked until they have posted **5** clean messages in that group
(configurable), after which they are trusted and produce no API calls. Trust is
not permanent — a trusted member is re-checked when:

- the message contains a link, an invite link, a forward, or media with a caption
- they have been silent for more than 30 days

That is the defence against a compromised long-standing account: the trigger set
still applies to everyone. A user who has been flagged once is checked forever.

## Data model

```sql
CREATE TABLE chats (
  chat_id            INTEGER PRIMARY KEY,
  title              TEXT,
  mode               TEXT    NOT NULL DEFAULT 'observe',  -- observe | active
  delete_threshold   REAL    NOT NULL DEFAULT 0.90,
  review_threshold   REAL    NOT NULL DEFAULT 0.55,
  confidence_floor   REAL    NOT NULL DEFAULT 0.75,
  trust_after        INTEGER NOT NULL DEFAULT 5,
  log_chat_id        INTEGER,
  lang               TEXT    NOT NULL DEFAULT 'en',
  jev_enabled        INTEGER NOT NULL DEFAULT 1,
  observe_until      TEXT,
  created_at         TEXT    NOT NULL
);

CREATE TABLE trust (
  chat_id         INTEGER NOT NULL,
  user_id         INTEGER NOT NULL,
  clean_count     INTEGER NOT NULL DEFAULT 0,
  status          TEXT    NOT NULL DEFAULT 'unknown', -- unknown | trusted | flagged | allowlisted
  joined_at       TEXT,
  last_checked_at TEXT,
  PRIMARY KEY (chat_id, user_id)
);

CREATE TABLE reviews (
  id           INTEGER PRIMARY KEY,
  chat_id      INTEGER NOT NULL,
  message_id   INTEGER NOT NULL,
  user_id      INTEGER NOT NULL,
  text         TEXT,
  verdict_json TEXT    NOT NULL,
  risk         REAL    NOT NULL,
  decision     TEXT,            -- delete_ban | delete | not_spam
  decided_by   INTEGER,
  decided_at   TEXT,
  created_at   TEXT    NOT NULL,
  expires_at   TEXT    NOT NULL
);

CREATE TABLE audit (
  id         INTEGER PRIMARY KEY,
  chat_id    INTEGER NOT NULL,
  user_id    INTEGER NOT NULL,
  message_id INTEGER,
  risk       REAL,
  action     TEXT NOT NULL,      -- deleted | reviewed | ignored | degraded | failed
  reason     TEXT NOT NULL,
  model      TEXT,
  created_at TEXT NOT NULL
);
```

`audit` deliberately stores no message text: it exists to answer "why did the bot
act", which the risk value and reason cover. `reviews` does store text, because a
card without the message is useless to an admin, and rows expire after 7 days.

## Admin surface

In DM with the bot, an admin sees their groups and an inline menu per group:
mode, thresholds, log chat, language, and a switch that disables Jev entirely.
Admin rights are verified against Telegram every time the menu opens, never read
from the local database.

A review card is posted to the linked log chat (or to the admin's DM if no log
chat is set) containing the message text, its author, the per-question breakdown
of the verdict — so the admin can see *why* it fired — and three buttons:
**Delete & ban · Delete · Not spam**.

"Not spam" allowlists the user and records the case as a false positive. These
decisions accumulate into a locally labelled corpus paired with the stored model
verdicts, which turns future threshold tuning into a measurement against real
data rather than another guess.

## Failure handling

The governing rule: **any uncertainty resolves to not deleting.**

- Jev timeout (2 s budget), network failure, or invalid key — the message is left
  alone. If it carried triggers it becomes a review card; otherwise it is logged.
- Rate limiting — exponential backoff, and while degraded only trigger-bearing
  messages are checked.
- Telegram flood limits — throttling middleware.
- Join raids — checks are batched and enforcement is capped per group per minute.

## Privacy

The bot sends messages from other people's groups to a third-party API in the
United States. This is stated plainly in the bot description, in the README, and
behind a `/privacy` command. Admins can switch Jev off per chat. Message text is
retained only in the review queue and only for 7 days.

## Testing

Test-driven throughout.

- `core/policy.py` — a threshold table covering each band and each guard. No network.
- `core/jev.py` — behind an interface; tests use a fake with recorded responses over
  two fixture sets, real spam and ordinary conversation.
- `core/gate.py` — a trusted, silent member must produce no API call; a trusted
  member posting a link must.
- Handlers — aiogram test utilities, following the pattern in
  `feedback-bot/tests/test_flow.py`.

## Configuration and deployment

Secrets in `.env`: `BOT_TOKEN`, `TYPESAFE_API_KEY`. Dockerfile and
docker-compose following `feedback-bot`, deployed to the VPS from GitHub Actions.

## Open items

- The TypeSafe API key is pending: the account is created but early access has not
  yet been granted. Everything except live classification can be built and tested
  against the fake client in the meantime.
- Initial thresholds are set by judgment. Observation mode on the first real
  groups produces the labelled corpus that replaces the guesses with measurements.
