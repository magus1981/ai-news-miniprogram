const { commitFrontier } = require('./utils/readmark');

App({
  globalData: {
    // API基础地址 - 开发时用localhost，部署后改为Vercel地址
    apiBase: 'http://localhost:3000',
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
