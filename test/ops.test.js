import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { fresh, rows, scriptFetch, response } from './helpers.js';
import { calls } from './telegram.js';
import setSecret from '../tgcloud/endpoints/ops_set_secret.js';
import importRows, { COLUMNS } from '../tgcloud/endpoints/ops_import.js';
import counts from '../tgcloud/endpoints/ops_counts.js';
import setCommands from '../tgcloud/endpoints/ops_set_commands.js';
import classify from '../tgcloud/endpoints/ops_classify.js';
import deleteWebhook from '../tgcloud/endpoints/ops_delete_webhook.js';
import * as settings from '../tgcloud/lib/storage/settings.js';
import * as reviews from '../tgcloud/lib/storage/reviews.js';
import { batches, plainRows, TABLES } from '../tools/migrate_from_sqlite.mjs';

beforeEach(fresh);

const OPS = { ops: true };
const ENDPOINTS = [setSecret, importRows, counts, setCommands, classify, deleteWebhook];

// Over HTTP an endpoint only runs with verified Mini App init data; none of
// these may run that way, or without the explicit flag only the CLI sets.
test('every ops endpoint refuses a Mini App call and a call without the flag', async () => {
  for (const endpoint of ENDPOINTS) {
    for (const ctx of [undefined, {}, { ops: 'true' }, { initData: { user: { id: 1 } } },
      { ops: true, initData: { user: { id: 1 } } }]) {
      await assert.rejects(endpoint({ value: 'k', table: 'chats', rows: [] }, ctx), { name: 'EndpointError' });
    }
  }
  assert.equal(await settings.get(settings.TYPESAFE_API_KEY), null);
  assert.deepEqual(calls('setMyCommands'), []);
});

test('every endpoint file is guarded', () => {
  const files = readdirSync(new URL('../tgcloud/endpoints/', import.meta.url));
  assert.equal(files.length, ENDPOINTS.length, 'a new endpoint needs adding to the guard test');
});

test('the secret is stored trimmed and never returned', async () => {
  const result = await setSecret({ value: '  ts_abc123 \n' }, OPS);
  assert.deepEqual(result, { ok: true, length: 9 });
  assert.equal(await settings.get(settings.TYPESAFE_API_KEY), 'ts_abc123');
  await assert.rejects(setSecret({ value: 'has space' }, OPS));
  await assert.rejects(setSecret({}, OPS));
});

test('the commands are the ones the Python bot set at start', async () => {
  await setCommands({}, OPS);
  assert.deepEqual(calls('setMyCommands')[0].commands.map((c) => c.command), ['chats', 'setlog', 'privacy', 'help']);
});

test('ops_classify reports a classifier failure instead of throwing', async () => {
  const result = await classify({ text: 'x' }, OPS);
  assert.equal(result.ok, false);
  assert.match(result.error, /TYPESAFE_API_KEY/);
});

test('ops_classify returns the verdict with the stored key', async () => {
  await settings.set(settings.TYPESAFE_API_KEY, 'k');
  scriptFetch(async () => response(200, { model: 'm', answers: {
    is_spam: { noul: 0.1 }, is_scam: { noul: 0.1 }, solicits_contact: { noul: 0 }, looks_like_member: { noul: 0.9 },
    kind: { choice: 'none' }, severity: { score: 0, confidence: 0.9 } } }));
  const result = await classify({ text: 'hello' }, OPS);
  assert.equal(result.ok, true);
  assert.equal(result.verdict.kind, 'none');
});

// --- import ---

test('the import column lists match the schema exactly', () => {
  for (const table of TABLES) {
    const schema = rows(`PRAGMA table_info(${table})`).map((c) => c.name);
    assert.deepEqual(COLUMNS[table], schema, table);
  }
});

test('the import preserves ids and is idempotent', async () => {
  const batch = { table: 'reviews', rows: [
    { id: 40, chat_id: -1, message_id: 7, user_id: 5, text: 'spam', verdict_json: '{}', risk: 0.9,
      decision: null, decided_by: null, decided_at: null, created_at: '2026-01-01T00:00:00+00:00',
      expires_at: '2026-01-08T00:00:00+00:00' },
  ] };
  assert.deepEqual(await importRows(batch, OPS), { table: 'reviews', received: 1, inserted: 1 });
  assert.deepEqual(await importRows(batch, OPS), { table: 'reviews', received: 1, inserted: 0 });
  // A card already in an admin's chat carries rv:40 and must still find it.
  assert.equal((await reviews.get(40)).text, 'spam');
  assert.equal(await reviews.create(-1, 8, 5, 'x', '{}', 0.5), 41);
});

test('the import refuses unknown tables and columns', async () => {
  await assert.rejects(importRows({ table: 'settings', rows: [] }, OPS), /unknown table/);
  await assert.rejects(importRows({ table: 'chats', rows: [{ chat_id: 1, 'x; DROP TABLE chats': 1 }] }, OPS),
    /unknown columns/);
});

test('a whole database round-trips through the migration path', async () => {
  // A copy of the Python schema, filled the way the Python bot filled it.
  const dir = mkdtempSync(join(tmpdir(), 'stopspam-'));
  const old = new DatabaseSync(join(dir, 'stopspam.db'));
  const { rawDb } = await import('./fakes/sdk-db.js');
  for (const { sql: ddl } of rawDb().prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name IN ('chats','trust','reviews','audit','billing','payments')").all()) {
    old.exec(ddl);
  }
  old.exec(`INSERT INTO chats VALUES (-100123, 'G', 'active', 0.9, 0.55, 0.75, 5, 777, 'ru', 1,
              '2026-01-08T00:00:00+00:00', '2026-01-01T00:00:00+00:00')`);
  old.exec(`INSERT INTO trust VALUES (-100123, 555, 3, 'flagged', 'a', 'b', 'c')`);
  for (let i = 1; i <= 30; i++) {
    old.exec(`INSERT INTO audit (chat_id, user_id, risk, action, reason, created_at)
              VALUES (-100123, 555, 0.5, 'reviewed', 'grey_zone', '2026-01-0${1 + (i % 9)}T00:00:00+00:00')`);
  }
  old.exec(`INSERT INTO billing (chat_id, member_count, paid_until, updated_at) VALUES (-100123, 640, '2026-02-01T00:00:00+00:00', 'x')`);
  old.exec(`INSERT INTO payments VALUES ('ch_1', -100123, 7, 50, 1, '2026-02-01T00:00:00+00:00', 'x')`);

  for (const table of TABLES) {
    for (const part of batches(plainRows(old, table), 1000, 7)) await importRows({ table, rows: part }, OPS);
  }
  const result = await counts({}, OPS);
  assert.deepEqual(result.counts, { chats: 1, trust: 1, reviews: 0, audit: 30, billing: 1, payments: 1 });
  assert.equal(result.typesafe_key_set, false);
  assert.deepEqual(rows('SELECT lang, log_chat_id FROM chats'), [{ lang: 'ru', log_chat_id: 777 }]);
  old.close();
});

test('batches respect both the byte and the row cap', () => {
  const many = Array.from({ length: 25 }, (_, i) => ({ i, pad: 'x'.repeat(100) }));
  assert.deepEqual(batches(many, 10_000, 10).map((b) => b.length), [10, 10, 5]);
  assert.ok(batches(many, 500, 100).every((b) => JSON.stringify(b).length <= 500 || b.length === 1));
  assert.deepEqual(batches([]), []);
});

test('the rollback endpoint deletes the webhook without dropping pending updates', async () => {
  await deleteWebhook({}, OPS);
  assert.deepEqual(calls('deleteWebhook'), [{ drop_pending_updates: false }]);
});
