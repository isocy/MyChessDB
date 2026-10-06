// A small stand-in for Cloudflare's D1 binding on top of Node's built-in
// SQLite, so the Worker can run locally (tests and scripts/dev_server.mjs)
// without wrangler. It implements the parts of the D1 API the Worker uses:
// prepare().bind().first() / all() / run(), and batch() as one transaction.
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

class Statement {
  constructor(db, sql, params = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }

  bind(...params) {
    // Real D1 refuses undefined; fail the same way so tests catch it.
    params.forEach((value, index) => {
      if (value === undefined) throw new TypeError(`D1_TYPE_ERROR: parameter ${index + 1} is undefined`);
    });
    return new Statement(this.db, this.sql, params.map(value => (typeof value === "boolean" ? Number(value) : value)));
  }

  _execute() {
    const statement = this.db.prepare(this.sql);
    const results = statement.all(...this.params);
    return { success: true, results, meta: {} };
  }

  async all() { return this._execute(); }
  async run() { return this._execute(); }

  async first(column) {
    const row = this._execute().results[0];
    if (row === undefined) return null;
    return column ? row[column] : row;
  }
}

export class LocalD1 {
  /** @param {string} file path of the SQLite file, or ":memory:" */
  constructor(file = ":memory:") {
    this.db = new DatabaseSync(file);
  }

  prepare(sql) {
    return new Statement(this.db, sql);
  }

  async batch(statements) {
    this.db.exec("BEGIN");
    try {
      const results = statements.map(statement => statement._execute());
      this.db.exec("COMMIT");
      return results;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async exec(sql) {
    this.db.exec(sql);
    return { count: 1 };
  }

  /** Apply every .sql file in a migrations directory, in name order. */
  migrate(directory) {
    for (const name of readdirSync(directory).filter(file => file.endsWith(".sql")).sort()) {
      this.db.exec(readFileSync(join(directory, name), "utf8"));
    }
    return this;
  }
}
