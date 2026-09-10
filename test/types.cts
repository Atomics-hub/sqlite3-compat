import sqlite3 = require('sqlite3-compat');
const db: sqlite3.Database = new sqlite3.Database(':memory:');
db.serialize(() => {
  db.run('CREATE TABLE t (a)');
  const stmt: sqlite3.Statement = db.prepare('INSERT INTO t VALUES (?)');
  stmt.run(1, function (this: sqlite3.RunResult, err: Error | null) { void err; void this.changes; }).finalize();
  db.all<{a: number}>('SELECT a FROM t', (err, rows) => { void err; const values: number[] = rows.map(r => r.a); void values; });
});
const constant: number = sqlite3.OK;
void constant;
db.close((err: Error | null) => { void err; });
