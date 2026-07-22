/**
 * 加载 pipeline/.env（如果存在）
 * Node >= 20.6 原生支持 process.loadEnvFile()，零依赖
 * 注意：必须在所有读取 process.env 的模块之前 import（ESM 按 import 顺序求值）
 * 已有同名环境变量不会被覆盖；.env 不存在时静默跳过（CI 用 secrets 注入）
 */
try {
  process.loadEnvFile(new URL('./.env', import.meta.url));
} catch {
  // .env 不存在（如 GitHub Actions 用 secrets 注入），忽略
}
