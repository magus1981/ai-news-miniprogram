/**
 * 环境配置
 * 开发环境（dev）指向本机/联调服务，部署后由 prod 段提供线上地址。
 *
 * ⚠️ 本文件必须以 UTF-8 编码保存：历史版本曾因 GBK↔UTF-8 往返把中文注释烧成
 *    不可逆乱码（apiBase 等值本身是 ASCII 不受影响，但注释一旦以非 UTF-8 保存即损坏）。
 *    改动前请确认编辑器/CI 落盘编码为 UTF-8。
 *
 * ⚠️ 当前 ENV = 'dev'，正式版需切到 'prod'。微信后台 request 合法域名白名单要求：
 *    必须是 https 且域名已完成 ICP 备案，否则真机请求会被拦截。
 *    （域名 / HTTPS 方案已明确暂缓，这里只登记待办，不代表已切换。）
 */

// 环境开关：'dev' 走联调地址，'prod' 走线上地址（下方 CONFIG 二选一暴露为 apiBase）
const ENV = 'dev';

const CONFIG = {
  dev: {
    // 真机联调地址：真机无法解析 localhost，必须用可被手机访问到的局域网/公网地址，
    // 且端口需与本机服务监听一致（当前为本机 3000 端口）。仅微信模拟器可改回 http://localhost:3000。
    apiBase: 'http://121.40.116.248:3000',
  },
  prod: {
    // 部署到 Vercel 后的正式接口地址（上线前须 https + 备案域名并入微信 request 白名单）。
    apiBase: 'https://ai-news-api.vercel.app',
  },
};

module.exports = {
  ENV,
  apiBase: CONFIG[ENV].apiBase,
};
