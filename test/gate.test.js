import { test } from 'node:test';
import assert from 'node:assert/strict';

import { hasTrigger, needsCheck } from '../tgcloud/lib/core/gate.js';
import { MessageFacts } from '../tgcloud/lib/core/state.js';

function facts(overrides = {}) {
  return MessageFacts({ text: 'hello', link_domains: [], link_count: 0, has_invite_link: false,
    is_forward: false, media_type: null, is_caption: false, author_message_count: 9,
    author_days_in_group: 100.0, author_has_username: true, group_title: 'G',
    group_description: '', ...overrides });
}

function gate(overrides = {}) {
  return needsCheck({ status: 'unknown', cleanCount: 0, trustAfter: 5, daysSinceSeen: 1.0,
    facts: facts(), ...overrides });
}

test('a newcomer is checked', () => {
  assert.deepEqual({ ...gate() }, { check: true, reason: 'low_history' });
});

test('a trusted member is skipped', () => {
  assert.deepEqual({ ...gate({ status: 'trusted', cleanCount: 5 }) }, { check: false, reason: 'trusted' });
});

test('allowlisted is never checked', () => {
  assert.deepEqual({ ...gate({ status: 'allowlisted', cleanCount: 0 }) }, { check: false, reason: 'allowlisted' });
});

test('flagged is always checked', () => {
  assert.deepEqual({ ...gate({ status: 'flagged', cleanCount: 999 }) }, { check: true, reason: 'flagged' });
});

test('a trusted member posting a link is rechecked', () => {
  const r = gate({ status: 'trusted', cleanCount: 50,
    facts: facts({ link_count: 1, link_domains: ['evil.example'] }) });
  assert.deepEqual({ ...r }, { check: true, reason: 'trigger' });
});

test('a trusted member posting media with a caption is rechecked', () => {
  const r = gate({ status: 'trusted', cleanCount: 50, facts: facts({ media_type: 'photo', is_caption: true }) });
  assert.deepEqual({ ...r }, { check: true, reason: 'trigger' });
});

test('a trusted member returning after a long silence is rechecked', () => {
  const r = gate({ status: 'trusted', cleanCount: 50, daysSinceSeen: 45.0 });
  assert.deepEqual({ ...r }, { check: true, reason: 'returned_after_silence' });
});

test('plain text from a trusted member costs no API call', () => {
  assert.equal(gate({ status: 'trusted', cleanCount: 50, daysSinceSeen: 2.0 }).check, false);
});

test('allowlisted beats a trigger', () => {
  assert.deepEqual({ ...gate({ status: 'allowlisted', facts: facts({ link_count: 1 }) }) },
    { check: false, reason: 'allowlisted' });
});

test('flagged with no trigger is still checked', () => {
  assert.deepEqual({ ...gate({ status: 'flagged', daysSinceSeen: 1.0 }) }, { check: true, reason: 'flagged' });
});

test('low history from a clean count below the threshold', () => {
  assert.deepEqual({ ...gate({ status: 'trusted', cleanCount: 2, trustAfter: 5 }) },
    { check: true, reason: 'low_history' });
});

test('silence boundary at exactly thirty days', () => {
  assert.deepEqual({ ...gate({ status: 'trusted', cleanCount: 50, daysSinceSeen: 30.0 }) },
    { check: false, reason: 'trusted' });
});

test('silence boundary just over thirty days', () => {
  assert.deepEqual({ ...gate({ status: 'trusted', cleanCount: 50, daysSinceSeen: 30.1 }) },
    { check: true, reason: 'returned_after_silence' });
});

test('trigger detection', () => {
  assert.equal(hasTrigger(facts({ link_count: 1 })), true);
  assert.equal(hasTrigger(facts({ has_invite_link: true })), true);
  assert.equal(hasTrigger(facts({ is_forward: true })), true);
  assert.equal(hasTrigger(facts({ media_type: 'photo', is_caption: true })), true);
  assert.equal(hasTrigger(facts({ media_type: 'sticker', is_caption: false })), false);
  assert.equal(hasTrigger(facts()), false);
});
