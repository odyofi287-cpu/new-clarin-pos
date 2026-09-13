export function isInMemoryDb(db) {
  return db && Array.isArray(db.sales) && Array.isArray(db.sale_items);
}

export function isPostgresDb(db) {
  return Boolean(db?.pool && typeof db.client === "function");
}

function toSqliteSql(pgSql) {
  return pgSql
    .replace(/\$\d+/g, "?")
    .replace(/\s+RETURNING\s+[^;]+$/i, "");
}

export async function dbAll(db, pgSql, params = [], sqliteSql) {
  if (isPostgresDb(db)) {
    const result = await db.client().query(pgSql, params);
    return result.rows;
  }
  return await db.prepare(sqliteSql || toSqliteSql(pgSql)).all(...params);
}

export async function dbGet(db, pgSql, params = [], sqliteSql) {
  if (isPostgresDb(db)) {
    const result = await db.client().query(pgSql, params);
    return result.rows[0];
  }
  return await db.prepare(sqliteSql || toSqliteSql(pgSql)).get(...params);
}

export async function dbRun(db, pgSql, params = [], sqliteSql) {
  if (isPostgresDb(db)) {
    const result = await db.client().query(pgSql, params);
    const firstRow = result.rows[0];
    return {
      changes: result.rowCount,
      lastInsertRowid: firstRow?.id,
      ...firstRow,
    };
  }
  return await db.prepare(sqliteSql || toSqliteSql(pgSql)).run(...params);
}

export async function withTransaction(db, fn) {
  if (db && typeof db.transaction === "function") {
    const tx = db.transaction(fn);
    return typeof tx === "function" ? await tx() : await tx;
  }
  return await fn();
}