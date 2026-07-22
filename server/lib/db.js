/**
 * Turso 数据库连接（服务端）
 */
const { createClient } = require('@libsql/client');

let client = null;

function getDB() {
  if (!client) {
    const url = process.env.TURSO_URL;
    const authToken = process.env.TURSO_AUTH_TOKEN;

    if (!url || !authToken) {
      throw new Error('缺少 TURSO_URL 或 TURSO_AUTH_TOKEN 环境变量');
    }

    client = createClient({ url, authToken });
  }
  return client;
}

module.exports = { getDB };
