import assert from 'node:assert/strict';

const call = (target, method, ...args) => new Promise((resolve, reject) => target[method](...args, function (error, value) { error ? reject(error) : resolve({value, self: this}); }));

// Shared behavioral checks used by the unit tests and by the packed-consumer test in both module systems.
export async function runChecks(sqlite3) {
  let checks = 0;
  const db = new sqlite3.Database(':memory:');
  await new Promise((resolve, reject) => db.once('open', resolve).once('error', reject));
  assert.equal(db.open, true); checks++;
  await call(db, 'exec', 'CREATE TABLE cats (id INTEGER PRIMARY KEY, name TEXT NOT NULL, age INTEGER, photo BLOB)');
  const first = await call(db, 'run', 'INSERT INTO cats (name, age, photo) VALUES ($name, $age, $photo)', {$name: 'Joey', $age: 2, $photo: Buffer.from([1, 2])});
  assert.deepEqual([first.self.lastID, first.self.changes], [1, 1]); checks++;
  await call(db, 'run', 'INSERT INTO cats (name, age) VALUES (?, ?)', ['Sally', 4]);
  await call(db, 'run', 'INSERT INTO cats (name, age) VALUES (?, ?)', 'Junior', 1);
  const rows = (await call(db, 'all', 'SELECT name, age, photo FROM cats ORDER BY id')).value;
  assert.deepEqual(rows.map(r => r.name), ['Joey', 'Sally', 'Junior']); checks++;
  assert.ok(Buffer.isBuffer(rows[0].photo) && rows[1].photo === null); checks++;
  const one = (await call(db, 'get', 'SELECT age FROM cats WHERE name = ?', 'Sally')).value;
  assert.deepEqual(one, {age: 4}); checks++;
  assert.equal((await call(db, 'get', 'SELECT age FROM cats WHERE name = ?', 'nobody')).value, undefined); checks++;
  const statement = db.prepare('SELECT name FROM cats ORDER BY id');
  const a = (await call(statement, 'get')).value;
  const b = (await call(statement, 'get')).value;
  assert.deepEqual([a.name, b.name], ['Joey', 'Sally']); checks++;
  await call(statement, 'reset');
  assert.equal((await call(statement, 'get')).value.name, 'Joey'); checks++;
  await call(statement, 'finalize');
  const seen = [];
  const count = await new Promise((resolve, reject) => db.each('SELECT name FROM cats WHERE age > ?', 1, (error, row) => { if (error) reject(error); seen.push(row.name); }, (error, n) => error ? reject(error) : resolve(n)));
  assert.deepEqual([count, seen], [2, ['Joey', 'Sally']]); checks++;
  const duplicate = await call(db, 'run', 'INSERT INTO cats (id, name) VALUES (1, ?)', 'dup').catch(error => error);
  assert.equal(duplicate.code, 'SQLITE_CONSTRAINT'); assert.equal(duplicate.errno, sqlite3.CONSTRAINT); assert.match(duplicate.message, /^SQLITE_CONSTRAINT: UNIQUE constraint failed/); checks++;
  const missing = await call(db, 'all', 'SELECT * FROM nope').catch(error => error);
  assert.equal(missing.message, 'SQLITE_ERROR: no such table: nope'); checks++;
  const total = await new Promise((resolve, reject) => db.serialize(() => {
    db.run('BEGIN');
    const insert = db.prepare('INSERT INTO cats (name, age) VALUES (?, ?)');
    for (let i = 0; i < 100; i++) insert.run(`cat ${i}`, i);
    insert.finalize();
    db.run('COMMIT');
    db.get('SELECT count(*) AS n FROM cats', (error, row) => error ? reject(error) : resolve(row.n));
  }));
  assert.equal(total, 103); checks++;
  const traced = [];
  db.on('trace', sql => traced.push(sql));
  await call(db, 'run', 'UPDATE cats SET age = age + 1 WHERE id = ?', 2);
  assert.deepEqual(traced, ['UPDATE cats SET age = age + 1 WHERE id = 2']); checks++;
  await call(db, 'close');
  const closed = await call(db, 'run', 'SELECT 1').catch(error => error);
  assert.equal(closed.message, 'SQLITE_MISUSE: Database handle is closed'); checks++;
  return {checks};
}
