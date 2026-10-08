#!/usr/bin/env node
// Writes TYPESAFE_API_KEY from the environment into the Serverless database,
// then makes one classifier call from inside the platform to prove it works.
//
//   TYPESAFE_API_KEY=... node tools/set_typesafe_key.mjs
//
// `tgcloud run endpoints/ops_set_secret '{value: ...}'` does the same, but
// the CLI echoes its arguments; this never prints the key. The GitHub
// workflow "Set TypeSafe key" runs it with the repository secret, so the key
// goes from GitHub to the platform without passing through anyone's hands.
import { cli } from './migrate_from_sqlite.mjs';

const key = (process.env.TYPESAFE_API_KEY || '').trim();
if (!key) {
  console.error('TYPESAFE_API_KEY is not set');
  process.exit(2);
}

const run = await cli();
const stored = await run('endpoints/ops_set_secret', { value: key });
console.log(`stored a ${stored.length}-character key`);

const check = await run('endpoints/ops_classify', { text: 'buy cheap crypto now, dm me' });
if (!check.ok) {
  console.error(`the key is stored, but a classifier call failed after ${check.ms} ms: ${check.error}`);
  process.exit(1);
}
console.log(`classifier answered in ${check.ms} ms: kind=${check.verdict.kind}, `
  + `spam=${check.verdict.is_spam}, scam=${check.verdict.is_scam}, model=${check.verdict.model}`);
