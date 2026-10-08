import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { fresh, exec, rows, failNext } from './helpers.js';
import * as chats from '../tgcloud/lib/storage/chats.js';
import * as trust from '../tgcloud/lib/storage/trust.js';
import * as reviews from '../tgcloud/lib/storage/reviews.js';
import * as audit from '../tgcloud/lib/storage/audit.js';

beforeEach(fresh);

// --- chats ---

test('ensureChat creates a chat with the spec defaults', async () => {
  const chat = await chats.ensureChat(-100123, 'Test Group');
  assert.equal(chat.mode, 'observe');
  assert.equal(chat.delete_threshold, 0.90);
  assert.equal(chat.review_threshold, 0.55);
  assert.equal(chat.confidence_floor, 0.75);
  assert.equal(chat.trust_after, 5);
  assert.equal(chat.lang, 'en');
  assert.equal(chat.jev_enabled, true);
  assert.notEqual(chat.observe_until, null);
});

test('ensureChat is idempotent and updates the title', async () => {
  await chats.ensureChat(-100123, 'Old');
  await chats.updateChat(-100123, { delete_threshold: 0.95 });
  const again = await chats.ensureChat(-100123, 'New');
  assert.equal(again.title, 'New');
  assert.equal(again.delete_threshold, 0.95, 'ensureChat must not reset settings');
});

// Only an 'active' chat can leave observation, and only after the window.
test('the observation window expires', async () => {
  await chats.ensureChat(-100123, 'Test Group');
  let chat = await chats.updateChat(-100123, { mode: 'active', observe_until: '2020-01-01T00:00:00+00:00' });
  assert.equal(chats.isObserving(chat), false);
  chat = await chats.updateChat(-100123, { observe_until: '2999-01-01T00:00:00+00:00' });
  assert.equal(chats.isObserving(chat), true);
});

test('observe mode ignores an expired window', async () => {
  await chats.ensureChat(-100123, 'Test Group');
  const chat = await chats.updateChat(-100123, { observe_until: '2020-01-01T00:00:00+00:00' });
  assert.equal(chats.isObserving(chat), true, "mode 'observe' always observes");
});

test('active mode still observes until the window passes', async () => {
  await chats.ensureChat(-100123, 'Test Group');
  const chat = await chats.updateChat(-100123, { mode: 'active', observe_until: '2999-01-01T00:00:00+00:00' });
  assert.equal(chats.isObserving(chat), true);
});

test('updateChat refuses unknown fields and stores booleans as integers', async () => {
  await chats.ensureChat(-100123, 'G');
  await assert.rejects(chats.updateChat(-100123, { evil: 1 }), /unknown chat fields/);
  const chat = await chats.updateChat(-100123, { jev_enabled: false, lang: 'ru' });
  assert.equal(chat.jev_enabled, false);
  assert.equal(chat.lang, 'ru');
  assert.equal(rows('SELECT jev_enabled FROM chats')[0].jev_enabled, 0);
});

test('candidate chats come from the log chat and the trust ledger, capped', async () => {
  await chats.ensureChat(-1, 'A');
  await chats.updateChat(-1, { log_chat_id: 7 });
  await trust.seen(-2, 7);
  await trust.seen(-3, 8);
  assert.deepEqual((await chats.candidateChatIds(7, 20)).sort((a, b) => a - b), [-2, -1]);
  assert.equal((await chats.candidateChatIds(7, 1)).length, 1);
});

// --- trust ---

test('an unknown user returns the default row', async () => {
  const row = await trust.get(-100, 555);
  assert.equal(row.status, 'unknown');
  assert.equal(row.clean_count, 0);
});

test('a user is promoted to trusted after the threshold', async () => {
  await trust.seen(-100, 555);
  for (let i = 0; i < 4; i++) {
    assert.equal((await trust.recordClean(-100, 555, 5)).status, 'unknown');
  }
  const row = await trust.recordClean(-100, 555, 5);
  assert.equal(row.status, 'trusted');
  assert.equal(row.clean_count, 5);
});

test('a flagged user is never promoted', async () => {
  await trust.seen(-100, 555);
  await trust.markFlagged(-100, 555);
  let row;
  for (let i = 0; i < 10; i++) row = await trust.recordClean(-100, 555, 5);
  assert.equal(row.status, 'flagged', 'a flagged user must stay checked forever');
});

test('an allowlisted user is never demoted', async () => {
  await trust.seen(-100, 555);
  await trust.allowlist(-100, 555);
  assert.equal((await trust.markFlagged(-100, 555)).status, 'allowlisted');
});

test('trust is per chat', async () => {
  await trust.seen(-100, 555);
  await trust.allowlist(-100, 555);
  assert.equal((await trust.get(-200, 555)).status, 'unknown');
});

// Otherwise daysSinceSeen is always ~0 and the 30-day recheck is dead code.
test('seen returns the history before this message', async () => {
  await trust.seen(-100, 555);
  exec("UPDATE trust SET last_seen_at = '2020-01-01T00:00:00+00:00' WHERE chat_id = -100 AND user_id = 555");
  const prior = await trust.seen(-100, 555);
  assert.equal(prior.last_seen_at, '2020-01-01T00:00:00+00:00');
  assert.ok(trust.daysSinceSeen(prior) > 365);
  assert.notEqual((await trust.get(-100, 555)).last_seen_at, '2020-01-01T00:00:00+00:00');
});

test('days in group comes from joined_at', async () => {
  await trust.seen(-100, 555);
  exec("UPDATE trust SET joined_at = '2020-01-01T00:00:00+00:00' WHERE chat_id = -100 AND user_id = 555");
  assert.ok(trust.daysInGroup(await trust.get(-100, 555)) > 365);
});

// seen() must return pre-call state when the row was created by allowlist
// before the user was first seen.
test('seen after allowlist returns the prior snapshot', async () => {
  await trust.allowlist(-100, 555);
  const old = '2020-01-01T00:00:00+00:00';
  exec('UPDATE trust SET last_seen_at = ? WHERE chat_id = -100 AND user_id = 555', old);
  const prior = await trust.seen(-100, 555);
  assert.equal(prior.status, 'allowlisted');
  assert.equal(prior.last_seen_at, old);
  assert.notEqual((await trust.get(-100, 555)).last_seen_at, old);
});

test('a first sighting returns the freshly written row', async () => {
  const row = await trust.seen(-100, 555);
  assert.equal(row.status, 'unknown');
  assert.notEqual(row.joined_at, null);
  assert.equal(row.joined_at, row.last_seen_at);
});

// --- reviews and audit ---

test('a review is created and resolved', async () => {
  const rid = await reviews.create(-100, 42, 555, 'buy crypto now', JSON.stringify({ is_spam: 0.99 }), 0.93);
  await reviews.resolve(rid, 'delete_ban', 777);
  const row = await reviews.get(rid);
  assert.equal(row.decision, 'delete_ban');
  assert.equal(row.decided_by, 777);
  assert.notEqual(row.decided_at, null);
});

test('resolve is a compare-and-set: only the first claim wins', async () => {
  const rid = await reviews.create(-100, 42, 555, 'x', '{}', 0.9);
  assert.equal(await reviews.resolve(rid, 'delete', 1), true);
  assert.equal(await reviews.resolve(rid, 'not_spam', 2), false);
  assert.equal((await reviews.get(rid)).decision, 'delete');
});

test('the purge clears text but keeps the label', async () => {
  const rid = await reviews.create(-100, 42, 555, 'buy crypto now', '{}', 0.93);
  await reviews.resolve(rid, 'not_spam', 777);
  exec("UPDATE reviews SET expires_at = '2020-01-01T00:00:00+00:00' WHERE id = ?", rid);
  assert.equal(await reviews.purgeExpired(), 1);
  const row = await reviews.get(rid);
  assert.equal(row.text, null, 'expired text must be cleared');
  assert.equal(row.decision, 'not_spam', 'the human label is the corpus, keep it');
  assert.notEqual(row.verdict_json, '', 'the verdict is kept for threshold tuning');
});

test('audit never stores text', async () => {
  await audit.record(-100, 555, 42, 0.93, 'deleted', 'high_confidence_spam', 'jev-1.13.0');
  const row = (await audit.recent(-100))[0];
  const columns = rows('PRAGMA table_info(audit)').map((c) => c.name);
  assert.ok(!columns.includes('text'));
  assert.equal(row.action, 'deleted');
  assert.equal(row.reason, 'high_confidence_spam');
});

// The 7-day erasure must not depend on a background task: storing new text
// erases text that has expired.
test('storing new text erases text that has expired', async () => {
  const old = await reviews.create(-100, 42, 555, 'buy crypto now', '{}', 0.93);
  exec("UPDATE reviews SET expires_at = '2020-01-01T00:00:00+00:00' WHERE id = ?", old);
  const fresher = await reviews.create(-100, 43, 556, 'and again', '{}', 0.93);
  assert.equal((await reviews.get(old)).text, null, 'expired text goes when new text arrives');
  assert.equal((await reviews.get(fresher)).text, 'and again', 'unexpired text is untouched');
});

// The purge is opportunistic, not a precondition: a card must still get a
// row (and therefore working buttons) when the purge cannot run.
test('a failed purge does not lose the review being created', async () => {
  failNext(1, /SET text = NULL/);
  const rid = await reviews.create(-100, 44, 557, 'still stored', '{}', 0.93);
  assert.equal((await reviews.get(rid)).text, 'still stored');
});

// Only a storage failure is worth absorbing here; a programming error must
// still surface.
test('the purge guard is narrow', async () => {
  failNext(1, /SET text = NULL/, (m) => new TypeError(m));
  await assert.rejects(reviews.create(-100, 45, 558, 'text', '{}', 0.93), TypeError);
});

test('review ids keep counting up from imported rows', async () => {
  exec(`INSERT INTO reviews (id, chat_id, message_id, user_id, verdict_json, risk, created_at, expires_at)
        VALUES (500, -1, 1, 1, '{}', 0.5, 'x', 'y')`);
  assert.equal(await reviews.create(-1, 2, 1, 't', '{}', 0.5), 501);
});
