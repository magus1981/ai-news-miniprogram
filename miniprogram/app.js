App({
  globalData: {
    // API基础地址 - 开发时用localhost，部署后改为Vercel地址
    apiBase: 'http://localhost:3000',
  },

  onLaunch() {
    console.log('AI前沿资讯 小程序启动');
  },
});
