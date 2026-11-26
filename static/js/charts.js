/* Lightweight dependency-free SVG charts, themed for Aether Weather. */
(function (global) {
  'use strict';

  const esc = (v) => String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  function extent(values) {
    const nums = values.filter(v => typeof v === 'number' && isFinite(v));
    if (!nums.length) return [0, 1];
    let min = Math.min(...nums), max = Math.max(...nums);
    if (min === max) { min -= 1; max += 1; }
    const pad = (max - min) * 0.15;
    return [min - pad, max + pad];
  }

  function smoothPath(points) {
    if (!points.length) return '';
    if (points.length === 1) return `M ${points[0][0]} ${points[0][1]}`;
    let d = `M ${points[0][0].toFixed(1)} ${points[0][1].toFixed(1)}`;
    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[i], p1 = points[i + 1];
      const mx = (p0[0] + p1[0]) / 2;
      d += ` C ${mx.toFixed(1)} ${p0[1].toFixed(1)}, ${mx.toFixed(1)} ${p1[1].toFixed(1)}, ${p1[0].toFixed(1)} ${p1[1].toFixed(1)}`;
    }
    return d;
  }

  function labelIndices(n, max) {
    if (n <= max) return [...Array(n).keys()];
    const step = Math.ceil(n / max);
    const out = [];
    for (let i = 0; i < n; i += step) out.push(i);
    if (out[out.length - 1] !== n - 1) out.push(n - 1);
    return out;
  }

  function line(el, opts) {
    if (!el) return;
    const labels = opts.labels || [];
    const values = opts.values || [];
    if (!values.length) { el.innerHTML = '<div class="empty"><p>No chart data available.</p></div>'; return; }
    const W = 800, H = opts.height || 240;
    const left = 8, right = 8, top = 24, bottom = 36;
    const [min, max] = extent(values);
    const span = max - min || 1;
    const plotW = W - left - right, plotH = H - top - bottom;
    const pts = values.map((v, i) => [
      left + (values.length === 1 ? plotW / 2 : (i / (values.length - 1)) * plotW),
      top + (1 - (v - min) / span) * plotH
    ]);
    const path = smoothPath(pts);
    const area = path + ` L ${pts[pts.length - 1][0].toFixed(1)} ${top + plotH} L ${pts[0][0].toFixed(1)} ${top + plotH} Z`;
    const uid = 'g' + Math.random().toString(36).slice(2, 9);
    const color = opts.color || '#e9c07d';
    const grid = [0, 1, 2, 3].map(i => {
      const y = top + (plotH / 3) * i;
      const v = max - (span / 3) * i;
      return `<line class="chart-grid" x1="${left}" y1="${y}" x2="${W - right}" y2="${y}"/>
              <text class="chart-tip" x="${left + 2}" y="${y - 5}">${esc(opts.format ? opts.format(v) : Math.round(v))}${esc(opts.suffix || '')}</text>`;
    }).join('');
    const shown = labelIndices(labels.length, opts.maxLabels || 8);
    const xlabels = shown.map(i => `<text class="chart-tip" x="${pts[i][0]}" y="${H - 10}" text-anchor="middle">${esc(labels[i])}</text>`).join('');
    const dots = pts.map((p, i) => `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="${i === 0 ? 4 : 3}" fill="${color}" stroke="rgba(0,0,0,.25)" stroke-width="1"><title>${esc(labels[i])}: ${esc(opts.format ? opts.format(values[i]) : values[i])}${esc(opts.suffix || '')}</title></circle>`).join('');
    el.innerHTML = `<div class="chart-wrap"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.title || 'Trend chart')}">
      <defs><linearGradient id="${uid}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${color}" stop-opacity=".28"/><stop offset="100%" stop-color="${color}" stop-opacity="0"/>
      </linearGradient></defs>
      ${grid}<path d="${area}" fill="url(#${uid})"/><path class="chart-line" d="${path}" style="stroke:${color};stroke-dashoffset:1600"/>
      ${dots}${xlabels}</svg></div>`;
  }

  function bars(el, opts) {
    if (!el) return;
    const labels = opts.labels || [], values = opts.values || [];
    if (!values.length) { el.innerHTML = '<div class="empty"><p>No chart data available.</p></div>'; return; }
    const W = 800, H = opts.height || 210;
    const left = 10, right = 10, top = 26, bottom = 36;
    const maxV = Math.max(...values.filter(v => typeof v === 'number'), 1) * 1.15;
    const plotW = W - left - right, plotH = H - top - bottom;
    const slot = plotW / values.length;
    const bw = Math.min(slot * 0.6, 34);
    const uid = 'b' + Math.random().toString(36).slice(2, 9);
    const color = opts.color || '#78a9ff';
    const grid = [0, 0.5, 1].map(i => {
      const y = top + plotH * (1 - i);
      return `<line class="chart-grid" x1="${left}" y1="${y}" x2="${W - right}" y2="${y}"/>`;
    }).join('');
    const rects = values.map((v, i) => {
      const h = Math.max(((v || 0) / maxV) * plotH, 3);
      const x = left + i * slot + (slot - bw) / 2;
      const y = top + plotH - h;
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="5" fill="url(#${uid})">
        <title>${esc(labels[i])}: ${esc(v)}${esc(opts.suffix || '')}</title></rect>`;
    }).join('');
    const shown = labelIndices(labels.length, opts.maxLabels || 10);
    const xlabels = shown.map(i => `<text class="chart-tip" x="${(left + i * slot + slot / 2).toFixed(1)}" y="${H - 10}" text-anchor="middle">${esc(labels[i])}</text>`).join('');
    el.innerHTML = `<div class="chart-wrap"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.title || 'Bar chart')}">
      <defs><linearGradient id="${uid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${color}" stop-opacity=".95"/><stop offset="100%" stop-color="${color}" stop-opacity=".18"/></linearGradient></defs>
      ${grid}${rects}${xlabels}</svg></div>`;
  }

  function ranges(el, opts) {
    if (!el) return;
    const items = opts.items || [];
    if (!items.length) { el.innerHTML = '<div class="empty"><p>No daily data available.</p></div>'; return; }
    const W = 800, rowH = 44, H = items.length * rowH + 30;
    const all = items.flatMap(i => [i.min, i.max]).filter(v => typeof v === 'number');
    let lo = Math.min(...all), hi = Math.max(...all);
    if (lo === hi) { lo -= 1; hi += 1; }
    const pad = (hi - lo) * .12; lo -= pad; hi += pad;
    const x = v => 70 + ((v - lo) / (hi - lo)) * (W - 130);
    const rows = items.map((it, i) => {
      const y = 24 + i * rowH;
      const x1 = x(it.min), x2 = x(it.max);
      return `<text class="chart-tip" x="4" y="${y + 4}" style="font-size:12px;fill:var(--text)">${esc(it.label)}</text>
        <line x1="${x1.toFixed(1)}" y1="${y}" x2="${x2.toFixed(1)}" y2="${y}" stroke="url(#rg)" stroke-width="7" stroke-linecap="round"/>
        <circle cx="${x1.toFixed(1)}" cy="${y}" r="5" fill="#78a9ff"><title>${esc(it.label)} low: ${it.min}°</title></circle>
        <circle cx="${x2.toFixed(1)}" cy="${y}" r="5" fill="#f0a35b"><title>${esc(it.label)} high: ${it.max}°</title></circle>
        <text class="chart-tip" x="${(x1 - 9).toFixed(1)}" y="${y + 4}" text-anchor="end">${Math.round(it.min)}°</text>
        <text class="chart-tip" x="${(x2 + 9).toFixed(1)}" y="${y + 4}">${Math.round(it.max)}°</text>`;
    }).join('');
    el.innerHTML = `<div class="chart-wrap"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Daily temperature ranges">
      <defs><linearGradient id="rg" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#78a9ff"/><stop offset="50%" stop-color="#e9c07d"/><stop offset="100%" stop-color="#f0a35b"/></linearGradient></defs>
      ${rows}</svg></div>`;
  }

  function arcPath(cx, cy, r, startDeg, endDeg) {
    const rad = d => (d - 90) * Math.PI / 180;
    const p1 = [cx + r * Math.cos(rad(startDeg)), cy + r * Math.sin(rad(startDeg))];
    const p2 = [cx + r * Math.cos(rad(endDeg)), cy + r * Math.sin(rad(endDeg))];
    const large = Math.abs(endDeg - startDeg) > 180 ? 1 : 0;
    return `M ${p1[0].toFixed(1)} ${p1[1].toFixed(1)} A ${r} ${r} 0 ${large} 1 ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }

  function gauge(el, opts) {
    if (!el) return;
    const segments = opts.segments || [];
    const active = Math.max(0, Math.min(segments.length - 1, opts.activeIndex ?? -1));
    const W = 260, H = 160, cx = 130, cy = 132, r = 100;
    const arcs = segments.map((s, i) => `<path d="${arcPath(cx, cy, r, -90 + i * (180 / segments.length) + 2, -90 + (i + 1) * (180 / segments.length) - 2)}"
      fill="none" stroke="${s.color}" stroke-width="18" stroke-linecap="round" opacity="${i === active ? 1 : .22}"/>`).join('');
    const ratio = Math.max(0, Math.min(1, (opts.value ?? 0) / (opts.max ?? segments.length)));
    const rad = Math.PI - ratio * Math.PI;
    const nx = cx + (r - 22) * Math.cos(rad), ny = cy - (r - 22) * Math.sin(rad);
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.label || 'Gauge')}">${arcs}
      <line x1="${cx}" y1="${cy}" x2="${nx.toFixed(1)}" y2="${ny.toFixed(1)}" stroke="var(--text)" stroke-width="2.5" stroke-linecap="round"/>
      <circle cx="${cx}" cy="${cy}" r="6" fill="var(--text)"/></svg>`;
  }

  function moon(el, opts) {
    if (!el) return;
    const illum = Math.max(0, Math.min(1, (opts.illumination ?? 0) / 100));
    const waxing = opts.waxing !== false;
    const R = 72, cx = 100, cy = 100;
    let lit;
    if (illum < .02) {
      lit = '';
    } else if (illum > .98) {
      lit = `<circle cx="${cx}" cy="${cy}" r="${R}" fill="#eef3ff"/>`;
    } else if (illum <= .5) {
      const rx = R * (1 - 2 * illum);
      lit = `<path d="M ${cx} ${cy - R} A ${R} ${R} 0 0 1 ${cx} ${cy + R} A ${rx.toFixed(2)} ${R} 0 0 1 ${cx} ${cy - R} Z" fill="#eef3ff"/>`;
    } else {
      const rx = R * (2 * illum - 1);
      lit = `<circle cx="${cx}" cy="${cy}" r="${R}" fill="#eef3ff"/>
        <path d="M ${cx} ${cy - R} A ${R} ${R} 0 0 0 ${cx} ${cy + R} A ${rx.toFixed(2)} ${R} 0 0 0 ${cx} ${cy - R} Z" fill="#1b2740" opacity=".92"/>`;
    }
    const flip = waxing ? '' : ' transform="translate(200,0) scale(-1,1)"';
    el.innerHTML = `<svg viewBox="0 0 200 200" class="moon-visual" role="img" aria-label="${esc(opts.name || 'Moon phase')}">
      <defs><radialGradient id="moonGlow"><stop offset="60%" stop-color="#e8edff" stop-opacity=".06"/><stop offset="100%" stop-color="#e8edff" stop-opacity="0"/></radialGradient></defs>
      <circle cx="100" cy="100" r="96" fill="url(#moonGlow)"/>
      <circle cx="${cx}" cy="${cy}" r="${R}" fill="#8493b0" opacity=".22"/>
      <g${flip}>${lit}</g>
      <circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="rgba(255,255,255,.12)" stroke-width="1"/></svg>`;
  }

  function sunArc(el, opts) {
    if (!el) return;
    const progress = Math.max(0, Math.min(1, opts.progress ?? .5));
    const angle = Math.PI - progress * Math.PI;
    const sx = 200 + 160 * Math.cos(angle), sy = 168 - 130 * Math.sin(angle);
    const samples = [];
    for (let i = 0; i <= 40; i++) {
      const a = Math.PI - (i / 40) * Math.PI;
      samples.push(`${i ? 'L' : 'M'} ${(200 + 160 * Math.cos(a)).toFixed(1)} ${(168 - 130 * Math.sin(a)).toFixed(1)}`);
    }
    el.innerHTML = `<svg viewBox="0 0 400 200" class="sun-arc" role="img" aria-label="Sun path">
      <line x1="30" y1="168" x2="370" y2="168" stroke="var(--border)" stroke-width="1" stroke-dasharray="4 6"/>
      <path d="${samples.join(' ')}" fill="none" stroke="var(--border-strong)" stroke-width="2" stroke-dasharray="5 7"/>
      <path d="${samples.slice(0, Math.max(1, Math.floor(progress * 40)) + 1).join(' ')}" fill="none" stroke="#e9c07d" stroke-width="2.5" stroke-linecap="round"/>
      <circle cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="12" fill="#f3d598" opacity=".22"/>
      <circle cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="6" fill="#f3d598"/>
      <text class="chart-tip" x="24" y="192">${esc(opts.sunrise || '')}</text>
      <text class="chart-tip" x="376" y="192" text-anchor="end">${esc(opts.sunset || '')}</text></svg>`;
  }

  global.Charts = { line, bars, ranges, gauge, moon, sunArc, arcPath };
})(window);
