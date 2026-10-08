import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MAX_TEXT, MessageFacts, buildState, factsFromMessage } from '../tgcloud/lib/core/state.js';

function facts(overrides = {}) {
  return MessageFacts({ text: 'hello', link_domains: [], link_count: 0, has_invite_link: false,
    is_forward: false, media_type: null, is_caption: false, author_message_count: 3,
    author_days_in_group: 10.0, author_has_username: true, group_title: 'Python Chat',
    group_description: 'Talk about Python', ...overrides });
}

function message(fields) {
  return { message_id: 1, date: 0, chat: { id: -100, type: 'supergroup', title: 'Python Chat' },
    from: { id: 5, is_bot: false, first_name: 'Ann' }, ...fields };
}

function extract(msg, groupDescription = '') {
  return factsFromMessage(msg, { authorMessageCount: 0, authorDaysInGroup: 0.0, groupDescription });
}

test('state contains the message and its context', () => {
  const state = buildState(facts({ text: 'buy cheap followers' }));
  assert.ok(state.includes('buy cheap followers'));
  assert.ok(state.includes('Python Chat'));
  assert.ok(state.includes('Talk about Python'));
});

test('state reports author history', () => {
  const state = buildState(facts({ author_message_count: 0, author_days_in_group: 0.001 }));
  assert.ok(state.includes('0'));
  assert.ok(state.toLowerCase().includes('messages'));
  assert.ok(state.includes('time in this group: 0.0 days'));
});

test('long text is truncated', () => {
  const state = buildState(facts({ text: 'x'.repeat(MAX_TEXT + 500) }));
  assert.ok(state.includes('x'.repeat(MAX_TEXT)));
  assert.ok(!state.includes('x'.repeat(MAX_TEXT + 1)));
});

test('state is deterministic', () => {
  assert.equal(buildState(facts()), buildState(facts()));
});

test('the state document matches the Python layout exactly', () => {
  assert.equal(buildState(facts({ author_days_in_group: null, link_count: 2,
    link_domains: ['a.example', 'b.example'], group_description: '' })), [
    '# Group', 'title: Python Chat', 'description: (none)', '',
    '# Author', 'messages previously sent in this group: 3', 'time in this group: unknown',
    'has a username: yes', '',
    '# Message', 'is a media caption: no', 'media type: (none)', 'forwarded: no',
    'link count: 2', 'link domains: a.example, b.example', 'contains a Telegram invite link: no', '',
    '# Text', 'hello',
  ].join('\n'));
});

test('facts extract links and invites', () => {
  const extracted = factsFromMessage(message({
    from: { id: 5, is_bot: false, first_name: 'Ann', username: 'ann' },
    text: 'see https://evil.example/win and t.me/joinchat/AAA',
  }), { authorMessageCount: 0, authorDaysInGroup: 0.0, groupDescription: 'Talk about Python' });
  assert.ok(extracted.link_domains.includes('evil.example'));
  assert.equal(extracted.link_count, 2);
  assert.equal(extracted.has_invite_link, true);
  assert.equal(extracted.author_has_username, true);
});

test('facts handle caption-only media', () => {
  const extracted = factsFromMessage(message({ caption: 'earn 500 a day', photo: [] }),
    { authorMessageCount: 0, authorDaysInGroup: null, groupDescription: '' });
  assert.equal(extracted.text, 'earn 500 a day');
  assert.equal(extracted.is_caption, true);
  assert.equal(extracted.media_type, 'photo');
  assert.equal(extracted.author_has_username, false);
});

// Malformed IPv6 address (unbalanced bracket) should not crash extraction.
test('facts handle a malformed IPv6 url', () => {
  const extracted = extract(message({ text: 'click http://[::1/free-money now' }), 'Talk about Python');
  assert.equal(extracted.text, 'click http://[::1/free-money now');
  assert.equal(extracted.link_count, 1);
  assert.deepEqual(extracted.link_domains, []);
});

test('facts keep valid domains next to malformed urls', () => {
  const extracted = extract(message({
    text: 'visit https://good.example.com and http://[::1/bad and www.another-good.net' }));
  assert.equal(extracted.link_count, 3);
  assert.ok(extracted.link_domains.includes('good.example.com'));
  assert.ok(extracted.link_domains.includes('another-good.net'));
  assert.equal(extracted.link_domains.length, 2);
});

test('facts handle an unclosed IPv6 bracket', () => {
  const extracted = extract(message({ text: 'click http://[invalid/path here' }));
  assert.equal(extracted.link_count, 1);
  assert.deepEqual(extracted.link_domains, []);
});

test('facts handle an empty IPv6 bracket', () => {
  const extracted = extract(message({ text: 'visit http://[]empty/notvalid' }));
  assert.equal(extracted.link_count, 1);
  assert.deepEqual(extracted.link_domains, []);
});

test('a valid bracketed IPv6 host is kept, as urlparse keeps it', () => {
  const extracted = extract(message({ text: 'go http://[::1]:8080/x now' }));
  assert.deepEqual(extracted.link_domains, ['[::1]:8080']);
});

test('the netloc keeps userinfo and port, as urlparse does', () => {
  const extracted = extract(message({ text: 'https://user@Example.COM:443/path' }));
  assert.deepEqual(extracted.link_domains, ['user@example.com:443']);
});

test('a www url with a nested scheme has no domain, as urlparse finds none', () => {
  const extracted = extract(message({ text: 'www.a.com/x?u=http://b.com' }));
  assert.equal(extracted.link_count, 1);
  assert.deepEqual(extracted.link_domains, []);
});

test('facts cap the group title at 128 characters', () => {
  const extracted = extract(message({ chat: { id: -100, type: 'supergroup', title: 'A'.repeat(200) }, text: 'hi' }));
  assert.equal(extracted.group_title, 'A'.repeat(128));
});

test('facts cap the group description at 255 characters', () => {
  const extracted = extract(message({ text: 'hi' }), 'B'.repeat(300));
  assert.equal(extracted.group_description, 'B'.repeat(255));
});

test('a forward is detected from forward_origin', () => {
  const extracted = extract(message({ text: 'hi', forward_origin: { type: 'user', date: 0 } }));
  assert.equal(extracted.is_forward, true);
});
