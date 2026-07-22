/**
 * 环境配置
 * 开发时用localhost，部署后改为Vercel地址
 */

// 切换环境：dev / prod
const ENV = 'dev';

const CONFIG = {
  dev: {
    apiBase: 'http://localhost:3000',
  },
  prod: {
    // 部署到Vercel后替换为实际地址
    apiBase: 'https://ai-news-api.vercel.app',
  },
};

module.exports = {
  ENV,
  apiBase: CONFIG[ENV].apiBase,
};
