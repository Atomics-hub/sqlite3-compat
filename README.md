# sqlite3-compat

The [`sqlite3`](https://github.com/TryGhost/node-sqlite3) (node-sqlite3) callback API on Node's built-in [`node:sqlite`](https://nodejs.org/api/sqlite.html). No native addon, no `node-pre-gyp` download, no rebuild after a Node or Electron upgrade: the same `Database`, `Statement` and `Backup` classes, the same `serialize()`/`parallelize()` scheduling, `trace`/`profile` events, `cached.Database`, `verbose()` stack traces, error `code`/`errno` values and constants.

```sh
npm install sqlite3-compat
```

```js
const sqlite3 = require('sqlite3-compat').verbose();
const db = new sqlite3.Database(':memory:');

db.serialize(() => {
  db.run('CREATE TABLE lorem (info TEXT)');
  const stmt = db.prepare('INSERT INTO lorem VALUES (?)');
  for (let i = 0; i < 10; i++) stmt.run('Ipsum ' + i);
  stmt.finalize();
  db.each('SELECT rowid AS id, info FROM lorem', (err, row) => console.log(row.id + ': ' + row.info));
});
db.close();
```

Requires Node.js 24.16 or later (Node 26 recommended). Deno and Bun do not provide `node:sqlite` with this surface.

## Drop-in use

- **Direct**: `import sqlite3 from 'sqlite3-compat'` or `require('sqlite3-compat')`.
- **Alias** for libraries that `require('sqlite3')` internally (Sequelize, TypeORM, Knex, the `sqlite` wrapper, session stores, Node-RED nodes):

```sh
npm install sqlite3@npm:sqlite3-compat
```

Libraries that declare a peer range on `sqlite3` (TypeORM expects `^5.0.3`) see this package's own version through the alias; add an `overrides` entry or install with `--legacy-peer-deps` in that case (see [examples/alias.md](examples/alias.md)).

Verified with Sequelize 6.37, TypeORM 0.3.30, Knex 3.1 and `sqlite` 5.1 (see [docs/compatibility.md](docs/compatibility.md)). Electron 41 and later ship Node 24.18+, so Electron apps get the same API with no `electron-rebuild` step.

## How compatible

node-sqlite3's own test suite runs unchanged in this repository's CI. On Node 24 and 26, **166 of its 171 tests** pass (node-sqlite3 6.0.1 itself passes 171 in the same environment). The five that do not need `sqlite3_update_hook` (`change` events, 3 tests), incremental backup steps (`step(pages)` copies everything, 1 test) and a backup from a file into an open connection (1 test); none of these has a `node:sqlite` primitive.

## What is different

- Statements execute synchronously on the main thread (that is how `node:sqlite` works) and callbacks are delivered afterwards, in order. node-sqlite3 runs statements on libuv's thread pool. Short statements are faster here (no thread hop); a statement that runs for seconds blocks the event loop for that long.
- `serialize()`/`parallelize()` keep their API and ordering guarantees, but work is always executed in call order, never concurrently.
- `db.on('change', …)` never fires: `node:sqlite` has no update hook.
- `db.interrupt()` stops an `each()` between rows with `SQLITE_INTERRUPT`; it cannot stop a single long-running `get()`, `all()` or `run()`.
- `Backup#step(pages)` copies all remaining pages in one step (`step(0)` still reports `pageCount`/`remaining` without copying); `db.backup(file, source, dest, false)` (file into the open connection) is unavailable.
- A backup into a locked destination reports `SQLITE_BUSY` (the underlying `node:sqlite` error carries no code).
- `OPEN_SHAREDCACHE` is applied by adding `cache=shared` to the (URI) filename; `OPEN_FULLMUTEX`, `OPEN_PRIVATECACHE` and `OPEN_URI` are accepted (URI filenames always work).
- Integers beyond 2^53 come back as lossy JavaScript numbers, like node-sqlite3.

## Performance

In-memory database, Node 24.21, one run each (`bench/perf.mjs` in the research notes): 200k `stmt.run()` inserts in one transaction 231 ms (node-sqlite3 2,063 ms); 20k sequential awaited `db.get()` 584 ms (542 ms); 20k `db.get()` issued at once 187 ms (434 ms); `all()` of 200k rows 154 ms (258 ms); `each()` over 100k rows 85 ms (82 ms); 20k `stmt.get()` on a reused statement 364 ms (228 ms); 20k `db.run()` updates 139 ms (469 ms). Statement-heavy workloads gain the most; single-row cursor reads on a reused statement are slower because each `get()` keeps a real cursor open.

## API

Everything in node-sqlite3's [API reference](https://github.com/TryGhost/node-sqlite3/wiki/API) except the differences above: `new Database(filename[, mode][, callback])`, `close`, `run`, `get`, `all`, `each`, `map`, `exec`, `prepare`, `serialize`, `parallelize`, `configure('busyTimeout' | 'limit' | 'trace' | 'profile')`, `loadExtension`, `wait`, `interrupt`, `backup`, the `open`/`close`/`error`/`trace`/`profile` events; `Statement` `bind`, `reset`, `finalize`, `run`, `get`, `all`, `each`, `map` with `this.lastID`/`this.changes`; `Backup` `step`, `finish`, `idle`, `completed`, `failed`, `remaining`, `pageCount`, `retryErrors`; `sqlite3.cached.Database`, `sqlite3.verbose()`, the `OPEN_*`, result-code and `LIMIT_*` constants, `VERSION`, `VERSION_NUMBER` and `SOURCE_ID`. Errors carry `code` (`'SQLITE_ERROR'`) and `errno`, and read `SQLITE_ERROR: no such table: foo` like node-sqlite3's.

## License

MIT. The parity suite under `test/parity/node-sqlite3` is node-sqlite3's test suite, BSD-3-Clause, Mapbox and Ghost Foundation; it is not part of the npm package.
