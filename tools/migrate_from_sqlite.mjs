#!/usr/bin/env node
// Copies the Python bot's SQLite database into the Serverless database.
//
//   node tools/migrate_from_sqlite.mjs path/to/stopspam.db [--dry-run]
//
// Run from the project root after `npm ci` and `npx tgcloud login`, with the
// schema already migrated (`npx tgcloud migrate`) and the old bot stopped.
// Rows go up in batches through endpoints/ops_import, which inserts with
// ON CONFLICT DO NOTHING - so a run that fails halfway can simply be run
// again. At the end the row counts on both sides are compared.
//
// It drives @tgcloud/cli's own run API (the same call `tgcloud run` makes)
// so results come back as data rather than terminal output. That is an
// internal module of the CLI, pinned in package.json to the version this was
// written against.
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export const TABLES = ['chats', 'trust', 'reviews', 'audit', 'billing', 'payments'];
// Comfortably under the platform's request size, whatever it is, and small
// enough that one failed batch costs little to retry.
export const MAX_BATCH_BYTES = 200_000;
export const MAX_BATCH_ROWS = 500;

// Splits rows into batches no larger than the byte and row caps.
export function batches(rows, maxBytes = MAX_BATCH_BYTES, maxRows = MAX_BATCH_ROWS) {
  const out = [];
  let current = [];
  let size = 2;
  for (const row of rows) {
    const rowSize = Buffer.byteLength(JSON.stringify(row)) + 1;
    if (current.length && (size + rowSize > maxBytes || current.length >= maxRows)) {
      out.push(current);
      current = [];
      size = 2;
    }
    current.push(row);
    size += rowSize;
  }
  if (current.length) out.push(current);
  return out;
}

// Plain objects with JSON-safe values. SQLite integers come back as numbers;
// anything that would not survive JSON (a BigInt past 2^53, a blob) stops the
// migration rather than being altered on the way.
export function plainRows(db, table) {
  return db.prepare(`SELECT * FROM ${table}`).all().map((row) => {
    const out = {};
    for (const [key, value] of Object.entries(row)) {
      if (typeof value === 'bigint') throw new Error(`${table}.${key} holds ${value}, too large to move exactly`);
      if (value instanceof Uint8Array) throw new Error(`${table}.${key} holds a blob; nothing in this schema should`);
      out[key] = value;
    }
    return out;
  });
}

// A function that runs one module on the platform, through @tgcloud/cli's
// own run API, and returns what it returned. Args are never printed.
export async function cli() {
  const base = `${pathToFileURL(resolve('node_modules/@tgcloud/cli/src')).href}/`;
  const [{ runFunction }, { scanFiles }, { pathToModule }, { readWd }, { resolveToken }] = await Promise.all([
    import(`${base}api/endpoints.js`),
    import(`${base}core/scanner.js`),
    import(`${base}core/snapshot.js`),
    import(`${base}core/workdir.js`),
    import(`${base}core/credentials.js`),
  ]);
  const token = await resolveToken();
  const sources = {};
  for (const file of scanFiles()) sources[pathToModule(file)] = readWd(file);
  return async (moduleName, args) => {
    const response = await runFunction(token, moduleName, sources, args, { ops: true });
    return response.result;
  };
}

async function main() {
  const [path, ...flags] = process.argv.slice(2);
  if (!path) {
    console.error('usage: node tools/migrate_from_sqlite.mjs path/to/stopspam.db [--dry-run]');
    process.exit(2);
  }
  const dryRun = flags.includes('--dry-run');
  const source = new DatabaseSync(path, { readOnly: true });
  const local = {};
  for (const table of TABLES) local[table] = plainRows(source, table);

  for (const table of TABLES) {
    console.log(`${table}: ${local[table].length} rows in ${batches(local[table]).length} batch(es)`);
  }
  if (dryRun) return;

  const run = await cli();
  for (const table of TABLES) {
    let inserted = 0;
    const parts = batches(local[table]);
    for (const [i, rows] of parts.entries()) {
      const result = await run('endpoints/ops_import', { table, rows });
      inserted += result.inserted;
      process.stdout.write(`\r${table}: batch ${i + 1}/${parts.length}, ${inserted} inserted`);
    }
    process.stdout.write('\n');
  }

  const { counts } = await run('endpoints/ops_counts', {});
  let mismatched = false;
  for (const table of TABLES) {
    const ok = counts[table] >= local[table].length;
    if (!ok) mismatched = true;
    console.log(`${ok ? 'ok  ' : 'MISS'} ${table}: ${local[table].length} local, ${counts[table]} on the platform`);
  }
  if (mismatched) {
    console.error('Some rows did not arrive. Re-run this command: inserts are idempotent.');
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((exc) => {
    console.error(exc && exc.description ? `${exc.description}` : exc);
    process.exit(1);
  });
}
