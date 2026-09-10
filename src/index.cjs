'use strict';
// The node-sqlite3 (`sqlite3`) callback API implemented on node:sqlite. No native addon, no prebuilt binaries.
const {DatabaseSync, backup: nativeBackup} = require('node:sqlite');
const {EventEmitter} = require('node:events');
const {AsyncResource} = require('node:async_hooks');
const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');

const constants = {
  OPEN_READONLY: 1, OPEN_READWRITE: 2, OPEN_CREATE: 4, OPEN_URI: 0x40, OPEN_SHAREDCACHE: 0x20000, OPEN_PRIVATECACHE: 0x40000, OPEN_FULLMUTEX: 0x10000,
  OK: 0, ERROR: 1, INTERNAL: 2, PERM: 3, ABORT: 4, BUSY: 5, LOCKED: 6, NOMEM: 7, READONLY: 8, INTERRUPT: 9, IOERR: 10, CORRUPT: 11, NOTFOUND: 12,
  FULL: 13, CANTOPEN: 14, PROTOCOL: 15, EMPTY: 16, SCHEMA: 17, TOOBIG: 18, CONSTRAINT: 19, MISMATCH: 20, MISUSE: 21, NOLFS: 22, AUTH: 23,
  FORMAT: 24, RANGE: 25, NOTADB: 26,
  LIMIT_LENGTH: 0, LIMIT_SQL_LENGTH: 1, LIMIT_COLUMN: 2, LIMIT_EXPR_DEPTH: 3, LIMIT_COMPOUND_SELECT: 4, LIMIT_VDBE_OP: 5, LIMIT_FUNCTION_ARG: 6,
  LIMIT_ATTACHED: 7, LIMIT_LIKE_PATTERN_LENGTH: 8, LIMIT_VARIABLE_NUMBER: 9, LIMIT_TRIGGER_DEPTH: 10, LIMIT_WORKER_THREADS: 11,
};
const codeNames = ['SQLITE_OK', 'SQLITE_ERROR', 'SQLITE_INTERNAL', 'SQLITE_PERM', 'SQLITE_ABORT', 'SQLITE_BUSY', 'SQLITE_LOCKED', 'SQLITE_NOMEM',
  'SQLITE_READONLY', 'SQLITE_INTERRUPT', 'SQLITE_IOERR', 'SQLITE_CORRUPT', 'SQLITE_NOTFOUND', 'SQLITE_FULL', 'SQLITE_CANTOPEN', 'SQLITE_PROTOCOL',
  'SQLITE_EMPTY', 'SQLITE_SCHEMA', 'SQLITE_TOOBIG', 'SQLITE_CONSTRAINT', 'SQLITE_MISMATCH', 'SQLITE_MISUSE', 'SQLITE_NOLFS', 'SQLITE_AUTH',
  'SQLITE_FORMAT', 'SQLITE_RANGE', 'SQLITE_NOTADB'];
const limitNames = ['length', 'sqlLength', 'column', 'exprDepth', 'compoundSelect', 'vdbeOp', 'functionArg', 'attach', 'likePatternLength', 'variableNumber', 'triggerDepth'];

const versionInfo = (() => {
  const probe = new DatabaseSync(':memory:');
  const row = probe.prepare('SELECT sqlite_version() AS v, sqlite_source_id() AS s').get();
  probe.close();
  const [major, minor, patch] = row.v.split('.').map(Number);
  return {VERSION: row.v, SOURCE_ID: row.s, VERSION_NUMBER: major * 1000000 + minor * 1000 + (patch || 0)};
})();

function sqliteError(code, message) {
  const name = codeNames[code] || 'SQLITE_ERROR';
  const error = new Error(`${name}: ${message}`);
  error.errno = code;
  error.code = name;
  return error;
}
function convertError(error) {
  if (error && error.errno !== undefined && error.code && String(error.code).startsWith('SQLITE_')) return error;
  if (error && typeof error.errcode === 'number') return sqliteError(error.errcode & 0xff, error.message || error.errstr);
  if (error && error.code === 'ERR_SQLITE_ERROR') return sqliteError(constants.ERROR, error.message);
  if (error && (error.code === 'ERR_INVALID_ARG_TYPE' || error.code === 'ERR_INVALID_STATE' || error.code === 'ERR_OUT_OF_RANGE' || error.code === 'ERR_INVALID_ARG_VALUE')) {
    if (/not open|closed|finalized/i.test(error.message)) return sqliteError(constants.MISUSE, error.message);
    return sqliteError(constants.RANGE, 'column index out of range');
  }
  return error;
}
const closedError = () => sqliteError(constants.MISUSE, 'Database handle is closed');
const isFunction = value => typeof value === 'function';

// --- binding -----------------------------------------------------------------------------------
function convertValue(value) {
  if (value === null || value === undefined) return null;
  switch (typeof value) {
    case 'number': return Number.isInteger(value) && Math.abs(value) < 2 ** 63 ? BigInt(value) : value;
    case 'string': return value;
    case 'bigint': return value >= -(2n ** 63n) && value < 2n ** 63n ? value : Number(value);
    case 'boolean': return value ? 1n : 0n;
    case 'object': break;
    default: return {unsupported: true};
  }
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (value instanceof Date) return convertValue(value.valueOf());
  if (value instanceof RegExp) return String(value);
  try { return String(value); } catch { return null; }
}
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Buffer.isBuffer(value) || value instanceof Uint8Array || value instanceof ArrayBuffer || value instanceof Date || value instanceof RegExp) return false;
  return true;
}
const isNameChar = c => /[A-Za-z0-9_$]/.test(c);
// Ordered 1-based parameter slots of a statement: prefixed name for named parameters, null for anonymous ones.
function scanParameters(sql) {
  const slots = [];
  const named = new Map();
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (c === '-' && sql[i + 1] === '-') { const e = sql.indexOf('\n', i); i = e === -1 ? n : e + 1; continue; }
    if (c === '/' && sql[i + 1] === '*') { const e = sql.indexOf('*/', i + 2); i = e === -1 ? n : e + 2; continue; }
    if (c === "'" || c === '"' || c === '`') { let j = i + 1; while (j < n) { if (sql[j] === c) { if (sql[j + 1] === c) { j += 2; continue; } break; } j++; } i = j + 1; continue; }
    if (c === '[') { const e = sql.indexOf(']', i); i = e === -1 ? n : e + 1; continue; }
    if ((c === 'x' || c === 'X') && sql[i + 1] === "'") { const e = sql.indexOf("'", i + 2); i = e === -1 ? n : e + 1; continue; }
    if (c === '?') {
      let j = i + 1; while (j < n && sql[j] >= '0' && sql[j] <= '9') j++;
      const index = j > i + 1 ? Number(sql.slice(i + 1, j)) : slots.length + 1;
      while (slots.length < index) slots.push(undefined);
      if (slots[index - 1] === undefined) slots[index - 1] = null;
      i = j; continue;
    }
    if ((c === ':' || c === '@' || c === '$') && i + 1 < n && isNameChar(sql[i + 1])) {
      let j = i + 1; while (j < n && (isNameChar(sql[j]) || (c === '$' && sql[j] === ':'))) j++;
      const name = sql.slice(i, j);
      if (!named.has(name)) { named.set(name, slots.length + 1); slots.push(name); }
      i = j; continue;
    }
    i++;
  }
  return slots;
}
function positional(values, slots) {
  const converted = values.map(convertValue);
  if (!slots || !slots.some(slot => typeof slot === 'string')) return converted;
  const named = {};
  const anonymous = [];
  for (let k = 0; k < slots.length; k++) {
    const value = k < converted.length ? converted[k] : null;
    if (typeof slots[k] === 'string') named[slots[k]] = value; else anonymous.push(value);
  }
  return [named, ...anonymous];
}
// Returns the argument list for StatementSync methods: [named?, ...anonymous].
function normalizeParams(args, slots) {
  const values = args.filter(value => value !== undefined);
  if (values.length === 0) return [];
  if (values.length === 1 && Array.isArray(values[0])) return positional(values[0], slots);
  if (values.length === 1 && isPlainObject(values[0])) {
    const source = values[0];
    const keys = Object.keys(source);
    if (keys.length > 0 && keys.every(key => /^[1-9][0-9]*$/.test(key))) {
      const out = [];
      for (const key of keys) out[Number(key) - 1] = source[key];
      for (let k = 0; k < out.length; k++) if (out[k] === undefined) out[k] = null;
      return positional(out, slots);
    }
    const named = {};
    for (const key of keys) named[key] = convertValue(source[key]);
    return [named];
  }
  return positional(values, slots);
}
function convertRow(row) {
  if (row === undefined || row === null) return row;
  const out = {};
  for (const key of Object.keys(row)) {
    let value = row[key];
    if (typeof value === 'bigint') value = Number(value);
    else if (value instanceof Uint8Array && !Buffer.isBuffer(value)) value = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    out[key] = value;
  }
  return out;
}

// --- scheduling ------------------------------------------------------------------------------
function invoke(resource, callback, thisArg, args) {
  if (resource) return resource.runInAsyncScope(callback, thisArg, ...args);
  return callback.apply(thisArg, args);
}

function Database(filename, mode, callback) {
  if (!new.target) throw new TypeError("Class constructors cannot be invoked without 'new'");
  EventEmitter.call(this);
  if (typeof filename !== 'string') throw new TypeError('Filename is required');
  if (isFunction(mode)) { callback = mode; mode = undefined; }
  if (mode === undefined) mode = constants.OPEN_READWRITE | constants.OPEN_CREATE | constants.OPEN_FULLMUTEX;
  if (typeof mode !== 'number') throw new TypeError('Mode must be a number');
  this.filename = filename;
  this.mode = mode;
  this.open = false;
  Object.defineProperties(this, {
    _native: {value: null, writable: true},
    _queue: {value: [], writable: true},
    _head: {value: 0, writable: true},
    _draining: {value: false, writable: true},
    _closing: {value: false, writable: true},
    _closed: {value: false, writable: true},
    _statements: {value: new Set(), writable: true},
    _backups: {value: new Set(), writable: true},
    _serialized: {value: false, writable: true},
    _flags: {value: {trace: false, profile: false, change: false}, writable: true},
    _interrupted: {value: false, writable: true},
    _executing: {value: false, writable: true},
  });
  const resource = new AsyncResource('sqlite3.Database.open');
  this._enqueue(() => {
    try {
      this._native = openNative(filename, mode);
    } catch (error) {
      const converted = convertError(error);
      this._closed = true;
      if (callback) invoke(resource, callback, this, [converted]);
      else this.emit('error', converted);
      return;
    }
    this.open = true;
    this._executing = false;
    if (callback) invoke(resource, callback, this, [null]);
    this.emit('open');
  });
}
util.inherits(Database, EventEmitter);

function openNative(filename, mode) {
  const readOnly = (mode & constants.OPEN_READONLY) !== 0 && (mode & constants.OPEN_READWRITE) === 0;
  const isUri = filename.startsWith('file:');
  const anonymous = filename === '' || filename === ':memory:';
  if (!anonymous && !isUri && !(mode & constants.OPEN_CREATE) && !fs.existsSync(filename)) throw sqliteError(constants.CANTOPEN, 'unable to open database file');
  if (!anonymous && !isUri && (mode & constants.OPEN_CREATE) && !fs.existsSync(path.dirname(path.resolve(filename)))) throw sqliteError(constants.CANTOPEN, 'unable to open database file');
  let target = filename;
  if (!anonymous && (mode & constants.OPEN_SHAREDCACHE) && !/[?&]cache=/.test(filename)) {
    const uri = isUri ? filename : `file:${encodeURI(path.resolve(filename))}`;
    target = uri + (uri.includes('?') ? '&' : '?') + 'cache=shared';
  }
  try {
    return new DatabaseSync(target, {readOnly, allowExtension: true});
  } catch (error) {
    throw convertError(error);
  }
}

const proto = Database.prototype;

proto._enqueue = function (task) {
  this._queue.push(task);
  if (!this._draining) {
    this._draining = true;
    setImmediate(() => this._drain());
  }
};
proto._next = function () {
  if (this._head >= this._queue.length) return undefined;
  const task = this._queue[this._head];
  this._queue[this._head++] = undefined;
  if (this._head === this._queue.length) { this._queue.length = 0; this._head = 0; }
  else if (this._head > 4096 && this._head * 2 > this._queue.length) { this._queue = this._queue.slice(this._head); this._head = 0; }
  return task;
};
proto._drain = function () {
  let budget = 10000;
  let task;
  while (budget-- > 0 && (task = this._next()) !== undefined) {
    this._executing = true;
    try { task(); } catch (error) {
      this._executing = false;
      if (this._head < this._queue.length) setImmediate(() => this._drain()); else this._draining = false;
      throw error;
    }
    this._executing = false;
  }
  if (this._head < this._queue.length) setImmediate(() => this._drain());
  else this._draining = false;
};
proto._fail = function (error, callback, resource) {
  if (callback) invoke(resource, callback, this, [error]);
  else this.emit('error', error);
};

proto.serialize = function (callback) {
  const previous = this._serialized;
  this._serialized = true;
  if (isFunction(callback)) { try { callback.call(this); } finally { this._serialized = previous; } }
  return this;
};
proto.parallelize = function (callback) {
  const previous = this._serialized;
  this._serialized = false;
  if (isFunction(callback)) { try { callback.call(this); } finally { this._serialized = previous; } }
  return this;
};

proto.wait = function (callback) {
  const resource = new AsyncResource('sqlite3.Database.wait');
  this._enqueue(() => { if (callback) invoke(resource, callback, this, [null]); });
  return this;
};

proto.close = function (callback) {
  const resource = new AsyncResource('sqlite3.Database.close');
  if (this.open && !this._executing && this._head >= this._queue.length) this._closing = true;
  this._enqueue(() => {
    this._closing = true;
    if (this._closed || !this._native) {
      this._closing = false;
      return this._fail(sqliteError(constants.MISUSE, 'Database is closed'), callback, resource);
    }
    if (this._backups.size > 0) {
      this._closing = false;
      return this._fail(sqliteError(constants.BUSY, 'unable to close due to unfinalised statements or unfinished backups'), callback, resource);
    }
    if (this._statements.size > 0) {
      this._closing = false;
      return this._fail(sqliteError(constants.BUSY, 'unable to close due to unfinalised statements'), callback, resource);
    }
    try { this._native.close(); } catch (error) { this._closing = false; return this._fail(convertError(error), callback, resource); }
    this._closed = true;
    this._closing = false;
    this.open = false;
    this._executing = false;
    if (callback) invoke(resource, callback, this, [null]);
    this.emit('close');
  });
  return this;
};

proto.exec = function (sql, callback) {
  const resource = new AsyncResource('sqlite3.Database.exec');
  this._enqueue(() => {
    if (this._closed || !this._native) return this._fail(closedError(), callback, resource);
    try { this._native.exec(sql); } catch (error) { return this._fail(convertError(error), callback, resource); }
    this._executing = false;
    if (callback) invoke(resource, callback, this, [null]);
  });
  return this;
};

proto.configure = function (option, value, extra) {
  switch (option) {
    case 'trace': case 'profile': case 'change': this._flags[option] = Boolean(value); return;
    case 'busyTimeout':
      this._enqueue(() => { if (this._native && !this._closed) this._native.exec(`PRAGMA busy_timeout = ${Number(value) | 0}`); });
      return;
    case 'limit': {
      const name = limitNames[value];
      this._enqueue(() => { if (this._native && !this._closed && name) this._native.limits[name] = extra; });
      return;
    }
    default: throw new Error(`Unknown option: ${option}`);
  }
};

proto.loadExtension = function (filename, callback) {
  const resource = new AsyncResource('sqlite3.Database.loadExtension');
  this._enqueue(() => {
    if (this._closed || !this._native) return this._fail(closedError(), callback, resource);
    try { this._native.enableLoadExtension(true); this._native.loadExtension(filename); } catch (error) { return this._fail(convertError(error), callback, resource); }
    finally { try { this._native.enableLoadExtension(false); } catch {} }
    if (callback) invoke(resource, callback, this, [null]);
  });
  return this;
};

proto.interrupt = function () {
  if (this._closing) throw new Error('Database is closing');
  if (!this.open || this._closed) throw new Error('Database is not open');
  this._interrupted = true;
};

const supportedEvents = ['trace', 'profile', 'change'];
proto.addListener = proto.on = function (type) {
  const value = EventEmitter.prototype.addListener.apply(this, arguments);
  if (supportedEvents.includes(type)) this.configure(type, true);
  return value;
};
proto.removeListener = function (type) {
  const value = EventEmitter.prototype.removeListener.apply(this, arguments);
  if (supportedEvents.includes(type) && this.listenerCount(type) === 0) this.configure(type, false);
  return value;
};
proto.removeAllListeners = function (type) {
  const value = EventEmitter.prototype.removeAllListeners.apply(this, arguments);
  if (supportedEvents.includes(type)) this.configure(type, false);
  else if (type === undefined) for (const name of supportedEvents) this.configure(name, false);
  return value;
};

// --- statements ---------------------------------------------------------------------------------
function Statement(db, sql, callback, resource) {
  if (!new.target) throw new TypeError("Class constructors cannot be invoked without 'new'");
  EventEmitter.call(this);
  this.sql = sql;
  this.lastID = 0;
  this.changes = 0;
  Object.defineProperties(this, {
    _db: {value: db},
    _native: {value: null, writable: true},
    _params: {value: [], writable: true},
    _cursor: {value: null, writable: true},
    _exhausted: {value: false, writable: true},
    _finalized: {value: false, writable: true},
    _failed: {value: false, writable: true},
    _resource: {value: resource || null, writable: true},
    _slots: {value: null, writable: true},
  });
  resource = resource || new AsyncResource('sqlite3.Statement.prepare');
  db._enqueue(() => {
    if (db._closed || !db._native) { this._failed = true; return this._error(closedError(), callback, resource, db); }
    if (typeof sql !== 'string') { this._failed = true; return this._error(sqliteError(constants.MISUSE, 'SQL query expected'), callback, resource); }
    try {
      this._native = db._native.prepare(sql);
      this._native.setReadBigInts(true);
      this._slots = scanParameters(sql);
    } catch (error) {
      this._failed = true;
      return this._error(convertError(error), callback, resource);
    }
    db._statements.add(this);
    db._executing = false;
    if (callback) invoke(resource, callback, this, [null]);
  });
}
util.inherits(Statement, EventEmitter);
const sproto = Statement.prototype;

sproto._error = function (error, callback, resource, emitter) {
  if (callback) return invoke(resource, callback, this, [error]);
  const target = emitter || this;
  if (target.listenerCount('error') > 0) target.emit('error', error);
};
function splitCallback(args) {
  let callback;
  if (args.length && isFunction(args[args.length - 1])) callback = args.pop();
  return callback;
}
sproto._schedule = function (name, args, work) {
  const callback = splitCallback(args);
  const resource = this._resource || new AsyncResource(`sqlite3.Statement.${name}`);
  const db = this._db;
  db._enqueue(() => {
    if (this._failed) return;
    if (this._finalized) return this._error(sqliteError(constants.MISUSE, 'Statement is already finalized'), callback, resource);
    if (db._closed || !db._native) return this._error(closedError(), callback, resource);
    let result;
    try {
      if (args.length) { this._params = normalizeParams(args, this._slots); this._resetCursor(); }
      result = work(callback, resource);
    } catch (error) {
      db._executing = false;
      return this._error(convertError(error), callback, resource);
    }
    db._executing = false;
    if (result !== undefined && callback) invoke(resource, callback, this, result);
  });
  return this;
};
sproto._resetCursor = function () {
  if (this._cursor) { try { this._cursor.return(); } catch {} }
  this._cursor = null;
  this._exhausted = false;
};
sproto._trace = function () {
  return this._db._flags.profile ? process.hrtime.bigint() : null;
};
// Emits trace/profile once the parameters are bound, so the expanded SQL carries the bound values.
sproto._profile = function (started) {
  const db = this._db;
  if (db._flags.trace) db.emit('trace', this._native.expandedSQL);
  if (started !== null) db.emit('profile', this._native.expandedSQL, Number(process.hrtime.bigint() - started) / 1e6);
};
sproto._checkInterrupt = function () {
  if (this._db._interrupted) { this._db._interrupted = false; throw sqliteError(constants.INTERRUPT, 'interrupted'); }
};

sproto.bind = function () {
  const args = Array.prototype.slice.call(arguments);
  return this._schedule('bind', args, () => { if (!args.length) { this._params = []; this._resetCursor(); } return [null]; });
};
sproto.reset = function (callback) {
  return this._schedule('reset', callback ? [callback] : [], () => { this._resetCursor(); return [null]; });
};
sproto.finalize = function (callback) {
  const resource = this._resource || new AsyncResource('sqlite3.Statement.finalize');
  const db = this._db;
  db._enqueue(() => {
    if (!this._finalized && !this._failed) {
      this._resetCursor();
      this._finalized = true;
      db._statements.delete(this);
      if (this._native && typeof this._native.close === 'function') { try { this._native.close(); } catch {} }
    }
    if (callback) invoke(resource, callback, this, [null]);
  });
  return db;
};
sproto.run = function () {
  const args = Array.prototype.slice.call(arguments);
  return this._schedule('run', args, () => {
    this._resetCursor();
    const started = this._trace();
    const info = this._native.run(...this._params);
    this._profile(started);
    this.lastID = Number(info.lastInsertRowid);
    this.changes = Number(info.changes);
    return [null];
  });
};
sproto.get = function () {
  const args = Array.prototype.slice.call(arguments);
  return this._schedule('get', args, () => {
    if (this._exhausted) return [null, undefined];
    if (!this._cursor) {
      const started = this._trace();
      this._cursor = this._native.iterate(...this._params);
      this._profile(started);
    }
    const next = this._cursor.next();
    if (next.done) { this._exhausted = true; this._cursor = null; return [null, undefined]; }
    return [null, convertRow(next.value)];
  });
};
sproto.all = function () {
  const args = Array.prototype.slice.call(arguments);
  return this._schedule('all', args, () => {
    this._resetCursor();
    const started = this._trace();
    const rows = this._native.all(...this._params);
    this._profile(started);
    this._exhausted = true;
    for (let k = 0; k < rows.length; k++) rows[k] = convertRow(rows[k]);
    return [null, rows];
  });
};
sproto.each = function () {
  const args = Array.prototype.slice.call(arguments);
  let complete;
  let rowCallback;
  if (args.length && isFunction(args[args.length - 1])) {
    const last = args.pop();
    if (args.length && isFunction(args[args.length - 1])) { complete = last; rowCallback = args.pop(); } else rowCallback = last;
  }
  const finalCallback = complete || rowCallback;
  if (finalCallback) args.push(finalCallback);
  return this._schedule('each', args, (callback, resource) => {
    this._resetCursor();
    const started = this._trace();
    const iterator = this._native.iterate(...this._params);
    this._profile(started);
    let count = 0;
    try {
      for (const row of iterator) {
        count++;
        if (rowCallback) invoke(resource, rowCallback, this, [null, convertRow(row)]);
        this._checkInterrupt();
      }
    } catch (error) {
      try { iterator.return(); } catch {}
      const converted = convertError(error);
      this._exhausted = true;
      if (complete) invoke(resource, complete, this, [converted, count]);
      else if (rowCallback) invoke(resource, rowCallback, this, [converted]);
      return undefined;
    }
    this._exhausted = true;
    this._db._executing = false;
    if (complete) invoke(resource, complete, this, [null, count]);
    return undefined;
  });
};
sproto.map = function () {
  const params = Array.prototype.slice.call(arguments);
  const callback = params.pop();
  params.push(function (error, rows) {
    if (error) return callback(error);
    const result = {};
    if (rows.length) {
      const keys = Object.keys(rows[0]);
      const key = keys[0];
      if (keys.length > 2) for (const row of rows) result[row[key]] = row;
      else { const value = keys[1]; for (const row of rows) result[row[key]] = row[value]; }
    }
    callback(error, result);
  });
  return this.all.apply(this, params);
};

// --- Database helpers built on Statement -------------------------------------------------------
function normalizeMethod(name, fn) {
  return function (sql) {
    let errBack;
    const args = Array.prototype.slice.call(arguments, 1);
    if (isFunction(args[args.length - 1])) {
      const callback = args[args.length - 1];
      errBack = function (error) { if (error) callback(error); };
    }
    const resource = new AsyncResource(`sqlite3.Database.${name}`);
    const statement = new Statement(this, sql, errBack, resource);
    return fn.call(this, statement, args);
  };
}
proto.prepare = normalizeMethod('prepare', function (statement, params) { return params.length ? statement.bind.apply(statement, params) : statement; });
proto.run = normalizeMethod('run', function (statement, params) { statement.run.apply(statement, params).finalize(); return this; });
proto.get = normalizeMethod('get', function (statement, params) { statement.get.apply(statement, params).finalize(); return this; });
proto.all = normalizeMethod('all', function (statement, params) { statement.all.apply(statement, params).finalize(); return this; });
proto.each = normalizeMethod('each', function (statement, params) { statement.each.apply(statement, params).finalize(); return this; });
proto.map = normalizeMethod('map', function (statement, params) { statement.map.apply(statement, params).finalize(); return this; });

// --- backup --------------------------------------------------------------------------------------
function Backup(db, filename, sourceName, destName, filenameIsDest, callback) {
  if (!new.target) throw new TypeError("Class constructors cannot be invoked without 'new'");
  EventEmitter.call(this);
  this.idle = true;
  this.completed = false;
  this.failed = false;
  this.remaining = -1;
  this.pageCount = -1;
  this.retryErrors = [];
  Object.defineProperties(this, {
    _db: {value: db}, _filename: {value: filename}, _destName: {value: destName}, _sourceName: {value: sourceName},
    _filenameIsDest: {value: filenameIsDest}, _finished: {value: false, writable: true}, _active: {value: false, writable: true},
  });
  const resource = new AsyncResource('sqlite3.Backup.initialize');
  db._enqueue(() => {
    if (db._closed || !db._native) return this._fail(closedError(), callback, resource);
    if (!filenameIsDest) return this._fail(sqliteError(constants.MISUSE, 'backup from a file into an open connection is not available on node:sqlite'), callback, resource);
    db._backups.add(this);
    this._active = true;
    db._executing = false;
    if (callback) invoke(resource, callback, this, [null]);
  });
}
util.inherits(Backup, EventEmitter);
Backup.prototype._fail = function (error, callback, resource) {
  if (callback) return invoke(resource, callback, this, [error]);
  if (this.listenerCount('error') > 0) this.emit('error', error);
};
Backup.prototype._releaseHandle = function () {
  this._active = false;
  this._db._backups.delete(this);
};
// Mirrors node-sqlite3: a step whose status is not OK releases the SQLite backup handle unless the status is listed in retryErrors.
Backup.prototype._afterStep = function (status) {
  if (status !== constants.OK && this.retryErrors.length > 0 && !this.retryErrors.includes(status)) this._releaseHandle();
  if (status === 101) this.completed = true;
  else if (!this._active) this.failed = true;
};
Backup.prototype.step = function (pages, callback) {
  const db = this._db;
  const resource = new AsyncResource('sqlite3.Backup.step');
  this.idle = false;
  db._enqueue(() => {
    if (this._finished) { this.idle = true; return this._fail(sqliteError(constants.MISUSE, 'Backup is already finished'), callback, resource); }
    if (db._closed || !db._native) { this.idle = true; return this._fail(closedError(), callback, resource); }
    const source = this._sourceName === 'main' ? 'main' : this._sourceName;
    let pageCount;
    try { pageCount = Number(db._native.prepare(`PRAGMA "${source.replace(/"/g, '""')}".page_count`).get().page_count); } catch (error) { this.idle = true; return this._fail(convertError(error), callback, resource); }
    if (this.pageCount < 0) { this.pageCount = pageCount; this.remaining = pageCount; }
    if (!this._active) { this.idle = true; this.failed = true; return this._fail(sqliteError(constants.MISUSE, 'Backup is already finished'), callback, resource); }
    if (pages === 0) { this.idle = true; if (callback) invoke(resource, callback, this, [null, false]); return; }
    let pending;
    try { pending = nativeBackup(db._native, this._filename, {source, target: this._destName}); } catch (error) { this.idle = true; return this._fail(convertError(error), callback, resource); }
    // Node 26.8 settles the backup promise only when another task wakes the event loop; keep it awake until then.
    const keepAlive = setInterval(() => {}, 10);
    pending.finally(() => clearInterval(keepAlive));
    pending.then(() => {
      this.remaining = 0;
      this._afterStep(101);
      this.idle = true;
      if (callback) invoke(resource, callback, this, [null, true]);
    }, error => {
      const converted = error && error.errcode === 0 ? sqliteError(constants.BUSY, 'database is locked') : convertError(error);
      this._afterStep(converted.errno);
      this.idle = true;
      if (callback) invoke(resource, callback, this, [converted]);
      else if (this.listenerCount('error') > 0) this.emit('error', converted);
    });
  });
  return this;
};
Backup.prototype.finish = function (callback) {
  const db = this._db;
  const resource = new AsyncResource('sqlite3.Backup.finish');
  db._enqueue(() => {
    if (!this._finished) {
      if (!this.completed && !this.failed) this.failed = true;
      this._finished = true;
      this._releaseHandle();
    }
    db._executing = false;
    if (callback) invoke(resource, callback, this, [null]);
  });
  return this;
};
proto.backup = function () {
  let backup;
  if (arguments.length <= 2) backup = new Backup(this, arguments[0], 'main', 'main', true, arguments[1]);
  else backup = new Backup(this, arguments[0], arguments[1], arguments[2], arguments[3], arguments[4]);
  backup.retryErrors = [constants.BUSY, constants.LOCKED];
  return backup;
};

// --- module surface ------------------------------------------------------------------------------
const sqlite3 = {...constants, ...versionInfo, Database, Statement, Backup};
sqlite3.cached = {
  Database: function (file, a, b) {
    if (file === '' || file === ':memory:') return new Database(file, a, b);
    let db;
    file = path.resolve(file);
    if (!sqlite3.cached.objects[file]) db = sqlite3.cached.objects[file] = new Database(file, a, b);
    else {
      db = sqlite3.cached.objects[file];
      const callback = typeof a === 'number' ? b : a;
      if (isFunction(callback)) {
        const cb = () => callback.call(db, null);
        if (db.open) process.nextTick(cb); else db.once('open', cb);
      }
    }
    return db;
  },
  objects: {},
};
let isVerbose = false;
function extendTrace(object, property, pos) {
  const old = object[property];
  object[property] = function () {
    const error = new Error();
    const name = `${object.constructor.name}#${property}(${Array.prototype.slice.call(arguments).map(el => util.inspect(el, false, 0)).join(', ')})`;
    if (pos === undefined) pos = -1;
    if (pos < 0) pos += arguments.length;
    const cb = arguments[pos];
    if (isFunction(cb)) {
      arguments[pos] = function replacement() {
        const err = arguments[0];
        if (err && err.stack && !err.__augmented) {
          err.stack = filterStack(err).join('\n') + '\n--> in ' + name + '\n' + filterStack(error).slice(1).join('\n');
          err.__augmented = true;
        }
        return cb.apply(this, arguments);
      };
    }
    return old.apply(this, arguments);
  };
}
function filterStack(error) { return error.stack.split('\n').filter(line => !line.includes(__filename)); }
sqlite3.verbose = function () {
  if (!isVerbose) {
    for (const name of ['prepare', 'get', 'run', 'all', 'each', 'map', 'close', 'exec']) extendTrace(Database.prototype, name);
    for (const name of ['bind', 'get', 'run', 'all', 'each', 'map', 'reset', 'finalize']) extendTrace(Statement.prototype, name);
    isVerbose = true;
  }
  return sqlite3;
};
module.exports = sqlite3;
