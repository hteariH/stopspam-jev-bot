# StopSpam

StopSpam is a Telegram bot that removes spam and scam messages from group
chats. It runs as [@StopSpam_jev_bot](https://t.me/StopSpam_jev_bot).

## What it does, and what it does not

The bot looks for two things: **unsolicited spam** (advertising, mass-posted
promotion, channel/bot pushing) and **scam** (fake earnings, crypto
giveaways, phishing, impersonated support, requests for credentials or a
seed phrase). That is the whole scope.

It does not moderate toxicity, insults, off-topic chatter, or anything else
a group's own rules might cover. It does not enforce house rules a human
admin would need to interpret. If a message is rude but not spam or a scam,
the bot leaves it alone.

It also does not check everyone all the time. Members who have posted
cleanly in the group for a while stop being checked at all, and only fall
back under review if they trigger something suspicious (a link, an invite,
a forward, a long silence followed by a reappearance) or go quiet and come
back. New members, and anyone who has already been flagged, are checked on
every message. This keeps the bot's attention, and what it sends to the
classifier, limited to the traffic it exists to catch.

## What it costs

Groups of **200 members or fewer use the whole bot for free**, including
automatic deletion, with no time limit.

Above that, automatic deletion needs a subscription, paid in Telegram
Stars from the `/chats` menu:

| Members | Price |
|---|---|
| up to 200 | free |
| 201 – 1000 | 50 ⭐ per 30 days |
| over 1000 | 250 ⭐ per 30 days |

A group that grows past 200 gets **14 days of full enforcement for free**
before anything changes, and is told when that starts and before it ends.

Without a subscription the bot does not switch off. It still checks every
message it would have checked, still writes its audit log, and still sends
review cards to the admins — it just does not delete anything itself. The
card says so, and carries the button to change it.

Nothing about payment changes how a message is judged. The classifier, the
thresholds, the confidence floor and the guard that admins are never acted
upon are identical on every tier. Payment gates what may be done about a
message, never the judgment of it.

Subscriptions renew every 30 days and can be cancelled at any time in
Telegram under Settings → My Stars → Subscriptions. The price is fixed when
you subscribe and does not change if the group grows.

## The first 7 days: observation only

When the bot is added to a new group, it spends its first 7 days in
**observation mode**. During that window it classifies messages exactly as
it normally would, but it never deletes anything or bans anyone — it only
records what it would have removed, in the same review queue an admin would
otherwise act on by hand. This gives an admin a chance to look at the
bot's calls in their own group before trusting it with delete and ban
rights, rather than being asked to trust it on faith from the first message.

After the observation window, enforcement is the admin's explicit decision:
switch the chat to active mode with `/chats` in a private message to the
bot. Nothing about crossing day 7 turns enforcement on by itself. A chat can
also be put back into observe mode at any time, and classification itself
can be switched off entirely per chat.

The bot speaks **English, Russian and Ukrainian**, set per chat from the same
menu. English is the default and the fallback: a string with no translation
appears in English rather than blank, and a test fails the build if any string
is missing from any language.

## Where review cards go

Everything the bot is unsure about becomes a **review card**: the message
text, its author, why the bot fired, and buttons to delete, delete and ban,
or mark it as not spam. A card quotes the message it is about, so it is
never posted into the group being moderated — that would republish the spam
to everyone and hand every member the moderation buttons.

Cards go to a private destination instead:

- When you add the bot to a group, cards for that group go to **your** direct
  messages with it, from the first message onwards.
- Another admin can take the queue over from the `/chats` menu, which points
  that group's cards at their own direct messages.
- To send cards to a dedicated moderator group instead, add the bot there and
  run `/setlog` in it. Every group you administer that the bot knows you are
  in will post its cards there from then on. You must be an admin of both the
  moderator group and the groups being redirected.

Telegram will not let a bot open a conversation with you, so if cards are
going to your direct messages, open a chat with the bot and press **Start**
once. Until you do, it cannot deliver them.

If a group somehow has no destination, the card is skipped and the reason is
logged. The bot does not fall back to the group itself. The audit row still
records what was decided, so nothing is lost silently.

## How it decides

Every checked message is sent to the TypeSafe Jev API, which answers a
small set of questions about it (is it spam, is it a scam, does it try to
move the conversation off-platform, does it read like an ordinary message
from a member, what category it falls into, how severe it is) and returns,
for each answer, a **calibrated confidence** alongside the answer itself.
Those answers are combined into a single risk score in `tgcloud/lib/core/policy.js`.

Automatic deletion is gated on that calibrated confidence, not on the raw
risk score. A message only gets deleted automatically when the risk score
clears the delete threshold *and* the classifier's confidence in its own
severity judgment clears a separate confidence floor. A message that scores
as risky but where the classifier itself is unsure is routed to a human
review queue instead of being deleted — the bot would rather ask an admin
than act on a guess it isn't confident in.

The thresholds that drive this (`delete_threshold`, `review_threshold`,
`confidence_floor` in `tgcloud/lib/config.js`, adjustable per chat with `/chats`) are
currently set by judgment, not by measurement against a labelled dataset.
There is no accuracy number to quote here yet — the review queue exists in
part to build that evidence over time, and the thresholds should be revisited
once it does.

## What is sent to TypeSafe, and why

To classify a message, the bot sends its text and some metadata (link
domains, whether it was forwarded, how long the author has been in the
group) to the TypeSafe Jev API, which is operated in the United States.
Message text leaving the group and crossing to a US-based API is the plain
cost of getting a message classified; there is no way around it while
TypeSafe does the classification.

Exactly these messages are sent, and no others:

- every message from a member who has not yet posted 5 clean messages in
  that group (the number is per-chat and an admin can change it);
- every message from a member who has been flagged in that group before —
  that does not stop;
- any message containing a link, a Telegram invite link, a forward, or a
  caption on media, from anyone, however long they have been in the group;
- the next message from a trusted member who has been silent for more than
  30 days.

Messages from the group's admins and owners are never sent, nor are messages
from anyone an admin has marked as not spam, nor messages with neither text
nor a caption (joins, pins, photos with no caption).

Message text is stored in the review queue for at most 7 days and then
erased. The bot runs on Telegram Serverless, which has no timers, so the
erasing happens on the way past: every update the bot handles — a message in
any group, a button press, a payment — first clears expired text from every
chat, and storing new text does the same. On a bot that sits in active groups
that is far more often than the hourly pass it replaced; text would outlive
its 7 days only if the bot received no update at all from anyone after they
were up. The human decision recorded against a message is kept, but not the
text itself. The audit log the bot keeps for every evaluation never stores
message text at all.

One thing the bot keeps forever: when someone pays for a group, it records
who paid, for which group, when, and the Telegram charge id, alongside the
member count it caches per chat. That ledger is append-only and nothing ever
deletes from it, because a disputed or refunded charge cannot be looked up
without it — Telegram sends no "payment revoked" update, so this is the only
record that will exist.

Any admin can turn classification off for their chat at any time with
`/chats`. This section is meant to match exactly what the bot's own
`/privacy` command tells an admin in Telegram — if the two ever disagree,
that is a bug in one of them.

## How it runs

The bot runs on [Telegram Serverless](https://core.telegram.org/bots/serverless):
plain JavaScript modules in `tgcloud/`, executed by Telegram next to the Bot
API, with a SQLite database the platform hosts. There is no server, container
or webhook to manage.

```
tgcloud/
  schema.js        the database tables
  handlers/        one file per Telegram update type; all four route through lib/dispatch.js
  endpoints/       ops_* one-off operations, run with `tgcloud run` (see below)
  lib/             everything else: core/ (moderation), storage/, handlers/, texts.js
```

The modules may import only the platform SDK (`sdk`, `sdk/db`) and each
other; there are no npm packages at runtime.

### Deploying

Pushing to `master` runs the tests and then `tgcloud push`, given a
`TGCLOUD_TOKEN` repository secret (the project token from @BotFather →
Bot → Serverless). By hand, from the project root:

```
npm ci
npx tgcloud login     # once per machine
npx tgcloud push
```

Always run `npm ci` first. The CLI is the pinned `@tgcloud/cli` dev
dependency; without it installed, `npx tgcloud` would download the unrelated
npm package that happens to be called `tgcloud`.

Schema changes are never applied by a push. After changing
`tgcloud/schema.js`, read what `npx tgcloud push` reports and apply it with
`npx tgcloud migrate`.

### Settings and one-off operations

The platform has no environment variables. Thresholds, prices and limits are
constants in `tgcloud/lib/config.js`. The TypeSafe API key lives in the
database and is written once:

```
npx tgcloud run endpoints/ops_set_secret '{value: "YOUR_TYPESAFE_KEY"}' --ctx '{ops: true}'
npx tgcloud run endpoints/ops_classify '{text: "buy crypto now"}' --ctx '{ops: true}'
npx tgcloud run endpoints/ops_set_commands '{}' --ctx '{ops: true}'
```

The second line checks the key and the classifier from inside the platform;
the third sets the bot's command menu. The `ops_*` endpoints refuse to run
unless called through an authenticated `tgcloud run` with `{ops: true}`;
called from a Mini App, they do nothing.

Moving data from the old SQLite file: `node tools/migrate_from_sqlite.mjs
stopspam.db` (add `--dry-run` to only count). It is safe to re-run.

## Running the tests

```
npm ci
npm test
```

The tests run every module against stand-ins for the platform SDK (an
in-memory `node:sqlite` database built from `tgcloud/schema.js`, a recording
Bot API, a scripted `fetch`), so they need Node 22.13+ and no network, no bot
token and no TypeSafe key.
