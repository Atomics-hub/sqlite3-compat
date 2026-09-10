/// <reference types="node" />
import type {EventEmitter} from 'node:events';

declare namespace sqlite3 {
  const OPEN_READONLY: number;
  const OPEN_READWRITE: number;
  const OPEN_CREATE: number;
  const OPEN_FULLMUTEX: number;
  const OPEN_SHAREDCACHE: number;
  const OPEN_PRIVATECACHE: number;
  const OPEN_URI: number;
  const VERSION: string;
  const SOURCE_ID: string;
  const VERSION_NUMBER: number;
  const OK: number;
  const ERROR: number;
  const INTERNAL: number;
  const PERM: number;
  const ABORT: number;
  const BUSY: number;
  const LOCKED: number;
  const NOMEM: number;
  const READONLY: number;
  const INTERRUPT: number;
  const IOERR: number;
  const CORRUPT: number;
  const NOTFOUND: number;
  const FULL: number;
  const CANTOPEN: number;
  const PROTOCOL: number;
  const EMPTY: number;
  const SCHEMA: number;
  const TOOBIG: number;
  const CONSTRAINT: number;
  const MISMATCH: number;
  const MISUSE: number;
  const NOLFS: number;
  const AUTH: number;
  const FORMAT: number;
  const RANGE: number;
  const NOTADB: number;
  const LIMIT_LENGTH: number;
  const LIMIT_SQL_LENGTH: number;
  const LIMIT_COLUMN: number;
  const LIMIT_EXPR_DEPTH: number;
  const LIMIT_COMPOUND_SELECT: number;
  const LIMIT_VDBE_OP: number;
  const LIMIT_FUNCTION_ARG: number;
  const LIMIT_ATTACHED: number;
  const LIMIT_LIKE_PATTERN_LENGTH: number;
  const LIMIT_VARIABLE_NUMBER: number;
  const LIMIT_TRIGGER_DEPTH: number;
  const LIMIT_WORKER_THREADS: number;

  /** Errors carry the SQLite result code as `errno` and its name (`SQLITE_ERROR`, `SQLITE_BUSY`, …) as `code`. */
  interface SqliteError extends Error {
    errno: number;
    code: string;
  }

  interface RunResult extends Statement {
    lastID: number;
    changes: number;
  }

  class Statement extends EventEmitter {
    readonly sql: string;
    lastID: number;
    changes: number;
    bind(callback?: (err: Error | null) => void): this;
    bind(...params: any[]): this;
    reset(callback?: (err: null) => void): this;
    finalize(callback?: (err: Error | null) => void): Database;
    run(callback?: (this: RunResult, err: Error | null) => void): this;
    run(params: any, callback?: (this: RunResult, err: Error | null) => void): this;
    run(...params: any[]): this;
    get<T = any>(callback?: (this: Statement, err: Error | null, row?: T) => void): this;
    get<T = any>(params: any, callback?: (this: Statement, err: Error | null, row?: T) => void): this;
    get(...params: any[]): this;
    all<T = any>(callback?: (this: Statement, err: Error | null, rows: T[]) => void): this;
    all<T = any>(params: any, callback?: (this: Statement, err: Error | null, rows: T[]) => void): this;
    all(...params: any[]): this;
    each<T = any>(callback?: (this: Statement, err: Error | null, row: T) => void, complete?: (err: Error | null, count: number) => void): this;
    each<T = any>(params: any, callback?: (this: Statement, err: Error | null, row: T) => void, complete?: (err: Error | null, count: number) => void): this;
    each(...params: any[]): this;
    map<T = any>(callback: (err: Error | null, result: Record<string, T>) => void): this;
    map<T = any>(params: any, callback: (err: Error | null, result: Record<string, T>) => void): this;
    map(...params: any[]): this;
  }

  class Backup extends EventEmitter {
    readonly idle: boolean;
    readonly completed: boolean;
    readonly failed: boolean;
    readonly remaining: number;
    readonly pageCount: number;
    retryErrors: number[];
    step(pages: number, callback?: (this: Backup, err: Error | null, completed?: boolean) => void): this;
    finish(callback?: (this: Backup, err: Error | null) => void): this;
  }

  class Database extends EventEmitter {
    constructor(filename: string, callback?: (this: Database, err: Error | null) => void);
    constructor(filename: string, mode?: number, callback?: (this: Database, err: Error | null) => void);
    readonly filename: string;
    readonly mode: number;
    readonly open: boolean;
    close(callback?: (this: Database, err: Error | null) => void): this;
    run(sql: string, callback?: (this: RunResult, err: Error | null) => void): this;
    run(sql: string, params: any, callback?: (this: RunResult, err: Error | null) => void): this;
    run(sql: string, ...params: any[]): this;
    get<T = any>(sql: string, callback?: (this: Statement, err: Error | null, row?: T) => void): this;
    get<T = any>(sql: string, params: any, callback?: (this: Statement, err: Error | null, row?: T) => void): this;
    get(sql: string, ...params: any[]): this;
    all<T = any>(sql: string, callback?: (this: Statement, err: Error | null, rows: T[]) => void): this;
    all<T = any>(sql: string, params: any, callback?: (this: Statement, err: Error | null, rows: T[]) => void): this;
    all(sql: string, ...params: any[]): this;
    each<T = any>(sql: string, callback?: (this: Statement, err: Error | null, row: T) => void, complete?: (err: Error | null, count: number) => void): this;
    each<T = any>(sql: string, params: any, callback?: (this: Statement, err: Error | null, row: T) => void, complete?: (err: Error | null, count: number) => void): this;
    each(sql: string, ...params: any[]): this;
    map<T = any>(sql: string, callback: (err: Error | null, result: Record<string, T>) => void): this;
    map<T = any>(sql: string, params: any, callback: (err: Error | null, result: Record<string, T>) => void): this;
    map(sql: string, ...params: any[]): this;
    exec(sql: string, callback?: (this: Database, err: Error | null) => void): this;
    prepare(sql: string, callback?: (this: Statement, err: Error | null) => void): Statement;
    prepare(sql: string, params: any, callback?: (this: Statement, err: Error | null) => void): Statement;
    prepare(sql: string, ...params: any[]): Statement;
    serialize(callback?: () => void): this;
    parallelize(callback?: () => void): this;
    on(event: 'trace', listener: (sql: string) => void): this;
    on(event: 'profile', listener: (sql: string, time: number) => void): this;
    on(event: 'change', listener: (type: string, database: string, table: string, rowid: number) => void): this;
    on(event: 'error', listener: (err: Error) => void): this;
    on(event: 'open' | 'close', listener: () => void): this;
    on(event: string, listener: (...args: any[]) => void): this;
    configure(option: 'busyTimeout', value: number): void;
    configure(option: 'limit', id: number, value: number): void;
    configure(option: 'trace' | 'profile' | 'change', enabled: boolean): void;
    loadExtension(filename: string, callback?: (this: Database, err: Error | null) => void): this;
    wait(callback?: (param: null) => void): this;
    interrupt(): void;
    backup(filename: string, callback?: (this: Backup, err: Error | null) => void): Backup;
    backup(filename: string, sourceName: string, destName: string, filenameIsDest: boolean, callback?: (this: Backup, err: Error | null) => void): Backup;
  }

  const cached: {
    Database(filename: string, callback?: (this: Database, err: Error | null) => void): Database;
    Database(filename: string, mode?: number, callback?: (this: Database, err: Error | null) => void): Database;
    objects: Record<string, Database>;
  };

  function verbose(): sqlite3;

  interface sqlite3 {
    OPEN_READONLY: number; OPEN_READWRITE: number; OPEN_CREATE: number; OPEN_FULLMUTEX: number; OPEN_SHAREDCACHE: number; OPEN_PRIVATECACHE: number; OPEN_URI: number;
    VERSION: string; SOURCE_ID: string; VERSION_NUMBER: number;
    OK: number; ERROR: number; INTERNAL: number; PERM: number; ABORT: number; BUSY: number; LOCKED: number; NOMEM: number; READONLY: number; INTERRUPT: number;
    IOERR: number; CORRUPT: number; NOTFOUND: number; FULL: number; CANTOPEN: number; PROTOCOL: number; EMPTY: number; SCHEMA: number; TOOBIG: number;
    CONSTRAINT: number; MISMATCH: number; MISUSE: number; NOLFS: number; AUTH: number; FORMAT: number; RANGE: number; NOTADB: number;
    LIMIT_LENGTH: number; LIMIT_SQL_LENGTH: number; LIMIT_COLUMN: number; LIMIT_EXPR_DEPTH: number; LIMIT_COMPOUND_SELECT: number; LIMIT_VDBE_OP: number;
    LIMIT_FUNCTION_ARG: number; LIMIT_ATTACHED: number; LIMIT_LIKE_PATTERN_LENGTH: number; LIMIT_VARIABLE_NUMBER: number; LIMIT_TRIGGER_DEPTH: number; LIMIT_WORKER_THREADS: number;
    cached: typeof cached;
    Statement: typeof Statement;
    Database: typeof Database;
    Backup: typeof Backup;
    verbose(): sqlite3;
  }
}

export = sqlite3;
