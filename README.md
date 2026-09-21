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

If a group somehow has no destination, the card is skipped and the reason is
logged. The bot does not fall back to the group itself. The audit row still
records what was decided, so nothing is lost silently.

## How it decides

Every checked message is sent to the TypeSafe Jev API, which answers a
small set of questions about it (is it spam, is it a scam, does it try to
move the conversation off-platform, does it read like an ordinary message
from a member, what category it falls into, how severe it is) and returns,
for each answer, a **calibrated confidence** alongside the answer itself.
Those answers are combined into a single risk score in `core/policy.py`.

Automatic deletion is gated on that calibrated confidence, not on the raw
risk score. A message only gets deleted automatically when the risk score
clears the delete threshold *and* the classifier's confidence in its own
severity judgment clears a separate confidence floor. A message that scores
as risky but where the classifier itself is unsure is routed to a human
review queue instead of being deleted — the bot would rather ask an admin
than act on a guess it isn't confident in.

The thresholds that drive this (`delete_threshold`, `review_threshold`,
`confidence_floor` in `config.py`, adjustable per chat with `/chats`) are
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

Only messages from users without an established history in the group are
sent, plus messages containing links, forwards, or media captions — see
"What it does, and what it does not" above for exactly when that applies.

Message text is stored in the review queue for at most 7 days and then
erased automatically (`bot.py` runs an hourly housekeeping pass that clears
expired text); the human decision recorded against it is kept, but not the
text itself. The audit log the bot keeps for every evaluation never stores
message text at all.

Any admin can turn classification off for their chat at any time with
`/chats`. This section is meant to match exactly what the bot's own
`/privacy` command tells an admin in Telegram — if the two ever disagree,
that is a bug in one of them.

## Self-hosting

The bot needs two secrets and refuses to start without both:

```
BOT_TOKEN=          # from @BotFather
TYPESAFE_API_KEY=   # from TypeSafe
DB_PATH=stopspam.db # optional, defaults to stopspam.db
```

Copy `.env.example` to `.env` and fill those in, then:

```
docker compose up
```

This builds the image, runs the bot with `DB_PATH` pointed at a volume
(`./data`), and restarts it unless you stop it. Message data lives entirely
in that SQLite file on the volume; there is no other datastore.

To run it directly instead of in Docker, install `requirements.txt` into a
Python 3.10+ environment and run `python bot.py` with the same `.env` in
place.

## Running the tests

```
./.venv/Scripts/python.exe -m pytest -v
```

(or, on a platform where the virtualenv's Python is on `PATH` under a
different name, `python -m pytest -v` from inside the activated virtualenv).
The tests do not require `TYPESAFE_API_KEY` to be a real key — a fake
classifier client stands in for TypeSafe everywhere except the one module
that talks to it.
