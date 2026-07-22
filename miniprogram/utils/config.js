/**
 * 环境配置
 * 开发时用localhost，部署后改为Vercel地址
 */

// 切换环境：dev / prod
const ENV = 'dev';

const CONFIG = {
  dev: {
    // 真机测试：localtunnel 公网隧道（转发到本机 3000 端口）
    // 仅模拟器测试可改回 http://localhost:3000；局域网可用时用 http://10.0.193.110:3000
    apiBase: 'https://county-lotus-craig-dry.trycloudflare.com',
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
