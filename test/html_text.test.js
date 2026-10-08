import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { htmlText } from '../tgcloud/lib/html_text.js';

// The expected output was produced by aiogram's Message.html_text over the
// same cases, so a review card is edited exactly as the Python bot edited it.
const cases = JSON.parse(readFileSync(new URL('./fixtures/html_text_cases.json', import.meta.url), 'utf8'));
const expected = JSON.parse(readFileSync(new URL('./fixtures/html_text_expected.json', import.meta.url), 'utf8'));

cases.forEach((message, i) => {
  test(`html_text matches aiogram: case ${i}`, () => {
    assert.equal(htmlText(message), expected[i]);
  });
});

test('a message with no text renders as empty', () => {
  assert.equal(htmlText({}), '');
  assert.equal(htmlText(null), '');
});
