'use strict';

// PostgreSQL 环境的通用 JSON 文档仓库。云托管环境变量配置完整时启用，
// 未配置时返回 null，让开发环境继续使用本地 JSON 文件。
function createCloudbaseRepository(options = {}) {
  const documentId = options.documentId || 'content';
  const defaultValue = options.defaultValue;
  const tableName = process.env.PG_TABLE || 'xianhua_content_documents';
  const config = {
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    ssl: { rejectUnauthorized: false },
    max: Number(process.env.PGPOOL_MAX || 3),
    idleTimeoutMillis: 30000
  };

  if (!config.host || !config.database || !config.user || !config.password) return null;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tableName)) throw new Error('PG_TABLE 只允许字母、数字和下划线');

  let poolPromise = null;
  let schemaPromise = null;

  async function getPool() {
    if (!poolPromise) {
      poolPromise = Promise.resolve().then(() => {
        let pg;
        try {
          pg = require('pg');
        } catch (error) {
          throw new Error('已配置 PostgreSQL，但 backend 未安装 pg');
        }
        return new pg.Pool(config);
      });
    }
    return poolPromise;
  }

  async function ensureSchema() {
    if (!schemaPromise) {
      schemaPromise = getPool().then(pool => pool.query(`
        CREATE TABLE IF NOT EXISTS ${tableName} (
          document_id TEXT PRIMARY KEY,
          value JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `));
    }
    return schemaPromise;
  }

  async function read() {
    const pool = await getPool();
    await ensureSchema();
    const result = await pool.query(`SELECT value FROM ${tableName} WHERE document_id = $1`, [documentId]);
    return result.rows[0] ? result.rows[0].value : defaultValue;
  }

  async function write(value) {
    const pool = await getPool();
    await ensureSchema();
    await pool.query(`
      INSERT INTO ${tableName} (document_id, value, updated_at)
      VALUES ($1, $2::jsonb, NOW())
      ON CONFLICT (document_id)
      DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `, [documentId, JSON.stringify(value)]);
  }

  return { read, write, filePath: `postgres://${tableName}/${documentId}` };
}

module.exports = { createCloudbaseRepository };
