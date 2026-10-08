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

  /**
   * Apply the .sql files of a migrations directory that this database has
   * not seen yet, in name order, each one once (as wrangler does for D1).
   */
  migrate(directory) {
    this.db.exec("CREATE TABLE IF NOT EXISTS d1_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
    const applied = new Set(this.db.prepare("SELECT name FROM d1_migrations").all().map(row => row.name));
    // A database file from before migrations were recorded already has the
    // first one in it.
    if (!applied.size && this.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'saved_positions'").get()) {
      applied.add("0001_init.sql");
      this.db.prepare("INSERT INTO d1_migrations VALUES ('0001_init.sql', ?)").run(new Date().toISOString());
    }
    for (const name of readdirSync(directory).filter(file => file.endsWith(".sql")).sort()) {
      if (applied.has(name)) continue;
      this.db.exec("BEGIN");
      try {
        this.db.exec(readFileSync(join(directory, name), "utf8"));
        this.db.prepare("INSERT INTO d1_migrations VALUES (?, ?)").run(name, new Date().toISOString());
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw new Error(`Migration ${name} failed: ${error.message}`);
      }
    }
    return this;
  }
}
