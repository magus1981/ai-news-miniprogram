/**
 * 鐜閰嶇疆
 * 寮€鍙戞椂鐢╨ocalhost锛岄儴缃插悗鏀逛负Vercel鍦板潃
 */

// 鍒囨崲鐜锛歞ev / prod
const ENV = 'dev';

const CONFIG = {
  dev: {
    // 鐪熸満娴嬭瘯锛歝loudflared 鍏綉闅ч亾锛堣浆鍙戝埌鏈満 3000 绔彛锛?026-08-01 13:22 閲嶅缓锛?
    // 涓存椂鍩熷悕浼氳繃鏈燂細涓婁竴鏉￠毀閬撹窇浜嗙害12灏忔椂鍚庤繘绋嬭嚜宸遍€€浜嗭紝鍩熷悕璺熺潃娉ㄩ攢锛?
    // 鐜拌薄鏄皬绋嬪簭鎶?net::ERR_NAME_NOT_RESOLVED锛圖NS 瑙ｆ瀽涓嶄簡锛岃姹傛牴鏈病鍙戝嚭锛夛紱
    // 閲嶅缓闅ч亾鍚庡繀椤诲悓姝ユ澶勫苟閲嶆柊缂栬瘧銆備粎妯℃嫙鍣ㄥ彲鏀瑰洖 http://localhost:3000
    apiBase: 'http://121.40.116.248:3000',
  },
  prod: {
    // 閮ㄧ讲鍒癡ercel鍚庢浛鎹负瀹為檯鍦板潃
    apiBase: 'https://ai-news-api.vercel.app',
  },
};

module.exports = {
  ENV,
  apiBase: CONFIG[ENV].apiBase,
};
