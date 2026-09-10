import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, existsSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {createHook, executionAsyncId} from 'node:async_hooks';
import {runChecks} from './checks.mjs';

const sqlite3 = createRequire(import.meta.url)('../src/index.cjs');
const dir = mkdtempSync(join(tmpdir(), 'sqlite3-compat-test-'));
let counter = 0;
const file = () => join(dir, `db-${counter++}.sqlite`);
const call = (target, method, ...args) => new Promise((resolve, reject) => target[method](...args, function (error, value) { error ? reject(error) : resolve({value, self: this}); }));
const open = (name = ':memory:', mode) => new Promise((resolve, reject) => { const db = new sqlite3.Database(name, ...(mode === undefined ? [] : [mode]), error => error ? reject(error) : resolve(db)); });
const failure = promise => promise.then(() => { throw new Error('expected failure'); }, error => error);
test.after(() => rmSync(dir, {recursive: true, force: true}));

test('shared behavioral checks', async () => {
  assert.deepEqual(await runChecks(sqlite3), {checks: 14});
});

test('constructor validation and open errors', async () => {
  assert.throws(() => sqlite3.Database(':memory:'), /Class constructors cannot be invoked without 'new'/);
  assert.throws(() => sqlite3.Statement(), /Class constructors cannot be invoked without 'new'/);
  assert.throws(() => new sqlite3.Database(), TypeError);
  const missing = await failure(open(file(), sqlite3.OPEN_READONLY));
  assert.equal(missing.errno, sqlite3.CANTOPEN);
  assert.equal(missing.message, 'SQLITE_CANTOPEN: unable to open database file');
  const noDir = await failure(open(join(dir, 'nope', 'x.db')));
  assert.equal(noDir.code, 'SQLITE_CANTOPEN');
  const db = await open(file());
  assert.equal(db.open, true);
  assert.equal(db.mode, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE | sqlite3.OPEN_FULLMUTEX);
  await call(db, 'close');
  assert.equal(db.open, false);
  const again = await failure(call(db, 'close'));
  assert.equal(again.message, 'SQLITE_MISUSE: Database is closed');
  assert.equal(sqlite3.VERSION_NUMBER > 3040000, true);
});

test('scheduling: queued work, errors after close, close with open statements', async () => {
  const db = new sqlite3.Database(':memory:');
  const results = [];
  db.run('CREATE TABLE t (a)');
  db.run('INSERT INTO t VALUES (1)', function () { results.push(this.lastID); });
  await call(db, 'wait');
  assert.deepEqual(results, [1]);
  const statement = db.prepare('SELECT a FROM t');
  const busy = await failure(call(db, 'close'));
  assert.equal(busy.message, 'SQLITE_BUSY: unable to close due to unfinalised statements');
  assert.equal((await call(statement, 'get')).value.a, 1);
  await call(statement, 'finalize');
  await call(db, 'close');
  const errors = [];
  db.on('error', error => errors.push(error.message));
  db.run('SELECT 1');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(errors, ['SQLITE_MISUSE: Database handle is closed']);
});

test('statement cursor semantics match node-sqlite3', async () => {
  const db = await open();
  await call(db, 'exec', 'CREATE TABLE t (a); INSERT INTO t VALUES (1), (2), (3)');
  const statement = db.prepare('SELECT a FROM t ORDER BY a');
  assert.equal((await call(statement, 'get')).value.a, 1);
  assert.equal((await call(statement, 'get')).value.a, 2);
  assert.deepEqual((await call(statement, 'all')).value, [{a: 1}, {a: 2}, {a: 3}]);
  assert.equal((await call(statement, 'get')).value, undefined);
  await call(statement, 'reset');
  assert.equal((await call(statement, 'get')).value.a, 1);
  const bound = db.prepare('SELECT a FROM t WHERE a = ?');
  assert.equal((await call(bound, 'get', 2)).value.a, 2);
  assert.equal((await call(bound, 'get')).value, undefined);
  assert.equal((await call(bound, 'get', 3)).value.a, 3);
  await call(bound, 'finalize');
  const finalized = await failure(call(bound, 'run'));
  assert.equal(finalized.message, 'SQLITE_MISUSE: Statement is already finalized');
  await call(statement, 'finalize');
  await call(db, 'close');
});

test('binding rules: names, positions, numbered placeholders and value conversion', async () => {
  const db = await open();
  await call(db, 'exec', 'CREATE TABLE t (txt TEXT, num)');
  await call(db, 'run', 'INSERT INTO t VALUES ($text, $id)', {$id: 1, $text: 'dollar'});
  await call(db, 'run', 'INSERT INTO t VALUES (:text, :id)', {':id': 2, ':text': 'colon'});
  await call(db, 'run', 'INSERT INTO t VALUES (@txt, @id)', ['at-array', 3]);
  await call(db, 'run', 'INSERT INTO t VALUES (?2, ?4)', [null, 'numbered', null, 4]);
  await call(db, 'run', 'INSERT INTO t VALUES (?, ?)', {2: 5, 1: 'indexed-object'});
  await call(db, 'run', 'INSERT INTO t VALUES (?, ?)', 'skipped-undefined', undefined, 6);
  const when = new Date(2020, 1, 2);
  await call(db, 'run', 'INSERT INTO t VALUES (?, ?)', /re/, when);
  await call(db, "run", "INSERT INTO t VALUES (?, ?)", true, 9007199254740993n);
  const rows = (await call(db, 'all', 'SELECT txt, num FROM t ORDER BY rowid')).value;
  assert.deepEqual(rows.slice(0, 6), [{txt: 'dollar', num: 1}, {txt: 'colon', num: 2}, {txt: 'at-array', num: 3}, {txt: 'numbered', num: 4}, {txt: 'indexed-object', num: 5}, {txt: 'skipped-undefined', num: 6}]);
  assert.deepEqual(rows[6], {txt: '/re/', num: when.valueOf()});
  assert.deepEqual(rows[7], {txt: "1", num: 9007199254740992});
  const unknown = await failure(call(db, 'run', 'INSERT INTO t VALUES ($a, $b)', {$a: 1, $c: 2}));
  assert.equal(unknown.message, 'SQLITE_RANGE: column index out of range');
  const tooMany = await failure(call(db, 'get', 'SELECT ?', 1, 2));
  assert.equal(tooMany.errno, sqlite3.RANGE);
  const blob = (await call(db, 'get', "SELECT x'0102' AS b, 9007199254740993 AS big")).value;
  assert.ok(Buffer.isBuffer(blob.b) && blob.b.equals(Buffer.from([1, 2])));
  assert.equal(blob.big, 9007199254740992);
  await call(db, 'close');
});

test('error shapes and delivery', async () => {
  const db = await open();
  const syntax = await failure(new Promise((resolve, reject) => db.prepare('CRATE TALE foo', error => error ? reject(error) : resolve())));
  assert.deepEqual([syntax.message, syntax.errno, syntax.code], ['SQLITE_ERROR: near "CRATE": syntax error', sqlite3.ERROR, 'SQLITE_ERROR']);
  const viaRow = await new Promise(resolve => db.each('SELECT * FROM nope', error => resolve(error)));
  assert.equal(viaRow.message, 'SQLITE_ERROR: no such table: nope');
  const viaComplete = await new Promise(resolve => db.each('SELECT * FROM nope', () => assert.fail('row callback must not run'), error => resolve(error)));
  assert.equal(viaComplete.code, 'SQLITE_ERROR');
  await call(db, 'close');
});

test('trace and profile events use the expanded SQL and follow listener registration', async () => {
  const db = await open();
  const traced = [];
  const profiled = [];
  const onTrace = sql => traced.push(sql);
  db.on('trace', onTrace);
  db.on('profile', (sql, ms) => profiled.push([sql, typeof ms]));
  await call(db, 'run', 'CREATE TABLE t (a)');
  await call(db, 'run', 'INSERT INTO t VALUES (?)', 'x');
  db.removeListener('trace', onTrace);
  await call(db, 'run', 'INSERT INTO t VALUES (?)', 'y');
  assert.deepEqual(traced, ['CREATE TABLE t (a)', "INSERT INTO t VALUES ('x')"]);
  assert.deepEqual(profiled.map(p => p[1]), ['number', 'number', 'number']);
  await call(db, 'close');
});

test('serialize, parallelize and wait', async () => {
  const db = await open();
  let inside = false;
  const returned = db.serialize(() => { inside = true; db.run('CREATE TABLE t (a)'); db.run('INSERT INTO t VALUES (1)'); });
  assert.equal(returned, db);
  assert.equal(inside, true);
  db.parallelize();
  const total = (await call(db, 'get', 'SELECT count(*) AS n FROM t')).value.n;
  assert.equal(total, 1);
  await call(db, 'wait');
  await call(db, 'close');
});

test('backup copies the database and blocks close until finished or auto-finished', async () => {
  const source = await open(file());
  await call(source, 'exec', 'CREATE TABLE t (a); INSERT INTO t VALUES (1), (2)');
  const target = file();
  const backup = source.backup(target);
  assert.equal(backup.idle, true);
  const initial = await call(backup, 'step', 0);
  assert.equal(initial.self.remaining, initial.self.pageCount);
  const blocked = await failure(call(source, 'close'));
  assert.equal(blocked.errno, sqlite3.BUSY);
  const done = await call(backup, 'step', -1);
  assert.deepEqual([done.value, backup.completed, backup.failed, backup.remaining], [true, true, false, 0]);
  await call(source, 'close');
  const copy = await open(target, sqlite3.OPEN_READONLY);
  assert.equal((await call(copy, 'get', 'SELECT count(*) AS n FROM t')).value.n, 2);
  await call(copy, 'close');
  const again = await open(file());
  const second = again.backup(file());
  second.retryErrors = [];
  await call(second, 'step', -1);
  const stillBlocked = await failure(call(again, 'close'));
  assert.equal(stillBlocked.errno, sqlite3.BUSY);
  await call(second, 'finish');
  const finished = await failure(call(second, 'step', 1));
  assert.equal(finished.message, 'SQLITE_MISUSE: Backup is already finished');
  await call(again, 'close');
});

test('cached databases, verbose traces and interrupt', async () => {
  const name = file();
  const first = sqlite3.cached.Database(name);
  const second = sqlite3.cached.Database(name);
  assert.equal(first, second);
  await new Promise(resolve => first.once('open', resolve));
  await call(first, 'close');
  const db = await open();
  assert.throws(() => new sqlite3.Database(':memory:').interrupt(), /Database is not open/);
  sqlite3.verbose();
  const error = await failure(call(db, 'run', 'UPDATE nope SET a = 1'));
  assert.match(error.stack, /Database#run\('UPDATE nope SET a = 1'/);
  await call(db, 'exec', 'CREATE TABLE t (n); INSERT INTO t VALUES (1), (2), (3), (4)');
  const seen = [];
  const interrupted = await new Promise(resolve => db.each('SELECT last.n FROM t, t, t, t, t, t AS last', function (err, row) {
    if (err) return resolve(err);
    seen.push(row.n);
    if (seen.length === 2) db.interrupt();
  }));
  assert.deepEqual([interrupted.message, interrupted.errno, seen.length], ['SQLITE_INTERRUPT: interrupted', sqlite3.INTERRUPT, 2]);
  await call(db, 'close');
});

test('configure busyTimeout and limits', async () => {
  const db = await open();
  db.configure('busyTimeout', 250);
  assert.equal((await call(db, 'get', 'PRAGMA busy_timeout')).value.timeout, 250);
  db.configure('limit', sqlite3.LIMIT_ATTACHED, 0);
  const attach = await failure(call(db, 'exec', `ATTACH '${file()}' AS other`));
  assert.equal(attach.message, 'SQLITE_ERROR: too many attached databases - max 0');
  db.configure('limit', sqlite3.LIMIT_ATTACHED, 2);
  await call(db, 'exec', `ATTACH '${file()}' AS other`);
  await call(db, 'close');
});

test('callbacks run inside a sqlite3 async resource', async () => {
  const db = await open();
  let firstId = null;
  const hook = createHook({init(asyncId, type) { if (firstId === null && type.startsWith('sqlite3.')) firstId = asyncId; }}).enable();
  const inside = await new Promise(resolve => db.run('SELECT 1', () => resolve(executionAsyncId())));
  hook.disable();
  assert.equal(inside, firstId);
  await call(db, 'close');
});

test('database files are created and shared-cache URIs work', async () => {
  const name = file();
  const db = await open(name);
  await call(db, 'exec', 'PRAGMA user_version = 7');
  await call(db, 'close');
  assert.equal(existsSync(name), true);
  const uri = `file:${name}?mode=memory&cache=shared`;
  const a = await open(uri, sqlite3.OPEN_URI | sqlite3.OPEN_SHAREDCACHE | sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE);
  const b = await open(uri, sqlite3.OPEN_URI | sqlite3.OPEN_SHAREDCACHE | sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE);
  await call(a, 'exec', 'PRAGMA user_version = 42');
  assert.equal((await call(b, 'get', 'PRAGMA user_version')).value.user_version, 42);
  await call(a, 'close');
  await call(b, 'close');
});
