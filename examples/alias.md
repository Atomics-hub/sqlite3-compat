# Using sqlite3-compat where a library requires `sqlite3`

```sh
npm install sqlite3@npm:sqlite3-compat
```

`require('sqlite3')` now resolves to this package. Sequelize, Knex, TypeORM, the `sqlite` wrapper and Node-RED's sqlite node all work this way.

When a dependency declares a peer range on `sqlite3` (TypeORM: `"sqlite3": "^5.0.3"` as an optional peer), npm compares the range with this package's version and refuses the install. Either:

```sh
npm install --legacy-peer-deps
```

or pin the alias through `overrides` in `package.json`:

```json
{
  "dependencies": {"sqlite3": "npm:sqlite3-compat@^0.1.0"},
  "overrides": {"sqlite3": "npm:sqlite3-compat@^0.1.0"}
}
```

## Sequelize

```js
const {Sequelize} = require('sequelize');
const sequelize = new Sequelize({dialect: 'sqlite', storage: 'app.db'});
```

## Knex

```js
const knex = require('knex')({client: 'sqlite3', connection: {filename: 'app.db'}, useNullAsDefault: true});
```

## `sqlite` (promise wrapper)

```js
import sqlite3 from 'sqlite3-compat';
import {open} from 'sqlite';
const db = await open({filename: 'app.db', driver: sqlite3.Database});
```
