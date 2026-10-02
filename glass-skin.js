/* ZC-GLASS SCRIPT START */
(function () {
  'use strict';
  try {
    var root = document.documentElement;
    var KEY = 'zc_gura_glass';
    var reduced = false;
    try { reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) {}
    function read() {
      try { var v = localStorage.getItem(KEY); return v === null ? true : v === '1'; } catch (e) { return true; }
    }
    function write(on) { try { localStorage.setItem(KEY, on ? '1' : '0'); } catch (e) {} }
    function apply(on) {
      root.classList.toggle('zc-glass', !!on);
      var cb = document.getElementById('sGlass');
      if (cb) {
        cb.checked = !!on;
        if (!cb.zcBound) {
          cb.zcBound = 1;
          cb.addEventListener('change', function () { apply(cb.checked); write(cb.checked); });
        }
      }
    }
    apply(read());

    // 指针视差：背板随指针做极小位移，让前景玻璃有层次感。
    // 只改 CSS 变量并用 rAF 合帧，滚动与输入不受影响。
    if (!reduced) {
      var cx = 0, cy = 0, tx = 0, ty = 0, raf = 0;
      function tick() {
        raf = 0;
        cx += (tx - cx) * 0.12;
        cy += (ty - cy) * 0.12;
        root.style.setProperty('--zx', cx.toFixed(1) + 'px');
        root.style.setProperty('--zy', cy.toFixed(1) + 'px');
        if (Math.abs(tx - cx) > 0.4 || Math.abs(ty - cy) > 0.4) raf = requestAnimationFrame(tick);
      }
      window.addEventListener('pointermove', function (e) {
        if (e.pointerType === 'touch') return;
        if (!root.classList.contains('zc-glass')) return;
        tx = (e.clientX / window.innerWidth - 0.5) * 26;
        ty = (e.clientY / window.innerHeight - 0.5) * 20;
        if (!raf) raf = requestAnimationFrame(tick);
      }, { passive: true });
    }
  } catch (e) { /* 皮肤失效也不应影响主功能 */ }
})();
/* ZC-GLASS SCRIPT END */