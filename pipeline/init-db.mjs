/**
 * 数据库初始化脚本 - 仅创建表结构
 * 用法: node init-db.mjs
 */
import { initDB } from './db.mjs';

initDB().then(() => {
  console.log('初始化完成，可以运行 node collect.mjs 开始采集');
}).catch(err => {
  console.error('初始化失败:', err);
  process.exit(1);
});
