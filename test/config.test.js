import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as config from '../tgcloud/lib/config.js';

test('defaults match the spec', () => {
  assert.equal(config.DEFAULT_DELETE_THRESHOLD, 0.90);
  assert.equal(config.DEFAULT_REVIEW_THRESHOLD, 0.55);
  assert.equal(config.DEFAULT_CONFIDENCE_FLOOR, 0.75);
  assert.equal(config.DEFAULT_TRUST_AFTER, 5);
  assert.equal(config.OBSERVE_DAYS, 7);
  assert.equal(config.REVIEW_TTL_DAYS, 7);
  assert.equal(config.JEV_TIMEOUT, 2.0);
  assert.equal(config.JEV_MODEL, 'jev-latest');
  assert.equal(config.SUBSCRIPTION_PERIOD, 2592000);
});
