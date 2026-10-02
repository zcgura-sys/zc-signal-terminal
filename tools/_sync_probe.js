/* 同步探测：验证 .js 扩展名、中文内容、长行是否会被云端同步跳过 */
(function () {
  'use strict';
  const 中文 = '中文字符串用于测试编码判定';
  const long = Array.from({ length: 200 }, (_, i) => i).join(',');
  window.__zcSyncProbe = { 中文, long: long.length };
})();
