// The Serverless runtime is not Node: a module may import only the SDK and
// other project modules (relative, ending in .js), and has no process, no
// Buffer and no filesystem. The tests run under Node, where all of those
// work, so these rules are checked here or not at all until deploy time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../tgcloud/', import.meta.url));

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const modules = walk(ROOT).filter((p) => p.endsWith('.js'));
const SDK = new Set(['sdk', 'sdk/db', 'sdk/api', 'sdk/fetch']);

test('there are modules to check', () => {
  assert.ok(modules.length > 30);
});

for (const path of modules) {
  const name = relative(ROOT, path).replace(/\\/g, '/');
  const source = readFileSync(path, 'utf8');

  test(`${name} imports only the SDK and relative .js modules`, () => {
    const specifiers = [...source.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]/gm)]
      .map((m) => m[1]);
    for (const spec of specifiers) {
      const ok = SDK.has(spec) || (spec.startsWith('.') && spec.endsWith('.js'));
      assert.ok(ok, `${name} imports ${spec}`);
    }
    assert.ok(!/\bimport\s*\(/.test(source), `${name} uses a dynamic import`);
    assert.ok(!/\brequire\s*\(/.test(source), `${name} uses require()`);
  });

  test(`${name} uses no Node-only globals`, () => {
    const code = source.replace(/\/\/.*$/gm, '');
    for (const global of ['process.', 'Buffer.', '__dirname', '__filename']) {
      assert.ok(!code.includes(global), `${name} uses ${global}`);
    }
  });
}

test('handlers are named after Telegram update types, one level deep', () => {
  const handlers = readdirSync(join(ROOT, 'handlers'));
  assert.deepEqual(handlers.sort(), ['callback_query.js', 'message.js', 'my_chat_member.js', 'pre_checkout_query.js']);
});

test('endpoint names are identifiers, one level deep', () => {
  for (const name of readdirSync(join(ROOT, 'endpoints'))) {
    assert.match(name, /^[A-Za-z_][A-Za-z0-9_]*\.js$/);
  }
});
