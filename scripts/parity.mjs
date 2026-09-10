// Runs node-sqlite3's own test suite (test/parity/node-sqlite3, BSD-3-Clause) against this package, one file at a time,
// and compares the outcome with the expectations recorded in test/parity/expected.json.
// Usage: node scripts/parity.mjs [--update]
import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync, cpSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
const root = fileURLToPath(new URL('../', import.meta.url));
const suite = join(root, 'test/parity/node-sqlite3');
const work = join(root, `temp/parity-${process.pid}`);
rmSync(work, {recursive: true, force: true});
mkdirSync(join(work, 'test'), {recursive: true});
mkdirSync(join(work, 'lib'), {recursive: true});
cpSync(suite, join(work, 'test'), {recursive: true});
mkdirSync(join(work, 'test/tmp'), {recursive: true});
const entry = `module.exports = require(${JSON.stringify(join(root, 'dist/index.cjs'))});\n`;
writeFileSync(join(work, 'index.js'), entry);
writeFileSync(join(work, 'lib/sqlite3.js'), entry);
writeFileSync(join(work, 'package.json'), '{"private":true}\n');
// The upstream suite builds test/support/big.db (one million rows) with its own createdb script; build it directly.
const big = new DatabaseSync(join(work, 'test/support/big.db'));
big.exec('CREATE TABLE foo (id INT, txt TEXT)');
big.exec('BEGIN');
const insert = big.prepare('INSERT INTO foo VALUES(?, ?)');
const chars = 'abcdefghijklmnopqrstuvwxzyABCDEFGHIJKLMNOPQRSTUVWXZY0123456789  ';
for (let i = 0; i < 1000000; i++) {
  let text = '';
  for (let k = Math.random() * 100; k > 0; k--) text += chars[Math.floor(Math.random() * chars.length)];
  insert.run(i, text);
}
big.exec('COMMIT');
big.close();
const mocha = join(root, 'node_modules/mocha/bin/mocha.js');
const files = readdirSync(join(work, 'test')).filter(f => f.endsWith('.test.js')).sort();
const results = {};
let pass = 0, fail = 0;
for (const file of files) {
  const output = join(work, `${file}.json`);
  const out = spawnSync(process.execPath, [mocha, '--exit', '--timeout', '10000', '--reporter', 'json', '--reporter-option', `output=${output}`, `test/${file}`], {cwd: work, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 300000});
  let report;
  try { report = JSON.parse(readFileSync(output, 'utf8')); } catch { report = {stats: {passes: 0, failures: 1}, passes: [], failures: [{fullTitle: `${file} (no result: ${(out.stderr || '').split('\n').find(Boolean) || 'crash or timeout'})`}]}; }
  results[file] = {passes: report.passes.map(t => t.fullTitle), failures: report.failures.map(t => t.fullTitle)};
  pass += report.stats.passes; fail += report.stats.failures;
  console.log(`${file.padEnd(28)} pass ${String(report.stats.passes).padStart(3)} fail ${String(report.stats.failures).padStart(3)}`);
}
console.log(`total pass ${pass} fail ${fail} (node ${process.version})`);
const expectedPath = join(root, 'test/parity/expected.json');
const major = process.versions.node.split('.')[0];
const all = existsSync(expectedPath) ? JSON.parse(readFileSync(expectedPath, 'utf8')) : {};
if (process.argv.includes('--update')) {
  const expected = {};
  for (const [file, r] of Object.entries(results)) if (r.failures.length) expected[file] = r.failures;
  all[major] = expected;
  writeFileSync(expectedPath, JSON.stringify(all, null, 2) + '\n');
  console.log('updated', expectedPath, 'for node', major);
} else {
  const expected = all[major] ?? all[Object.keys(all).sort().pop()] ?? {};
  const unexpected = [];
  for (const [file, r] of Object.entries(results)) for (const title of r.failures) if (!(expected[file] || []).includes(title)) unexpected.push(`${file}: ${title}`);
  const minimum = Number(process.env.PARITY_MINIMUM || 160);
  if (unexpected.length) { console.error('Unexpected parity failures:\n' + unexpected.map(x => '  ' + x).join('\n')); process.exit(1); }
  if (pass < minimum) { console.error(`Parity below minimum: ${pass} < ${minimum}`); process.exit(1); }
  console.log('parity ok: no unexpected failures');
}
rmSync(work, {recursive: true, force: true});
