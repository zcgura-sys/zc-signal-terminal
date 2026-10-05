/* ---------- 液态玻璃：随指针移动的镜面高光 + 追随指针的折射光池（参考 kube.io / Apple Liquid Glass 的光照模型） ---------- */
/* 性能要点：指针坐标在 JS 里做 lerp 平滑后逐帧写入 --zc-lx/--zc-ly；指针静止、页面
   隐藏、系统开启「减弱动态」时立刻停掉 rAF 循环，只在指针移动 / 页面滚动时才醒来。 */
(function zcGlassLight() {
  try {
    var root = document.documentElement;
    var mq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    var SEL = '.composer,.dialog,.settings,.auth-card,.pop,.toast';
    var list = [], raf = 0, lastScan = 0, running = false;
    var tx = 0.5, ty = 0.12, cx = 0.5, cy = 0.12; // 目标位置 / 当前显示位置（lerp）
    var lastMove = 0;
    var poolOK = !!(root && root.style && root.style.setProperty);

    function reduced() { try { return !!(mq && mq.matches); } catch (e) { return false; } }
    function stop() { if (raf) { cancelAnimationFrame(raf); raf = 0; } running = false; }
    function schedule() { if (!raf && !reduced() && !document.hidden) raf = requestAnimationFrame(paint); }

    function scan() {
      var now = Date.now();
      if (!list.length || now - lastScan > 800) {
        lastScan = now;
        try { list = Array.prototype.slice.call(document.querySelectorAll(SEL)); } catch (e) { list = []; }
      }
      return list;
    }

    function paint() {
      raf = 0;
      if (reduced() || document.hidden) { stop(); return; }
      var now = Date.now();
      cx += (tx - cx) * 0.24;
      cy += (ty - cy) * 0.24;
      var settled = Math.abs(tx - cx) < 0.0025 && Math.abs(ty - cy) < 0.0025;

      var vw = window.innerWidth || 1, vh = window.innerHeight || 1;
      var items = scan(), read = [], i;
      for (i = 0; i < items.length; i++) {
        var r = items[i].getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && r.bottom > -300 && r.top < vh + 300) read.push([items[i], r]);
      }
      for (i = 0; i < read.length; i++) {
        var box = read[i][1];
        var lx = (cx * vw - box.left) / box.width * 100;
        var ly = (cy * vh - box.top) / box.height * 100;
        read[i][0].style.setProperty('--zc-lx', Math.max(-40, Math.min(140, lx)).toFixed(1) + '%');
        read[i][0].style.setProperty('--zc-ly', Math.max(-40, Math.min(140, ly)).toFixed(1) + '%');
      }
      // 已经贴住目标、指针也安静了一阵：写完最后一帧就收工，省电
      if (settled && now - lastMove > 420) { running = false; return; }
      raf = requestAnimationFrame(paint);
    }

    function onMove(e) {
      var vw = window.innerWidth || 1, vh = window.innerHeight || 1;
      tx = e.clientX / vw;
      ty = e.clientY / vh;
      lastMove = Date.now();
      // 折射光池跟随指针：只改两个自定义属性，平滑过渡交给 CSS 的 transform transition
      if (poolOK) {
        root.style.setProperty('--zc-dx', Math.round(e.clientX) + 'px');
        root.style.setProperty('--zc-dy', Math.round(e.clientY) + 'px');
      }
      running = true;
      schedule();
    }

    // 页面滚动 / 尺寸变化时玻璃相对指针的位置也变了，需要重算高光
    function nudge() {
      if (reduced() || document.hidden) return;
      lastMove = Date.now() - 200; // 滚动期间持续刷新，停手后较快收尾
      running = true;
      schedule();
    }

    document.addEventListener('pointermove', onMove, { passive: true });
    document.addEventListener('pointerdown', onMove, { passive: true });
    // 指针离开窗口：高光缓缓回到默认角度
    document.addEventListener('pointerleave', function () {
      if (reduced()) return;
      tx = 0.5; ty = 0.12; lastMove = Date.now(); running = true; schedule();
    }, { passive: true });
    window.addEventListener('scroll', nudge, { passive: true, capture: true });
    window.addEventListener('resize', nudge, { passive: true });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) stop();
      else if (running) schedule();
    });
    if (mq) {
      if (mq.addEventListener) mq.addEventListener('change', function () { if (reduced()) stop(); });
      else if (mq.addListener) mq.addListener(function () { if (reduced()) stop(); });
    }
    if (window.MutationObserver) {
      // 新打开的菜单 / 对话框也要拿到高光坐标
      new MutationObserver(function () { lastScan = 0; }).observe(document.documentElement, { childList: true, subtree: true });
    }
    if (reduced()) return; // 减弱动态：完全交给 CSS 的静态玻璃
    scan();
  } catch (e) { /* 玻璃高光是纯装饰，失败不影响任何功能 */ }
})();
