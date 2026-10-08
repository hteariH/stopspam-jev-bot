// A stand-in for the platform's `sdk/db`, backed by node:sqlite in memory.
//
// Only the surface this project uses is implemented: the schema DSL (enough to
// turn tgcloud/schema.js into DDL, so the schema has one source in tests too),
// the `sql` tag, and the raw db.run/all/get methods. Results have the shapes
// the SDK reference documents: `get` returns the first row or null, `run`
// returns {rowsAffected, lastInsertRowid, rows}.
import { DatabaseSync } from 'node:sqlite';

// ---- sql tag -------------------------------------------------------------

const SQL = Symbol('sql');
const COLUMN = Symbol('column');

function bindable(value) {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

export function sql(strings, ...values) {
  const parts = [];
  for (let i = 0; i < strings.length; i++) {
    parts.push({ text: strings[i] });
    if (i < values.length) {
      const v = values[i];
      if (v && v[SQL]) parts.push(...v.parts);
      else if (v && v[COLUMN]) parts.push({ text: `"${v.name}"` });
      else parts.push({ value: bindable(v) });
    }
  }
  return { [SQL]: true, parts };
}
sql.raw = (text) => ({ [SQL]: true, parts: [{ text }] });

function compile(query, params) {
  if (typeof query === 'string') return { text: query, params: params || {} };
  if (!query || !query[SQL]) throw new TypeError('expected a sql`...` object or a string');
  let text = '';
  const bound = {};
  let n = 0;
  for (const part of query.parts) {
    if ('value' in part) {
      n += 1;
      text += `:p${n}`;
      bound[`p${n}`] = part.value;
    } else {
      text += part.text;
    }
  }
  return { text, params: bound };
}

function normalizeParams(params) {
  const out = {};
  for (const [k, v] of Object.entries(params)) out[k.replace(/^[:@$]/, '')] = bindable(v);
  return out;
}

// ---- schema DSL ----------------------------------------------------------

function column(type) {
  return (name, opts = {}) => {
    const col = {
      [COLUMN]: true, name, type, opts, mods: [], deprecatedReason: null,
      primaryKey(o = {}) { this.mods.push(o.autoIncrement ? 'PRIMARY KEY AUTOINCREMENT' : 'PRIMARY KEY'); return this; },
      notNull() { this.mods.push('NOT NULL'); return this; },
      unique() { this.mods.push('UNIQUE'); return this; },
      default(v) {
        let lit;
        if (v && v[SQL]) lit = `(${compile(v).text})`;
        else if (typeof v === 'string') lit = `'${v.replace(/'/g, "''")}'`;
        else if (typeof v === 'boolean') lit = v ? '1' : '0';
        else if (v === null) lit = 'NULL';
        else lit = String(v);
        this.mods.push(`DEFAULT ${lit}`);
        return this;
      },
      deprecated(reason) { this.deprecatedReason = reason; return this; },
    };
    return col;
  };
}

export const text = column('TEXT');
export const integer = column('INTEGER');
export const real = column('REAL');

export function index(name) {
  return { on: (...cols) => ({ kind: 'index', name, cols }) };
}
export function primaryKey({ columns }) {
  return { kind: 'pk', cols: columns };
}

export function table(name, columns, extras) {
  const cols = {};
  for (const [key, col] of Object.entries(columns)) {
    if (!col.name) col.name = key;
    cols[key] = col;
  }
  const t = { [Symbol.for('table')]: true, tableName: name, columns: cols, ...cols };
  t.extras = extras ? Object.values(extras(cols)) : [];
  return t;
}

export function ddl(schemaModule) {
  const statements = [];
  for (const t of Object.values(schemaModule)) {
    if (!t || !t[Symbol.for('table')]) continue;
    const defs = Object.values(t.columns)
      .filter((c) => !c.deprecatedReason)
      .map((c) => [`"${c.name}"`, c.type, ...c.mods].join(' '));
    for (const e of t.extras) {
      if (e.kind === 'pk') defs.push(`PRIMARY KEY (${e.cols.map((c) => `"${c.name}"`).join(', ')})`);
    }
    statements.push(`CREATE TABLE "${t.tableName}" (\n  ${defs.join(',\n  ')}\n)`);
    for (const e of t.extras) {
      if (e.kind === 'index') {
        statements.push(`CREATE INDEX "${e.name}" ON "${t.tableName}" (${e.cols.map((c) => `"${c.name}"`).join(', ')})`);
      }
    }
  }
  return statements;
}

// ---- the database --------------------------------------------------------

let database = null;
// Tests can make the next N statements fail, standing in for a locked
// database or a full disk.
const failures = { remaining: 0, match: null };

export class FakeDbError extends Error {}

function conn() {
  if (!database) throw new Error('test db not initialised: call resetDb()');
  return database;
}

function prepare(query, params) {
  const { text: q, params: p } = compile(query, params);
  if (failures.remaining > 0 && (!failures.match || failures.match.test(q))) {
    failures.remaining -= 1;
    throw new FakeDbError(`simulated storage failure: ${q.slice(0, 60)}`);
  }
  return { stmt: conn().prepare(q), params: normalizeParams(p) };
}

function plain(row) {
  return row ? { ...row } : row;
}

export const db = {
  async run(query, params) {
    const { stmt, params: p } = prepare(query, params);
    if (stmt.columns().length) {
      const rows = stmt.all(p).map(plain);
      const changes = conn().prepare('SELECT changes() AS c, last_insert_rowid() AS id').get();
      return { rowsAffected: changes.c, lastInsertRowid: changes.id, rows };
    }
    const r = stmt.run(p);
    return { rowsAffected: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid), rows: [] };
  },
  async all(query, params) {
    const { stmt, params: p } = prepare(query, params);
    return stmt.all(p).map(plain);
  },
  async get(query, params) {
    const { stmt, params: p } = prepare(query, params);
    return plain(stmt.get(p)) ?? null;
  },
};

export function resetDb(schemaModule) {
  if (database) database.close();
  database = new DatabaseSync(':memory:');
  for (const s of ddl(schemaModule)) database.exec(s);
  failures.remaining = 0;
  failures.match = null;
}

export function failNext(count = 1, match = null) {
  failures.remaining = count;
  failures.match = match;
}

export function rawDb() {
  return conn();
}

export default { db, sql, table, text, integer, real, index, primaryKey };
