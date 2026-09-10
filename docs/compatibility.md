# Compatibility report

## Method

node-sqlite3 6.0.1's test suite (`test/parity/node-sqlite3`, BSD-3-Clause, unmodified apart from removing the node-webkit directory) is run one file at a time against this package by `scripts/parity.mjs`, which also generates the suite's million-row `big.db` fixture. `test/parity/expected.json` lists the tests known to fail per Node major line; CI fails on any additional failure or if fewer than 160 tests pass. The same suite passes 171 of 171 against node-sqlite3 itself in the same environment (the libspatialite extension tests are skipped by the suite when the extension is absent).

## Result (Node 24 and 26)

166 of 171 tests pass. The five failures:

| test | reason |
|---|---|
| `update_hook` (3 tests: insert, update, delete `change` events) | `node:sqlite` has no `sqlite3_update_hook` binding |
| `backup works if database is modified half-way through` | `step(pages)` copies all remaining pages; `node:sqlite`'s `backup()` cannot pause after a page count |
| `backup can backup from main to temp` | the source is a file and the destination the open connection; `node:sqlite` backs up from an open connection into a file only |

Everything else the suite exercises matches: open/close lifecycle and errors (`SQLITE_CANTOPEN`, `SQLITE_MISUSE`, `SQLITE_BUSY` on unfinalised statements), queued scheduling and closed-handle errors, statement cursors and re-running, parameter binding (positional, indexed, named, numeric keys, `undefined` skipping, Date/RegExp/boolean/BigInt/Buffer conversion, faulty `toString`), `lastID`/`changes`, `each` with completion callbacks over 100k rows, `exec` scripts, blobs, unicode, JSON and FTS, `map`, `cached.Database`, `verbose()` traces, `trace`/`profile` events and their enable/disable through listener registration, `configure('limit')`, `interrupt` during `each`, `serialize`/`parallelize`, async-hooks resource attribution, `Backup` state/`retryErrors`/close interaction, and prototype patching.

## Integrations

Installed as `sqlite3@file:` alias of this package (`--legacy-peer-deps` because TypeORM's optional peer range is `sqlite3@^5.0.3`):

- Sequelize 6.37.7 (`dialect: 'sqlite'`): sync, bulk create, where/order queries, update, count, transaction rollback, raw queries, BLOB round trip.
- TypeORM 0.3.30 (`type: 'sqlite'`): schema synchronize, insert/update/find/count, transactions, raw queries.
- Knex 3.1.0 (`client: 'sqlite3'`): schema builder, insert/update/select/aggregate, transaction rollback, raw queries.
- `sqlite` 5.1.1 (`open({driver: sqlite3.Database})`): run/get/all/each, prepared statements with named parameters.

## Deviations

- Synchronous execution on the main thread; callbacks are asynchronous and ordered. Long statements block the event loop.
- No `change` events.
- `interrupt()` takes effect between `each` rows only.
- `Backup#step` copies everything remaining; file-to-connection backups are unavailable; a locked destination is reported as `SQLITE_BUSY`.
- `OPEN_SHAREDCACHE` becomes `cache=shared` on a URI filename.
- `Statement#finalize` releases the prepared statement immediately on Node 26 (`StatementSync#close`) and at garbage collection on Node 24.
- Requires Node 24.16+ (`node:sqlite` with `backup()`, `limits`, `setReadBigInts` and `iterate`).

## Performance

See the README; numbers come from `work/hunt-2026-09-10b/sqlite3-lane/bench/perf.mjs` in the research workspace, run against node-sqlite3 6.0.1 on the same machine.
