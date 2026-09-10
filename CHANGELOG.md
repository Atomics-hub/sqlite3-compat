# Changelog

## 0.1.0

- node-sqlite3's `Database`, `Statement` and `Backup` API implemented on `node:sqlite`: open modes, queued execution with `serialize`/`parallelize`, `run`/`get`/`all`/`each`/`map`/`exec`/`prepare`, statement cursors (`get` steps, `reset`, `finalize`), binding by position, index (`?NNN`), name (`$`, `:`, `@`) and numeric keys, `lastID`/`changes`, `trace`/`profile`/`open`/`close`/`error` events, `configure('busyTimeout' | 'limit')`, `loadExtension`, `wait`, `interrupt` between `each` rows, `backup` with `retryErrors`, `cached.Database`, `verbose()` long stack traces, constants and version fields.
- node-sqlite3 error shapes (`SQLITE_ERROR: …` messages, `code`, `errno`), busy-connection close protection and callbacks that run inside `sqlite3.*` async resources.
- Passes 166 of the 171 tests of node-sqlite3 6.0.1's own suite on Node 24 and 26; the parity runner and expectations ship in the repository.
- Zero runtime dependencies; CommonJS and ESM entry points; TypeScript declarations.
