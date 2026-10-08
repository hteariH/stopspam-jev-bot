import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Action, MEMBER_CEILING, Thresholds, decide, riskScore } from '../tgcloud/lib/core/policy.js';
import { Verdict } from '../tgcloud/lib/core/verdict.js';

const DEFAULTS = Thresholds(0.90, 0.55, 0.75);

function verdict(overrides = {}) {
  return Verdict({ is_spam: 0.0, is_scam: 0.0, solicits_contact: 0.0, looks_like_member: 1.0,
    kind: 'none', severity: 0, severity_confidence: 1.0, model: 'jev-test', ...overrides });
}

const SCAM = { is_spam: 0.98, is_scam: 0.99, solicits_contact: 1.0,
  looks_like_member: 0.02, kind: 'crypto', severity: 2, severity_confidence: 0.95 };

function ctx(overrides = {}) {
  return { observing: false, canDelete: true, isAdmin: false, isAllowlisted: false,
    entitled: true, ...overrides };
}

// --- risk score ---

test('risk is zero for ordinary chatter', () => {
  assert.ok(Math.abs(riskScore(verdict())) < 1e-9);
});

test('risk is high for blatant scam', () => {
  assert.ok(riskScore(verdict(SCAM)) > 0.90);
});

test('looks_like_member pulls risk down', () => {
  const loud = verdict({ is_spam: 0.9, severity: 1, looks_like_member: 0.0 });
  const friendly = verdict({ is_spam: 0.9, severity: 1, looks_like_member: 1.0 });
  assert.ok(riskScore(friendly) < riskScore(loud));
});

test('risk is clamped to the unit interval', () => {
  const r = riskScore(verdict(SCAM));
  assert.ok(r >= 0.0 && r <= 1.0);
  assert.ok(riskScore(verdict({ looks_like_member: 1.0 })) >= 0.0);
});

// --- bands ---

test('blatant scam is deleted', () => {
  const d = decide(verdict(SCAM), DEFAULTS, ctx());
  assert.equal(d.action, Action.DELETE);
  assert.equal(d.reason, 'high_confidence_spam');
});

test('grey zone goes to review', () => {
  // risk = 0.60*0.90 + 0.30*0.5 + 0.10*0.50 - 0.25*0.20 = 0.69
  const grey = verdict({ is_spam: 0.90, severity: 1, severity_confidence: 0.60,
    solicits_contact: 0.50, looks_like_member: 0.20 });
  const d = decide(grey, DEFAULTS, ctx());
  assert.ok(d.risk >= 0.55 && d.risk < 0.90);
  assert.equal(d.action, Action.REVIEW);
  assert.equal(d.reason, 'grey_zone');
});

test('low risk is ignored', () => {
  const d = decide(verdict({ is_spam: 0.2 }), DEFAULTS, ctx());
  assert.equal(d.action, Action.IGNORE);
  assert.equal(d.reason, 'below_threshold');
});

// --- the property the whole model choice rests on ---

test('high risk but low confidence is reviewed, not deleted', () => {
  const d = decide(verdict({ ...SCAM, severity_confidence: 0.40 }), DEFAULTS, ctx());
  assert.equal(d.action, Action.REVIEW, 'uncertainty must never delete');
  assert.ok(d.risk >= DEFAULTS.delete);
});

test('severity zero never deletes however high the risk', () => {
  const harmless = verdict({ is_spam: 1.0, is_scam: 1.0, solicits_contact: 1.0,
    looks_like_member: 0.0, severity: 0, severity_confidence: 1.0 });
  assert.notEqual(decide(harmless, DEFAULTS, ctx()).action, Action.DELETE);
});

test('member ceiling blocks deletion', () => {
  const borderline = verdict({ ...SCAM, looks_like_member: MEMBER_CEILING + 0.01 });
  assert.notEqual(decide(borderline, DEFAULTS, ctx()).action, Action.DELETE);
});

// --- guards ---

test('admins are never touched', () => {
  const d = decide(verdict(SCAM), DEFAULTS, ctx({ isAdmin: true }));
  assert.equal(d.action, Action.IGNORE);
  assert.equal(d.reason, 'admin');
});

test('allowlisted users are never touched', () => {
  const d = decide(verdict(SCAM), DEFAULTS, ctx({ isAllowlisted: true }));
  assert.equal(d.action, Action.IGNORE);
  assert.equal(d.reason, 'allowlisted');
});

test('observation mode downgrades delete to review', () => {
  const d = decide(verdict(SCAM), DEFAULTS, ctx({ observing: true }));
  assert.equal(d.action, Action.REVIEW);
  assert.equal(d.reason, 'observing');
});

test('missing delete permission downgrades to review', () => {
  const d = decide(verdict(SCAM), DEFAULTS, ctx({ canDelete: false }));
  assert.equal(d.action, Action.REVIEW);
  assert.equal(d.reason, 'no_delete_permission');
});

test('thresholds are configurable', () => {
  const d = decide(verdict(SCAM), Thresholds(0.99, 0.95, 0.99), ctx());
  assert.equal(d.action, Action.REVIEW);
});

test('an unentitled chat reviews what it would have deleted', () => {
  const d = decide(verdict(SCAM), DEFAULTS, ctx({ entitled: false }));
  assert.equal(d.action, Action.REVIEW);
  assert.equal(d.reason, 'not_entitled');
});

test('an entitled chat still deletes', () => {
  assert.equal(decide(verdict(SCAM), DEFAULTS, ctx({ entitled: true })).action, Action.DELETE);
});

// Inside the observation window nothing is deleted on any tier, so
// advertising a subscription there would be selling something the admin
// does not yet need.
test('observing is reported ahead of not_entitled', () => {
  const d = decide(verdict(SCAM), DEFAULTS, ctx({ observing: true, entitled: false }));
  assert.equal(d.reason, 'observing');
});

// The subscription is the one problem the bot can actually fix.
test('not_entitled is reported ahead of missing delete rights', () => {
  const d = decide(verdict(SCAM), DEFAULTS, ctx({ entitled: false, canDelete: false }));
  assert.equal(d.reason, 'not_entitled');
});

// Payment buys enforcement of a verdict, never a harsher verdict.
test('entitlement never promotes a grey-zone message', () => {
  const grey = verdict({ is_spam: 0.72, severity: 1, severity_confidence: 0.5, looks_like_member: 0.1 });
  const paid = decide(grey, DEFAULTS, ctx({ entitled: true }));
  const unpaid = decide(grey, DEFAULTS, ctx({ entitled: false }));
  assert.equal(paid.action, Action.REVIEW);
  assert.equal(unpaid.action, Action.REVIEW);
  assert.equal(paid.reason, 'grey_zone');
  assert.equal(unpaid.reason, 'grey_zone');
});

test('entitlement does not change the risk score', () => {
  const paid = decide(verdict(SCAM), DEFAULTS, ctx({ entitled: true }));
  const unpaid = decide(verdict(SCAM), DEFAULTS, ctx({ entitled: false }));
  assert.equal(paid.risk, unpaid.risk);
});
