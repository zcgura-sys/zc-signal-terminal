/* ---------- 液态玻璃：随指针移动的镜面高光（参考 kube.io / Apple Liquid Glass 的光照模型） ---------- */
(function zcGlassLight() {
  try {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    var SEL = '.composer,.dialog,.settings,.auth-card,.pop,.toast';
    var list = [], px = 0.5, py = 0.12, raf = 0, lastMove = 0, lastScan = 0;
    var scan = function () {
      var now = Date.now();
      if (!list.length || now - lastScan > 800) {
        lastScan = now;
        try { list = Array.prototype.slice.call(document.querySelectorAll(SEL)); } catch (e) { list = []; }
      }
      return list;
    };
    var paint = function () {
      raf = 0;
      var now = Date.now();
      if (now - lastMove > 1500) return; // 指针静止时停掉循环，节省电量
      var vw = window.innerWidth || 1, vh = window.innerHeight || 1;
      var items = scan(), read = [], i;
      for (i = 0; i < items.length; i++) {
        var r = items[i].getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && r.bottom > -300 && r.top < vh + 300) read.push([items[i], r]);
      }
      for (i = 0; i < read.length; i++) {
        var box = read[i][1];
        var lx = (px * vw - box.left) / box.width * 100;
        var ly = (py * vh - box.top) / box.height * 100;
        read[i][0].style.setProperty('--zc-lx', Math.max(-40, Math.min(140, lx)).toFixed(1) + '%');
        read[i][0].style.setProperty('--zc-ly', Math.max(-40, Math.min(140, ly)).toFixed(1) + '%');
      }
      raf = requestAnimationFrame(paint);
    };
    document.addEventListener('pointermove', function (e) {
      px = e.clientX / (window.innerWidth || 1);
      py = e.clientY / (window.innerHeight || 1);
      lastMove = Date.now();
      if (!raf) raf = requestAnimationFrame(paint);
    }, { passive: true });
    if (window.MutationObserver) {
      // 新打开的菜单 / 对话框也要拿到高光坐标
      new MutationObserver(function () { lastScan = 0; }).observe(document.documentElement, { childList: true, subtree: true });
    }
    scan();
  } catch (e) { /* 玻璃高光是纯装饰，失败不影响任何功能 */ }
})();
