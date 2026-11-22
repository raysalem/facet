/* ui-probe.js - framework-free UI sanity probe. See UI-STANDARD.md (I1-I7, D1-D12 census).
 * Use: await page.addScriptTag({path}); const r = await page.evaluate(o => window.uiProbe(o), opts);
 * opts: {maxFloat: 640, spacingScale: [0,4,8,12,16,24,32,48]}
 * Returns plain JSON. Skips what it cannot read. */
(function () {
  function probe(opts) {
    opts = opts || {};
    var maxFloat = opts.maxFloat || 640;
    var vw = window.innerWidth, vh = window.innerHeight;
    var all = Array.prototype.slice.call(document.querySelectorAll('body *'));
    function sel(el) {
      if (el.id) return el.tagName.toLowerCase() + '#' + el.id;
      var c = (typeof el.className === 'string' ? el.className : '').trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.');
      return el.tagName.toLowerCase() + (c ? '.' + c : '');
    }
    function cs(el) { try { return getComputedStyle(el); } catch (e) { return null; } }
    function shown(el) {
      var s = cs(el), r = el.getBoundingClientRect();
      return !!s && s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
    }
    var out = { viewport: { w: vw, h: vh }, scrollers: [], horizontalOverflow: { overflow: false, px: 0 },
      offscreenAlerts: [], wideFloating: [], rawI18nKeys: [], hiddenButVisible: [],
      rawTechTerms: [], truncated: [], toolbars: [], style: null };

    // I2: vertical scrollers
    all.forEach(function (el) {
      var s = cs(el);
      if (!s || !/(auto|scroll)/.test(s.overflowY)) return;
      if (el.scrollHeight > el.clientHeight + 1 && el.clientHeight > 0 && shown(el))
        out.scrollers.push({ selector: sel(el), scrollHeight: el.scrollHeight, clientHeight: el.clientHeight });
    });
    var de = document.documentElement;
    if (de.scrollHeight > de.clientHeight + 1 && cs(document.body).overflowY !== 'hidden' && cs(de).overflowY !== 'hidden')
      out.scrollers.push({ selector: 'html', scrollHeight: de.scrollHeight, clientHeight: de.clientHeight });

    // I3: horizontal page overflow
    var ox = Math.max(de.scrollWidth, document.body.scrollWidth) - vw;
    out.horizontalOverflow = { overflow: ox > 1, px: Math.max(0, ox) };

    // I7: alerts partly outside the viewport
    all.forEach(function (el) {
      var role = el.getAttribute('role');
      var hint = el.id + ' ' + (typeof el.className === 'string' ? el.className : '');
      if (!(role === 'alert' || role === 'status' || /(^|[\s_-])(err|error|alert|toast|snackbar)([\s_-]|$)/i.test(hint))) return;
      if (!shown(el)) return;
      var r = el.getBoundingClientRect();
      if (r.bottom > vh + 1 || r.top < -1 || r.right > vw + 1 || r.left < -1)
        out.offscreenAlerts.push({ selector: sel(el), top: Math.round(r.top), bottom: Math.round(r.bottom), viewportH: vh, text: (el.textContent || '').trim().slice(0, 80) });
    });

    // I4: floating elements wider than cap or viewport
    all.forEach(function (el) {
      var s = cs(el), role = el.getAttribute('role');
      var isRole = role === 'tooltip' || role === 'dialog' || role === 'menu';
      var floating = isRole || (s && (s.position === 'fixed' || s.position === 'absolute'));
      if (!floating || !shown(el)) return;
      var w = el.getBoundingClientRect().width;
      // position-only boxes: skip full-width overlays and empty boxes
      if (!isRole && (w >= vw - 1 || !(el.textContent || '').trim())) return;
      if (w > maxFloat || w > vw + 1)
        out.wideFloating.push({ selector: sel(el), width: Math.round(w), max: maxFloat, viewportW: vw });
    });

    // I5: raw i18n keys in visible leaf text
    var re = /^[a-z]+(\.[a-z_]+){2,}$/;
    all.forEach(function (el) {
      if (el.children.length || /^(SCRIPT|STYLE|NOSCRIPT|CODE|PRE)$/.test(el.tagName)) return;
      var t = (el.textContent || '').trim();
      if (re.test(t) && shown(el)) out.rawI18nKeys.push({ selector: sel(el), text: t });
    });

    // I1: hidden attribute but still displayed
    Array.prototype.forEach.call(document.querySelectorAll('[hidden]'), function (el) {
      var s = cs(el);
      if (s && s.display !== 'none') out.hiddenButVisible.push({ selector: sel(el), display: s.display });
    });

    // D11: raw tech terms (snake_case, SQL type names) in visible leaf text
    var techRe = /(^|[^A-Za-z0-9_])([a-z][a-z0-9]*(_[a-z0-9]+)+)(?![A-Za-z0-9_])|\b(DOUBLE|VARCHAR|INTEGER|TEXT|BIGINT)\b/;
    all.forEach(function (el) {
      if (el.children.length || /^(SCRIPT|STYLE|NOSCRIPT|CODE|PRE)$/.test(el.tagName)) return;
      var t = (el.textContent || '').trim();
      if (t && t.length < 200 && techRe.test(t) && shown(el)) out.rawTechTerms.push({ selector: sel(el), text: t.slice(0, 80) });
    });

    // D12: truncated without a way to read it
    all.forEach(function (el) {
      var s = cs(el);
      if (!s || !shown(el) || el.clientWidth <= 0) return;
      if (el.scrollWidth > el.clientWidth + 1 && (s.overflowX === 'hidden' || s.textOverflow === 'ellipsis') && !el.getAttribute('title') && !el.getAttribute('aria-label'))
        out.truncated.push({ selector: sel(el), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, text: (el.textContent || '').trim().slice(0, 60) });
    });

    // D9: top-level controls per toolbar / filter row
    all.forEach(function (el) {
      var hint = (el.getAttribute('role') || '') + ' ' + (typeof el.className === 'string' ? el.className : '') + ' ' + el.id;
      if (!/toolbar|filter-?bar|filters|filter-row/i.test(hint) || !shown(el)) return;
      var n = Array.prototype.filter.call(el.querySelectorAll('button,select,input:not([type=hidden]),[role=button],a[role=tab]'), shown).length;
      out.toolbars.push({ selector: sel(el), controls: n });
    });

    // D1 D2 D3 D6: style census
    var scale = opts.spacingScale || [0, 4, 8, 12, 16, 24, 32, 48];
    var sizes = {}, weights = {}, off = {}, bgCount = {};
    function rgb(c) { var m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/.exec(c); return m ? [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]] : null; }
    function sat(c) { var mx = Math.max(c[0], c[1], c[2]), mn = Math.min(c[0], c[1], c[2]); return mx === 0 ? 0 : (mx - mn) / mx; }
    var buttons = [];
    all.forEach(function (el) {
      var s = cs(el);
      if (!s || !shown(el)) return;
      var hasText = Array.prototype.some.call(el.childNodes, function (n) { return n.nodeType === 3 && n.textContent.trim(); });
      if (hasText) { sizes[s.fontSize] = (sizes[s.fontSize] || 0) + 1; weights[s.fontWeight] = (weights[s.fontWeight] || 0) + 1; }
      ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft', 'rowGap', 'columnGap'].forEach(function (k) {
        var v = parseFloat(s[k]);
        if (isNaN(v) || scale.indexOf(Math.round(v * 100) / 100) >= 0) return;
        if (/margin/.test(k) && el.getBoundingClientRect().width >= vw - 1) return; // auto-centered blocks
        var key = v + 'px';
        if (!off[key]) off[key] = { count: 0, sample: sel(el) + ' ' + k };
        off[key].count++;
      });
      if (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button' || (el.tagName === 'INPUT' && /^(submit|button)$/.test(el.type))) {
        var b = rgb(s.backgroundColor);
        if (b && b[3] > 0.5) buttons.push({ el: el, bg: s.backgroundColor, c: b });
      }
    });
    // filled primary buttons: bg equals --accent, else the most saturated button bg
    var accent = null;
    try {
      var probeEl = document.createElement('i');
      probeEl.style.color = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
      document.body.appendChild(probeEl);
      if (probeEl.style.color) accent = getComputedStyle(probeEl).color;
      document.body.removeChild(probeEl);
    } catch (e) {}
    var primaryBg = accent;
    if (!primaryBg) {
      var best = null;
      buttons.forEach(function (b) { if (sat(b.c) > 0.35 && (!best || sat(b.c) > sat(best.c))) best = b; });
      primaryBg = best ? best.bg : null;
    }
    var filled = primaryBg ? buttons.filter(function (b) { return b.bg === primaryBg; }) : [];
    out.style = {
      fontSizes: Object.keys(sizes).sort(function (a, b) { return parseFloat(a) - parseFloat(b); }),
      fontWeights: Object.keys(weights).sort(),
      offScaleSpacing: off,
      filledPrimaryButtons: { count: filled.length, color: primaryBg, selectors: filled.slice(0, 5).map(function (b) { return sel(b.el); }) }
    };
    return out;
  }
  window.uiProbe = probe;
  if (typeof module !== 'undefined') module.exports = probe;
})();
