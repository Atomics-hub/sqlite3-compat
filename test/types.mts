import sqlite3, {Database, Statement, verbose, OPEN_READONLY, type RunResult} from 'sqlite3-compat';
const db: Database = new sqlite3.Database(':memory:', sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, function (err) { void err; void this.filename; });
db.run('INSERT INTO t VALUES (?)', 1, function (this: RunResult, err) { void err; const id: number = this.lastID; void id; });
db.get<{n: number}>('SELECT 1 AS n', (err, row) => { void err; const n: number | undefined = row?.n; void n; });
const stmt: Statement = db.prepare('SELECT ?').bind(1);
stmt.each((err, row: unknown) => { void err; void row; }, (err, count: number) => { void err; void count; }).finalize();
const backup = db.backup('copy.db');
backup.step(-1, function (err, completed) { void err; void completed; void this.remaining; });
db.configure('busyTimeout', 1000);
db.on('trace', (sql: string) => { void sql; });
verbose().Database;
const mode: number = OPEN_READONLY;
void [mode, sqlite3.cached.Database(':memory:')];
// @ts-expect-error a filename is required.
new sqlite3.Database();
db.close();
