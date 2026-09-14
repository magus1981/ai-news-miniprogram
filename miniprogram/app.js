const { commitFrontier } = require('./utils/readmark');

App({
  globalData: {
    // 接口地址统一以 utils/config.js 的 apiBase 为准（由 utils/api.js 引用）。
    // 此处不再重复配置一份地址，避免出现第二份 localhost 值误导排障。
  },

  onLaunch() {
    console.log('AI前沿资讯 小程序启动');
  },

  // 退到后台才算「这一程读完了」，此时提交阅读水位线。
  // 页内跳转（首页→详情页）不触发 App.onHide，所以用户点开一条补读再返回时，
  // 补读区不会在脚下消失。
  onHide() {
    commitFrontier();
  },
});
