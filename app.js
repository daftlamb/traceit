const _canvas = document.getElementById('canvas');
const _nodesCanvas = document.getElementById('canvas-nodes');
const _nodesCtx = _nodesCanvas.getContext('2d');

function resizeCanvases() {
  const w = window.innerWidth - 260, h = window.innerHeight;
  _canvas.width = w; _canvas.height = h;
  _nodesCanvas.width = w; _nodesCanvas.height = h;
}
resizeCanvases();
window.addEventListener('resize', () => { resizeCanvases(); paper.view.draw(); });
paper.setup(_canvas);
const rc = rough.canvas(_nodesCanvas);

let activeTool = 'select';
let paths = [];
let selected = null;   // { type:'path'|'node', pi, ni? }

let _hist = [], _histIdx = -1;
function pushHistory() {
  try {
    var snap = JSON.stringify(paths.map(function(p){ return Object.assign({},p,{nodes:p.nodes.map(function(n){return Object.assign({},n);})}); }));
    _hist = _hist.slice(0, _histIdx+1);
    _hist.push(snap);
    if(_hist.length > 50) _hist.shift(); else _histIdx++;
  } catch(e) {}
}
function undo() {
  if(_histIdx < 1) return;
  _histIdx--;
  paths = JSON.parse(_hist[_histIdx]);
  selected = {pi:0, ni:-1};
  renderNodes(); updatePanel();
}
let currentDraw = null;
let showGrid = false;
let artboard = { x: 0, y: 0, w: 800, h: 600 }; // world coords, updated after init
let showArtboard = false;
let _isExporting = false;
let _spacePan = false, _panLast = null;

// ── Animation engine ────────────────────────────────────────────────────────
let _playing = false;
let _animT = 0;       // cycles elapsed (1 unit = 1 full sin cycle)
let _animRaf = null;
let _animLastTime = null;

function _tickAnim(ts) {
  if (_animLastTime !== null) {
    const dt = (ts - _animLastTime) / 1000;
    const speed = parseFloat(document.getElementById('anim-speed').value) || 1;
    _animT += dt * speed;
  }
  _animLastTime = ts;
  paper.view.draw();
  if (_playing) _animRaf = requestAnimationFrame(_tickAnim);
}

// Return animated value for a node param; falls back to base when not playing/looped
function _aval(n, key, base, i, count) {
  if (!_playing || !n.loop || !n.loop[key]) return base;
  const phase = count > 1 ? (i / count) * Math.PI * 2 : 0;
  const t = _animT * Math.PI * 2 + phase;
  if (key === 'offset') return (base + _animT) % 1;          // continuous path travel
  if (key === 'rotation') return (base + _animT * 360) % 360; // continuous spin
  return base + base * 0.8 * Math.sin(t);                    // oscillate ±80% of base
}

function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(1664525, s) + 1013904223) >>> 0; return s / 0xffffffff; };
}
function getSeeds(key, n) {
  const r = lcg(key.split('').reduce((a, c) => a + c.charCodeAt(0), 0));
  return Array.from({ length: n }, r);
}

function parseColor(fill) {
  const tmp = document.createElement('canvas');
  tmp.width = 1; tmp.height = 1;
  const tc = tmp.getContext('2d');
  tc.fillStyle = fill || '#1a1a1a';
  tc.fillRect(0, 0, 1, 1);
  const d = tc.getImageData(0, 0, 1, 1).data;
  return [d[0], d[1], d[2]];
}

// Riso: metaball liquid ink
function applyRiso(ctx, x, y, r, fill, nextPt, nextR, srcCanvas, opts) {
  opts = opts || {};
  const bristle = opts.bristle !== undefined ? opts.bristle : 1.0;
  const erosion = opts.erosion !== undefined ? opts.erosion : 1.0;
  const spread = opts.spread !== undefined ? opts.spread : 0.38;
  const bridge = opts.bridge !== undefined ? opts.bridge : 1.4;
  const z = opts.zoom || 1; // screen pixels per world unit
  const [fr, fg, fb] = parseColor(fill);
  const pad = r * 3;
  const bx_w = x - r - pad, by_w = y - r - pad; // world-space top-left
  // offscreen canvas sized in screen pixels for crisp rendering
  const bw = Math.ceil((r * 2 + pad * 2) * z), bh = Math.ceil((r * 2 + pad * 2) * z);
  const ox = (x - bx_w) * z, oy = (y - by_w) * z; // circle center in offscreen px
  const rz = r * z;
  const off = document.createElement('canvas');
  off.width = bw; off.height = bh;
  const oc = off.getContext('2d');
  if (srcCanvas) {
    oc.drawImage(srcCanvas, ox - rz, oy - rz, rz * 2, rz * 2);
  } else {
    oc.fillStyle = '#000';
    oc.beginPath(); oc.arc(ox, oy, rz, 0, Math.PI * 2); oc.fill();
    const edgeBlobs = Math.floor(rz * 2.2 * bristle);
    for (let i = 0; i < edgeBlobs; i++) {
      const a = Math.random() * Math.PI * 2;
      const d2 = rz * (0.72 + Math.random() * 0.5);
      const br = rz * (0.07 + Math.random() * 0.16);
      oc.beginPath(); oc.arc(ox + Math.cos(a) * d2, oy + Math.sin(a) * d2, br, 0, Math.PI * 2); oc.fill();
    }
    if (nextPt) {
      const dx = (nextPt.x - x) * z, dy = (nextPt.y - y) * z;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const gap = dist - rz - (nextR || r) * z;
      if (gap < rz * bridge) {
        const t = Math.max(0, 1 - gap / (rz * 1.4));
        const blobR = Math.max(2, rz * 0.4 * t);
        const steps = Math.ceil(dist / (blobR * 0.7));
        for (let i = 0; i <= steps; i++) {
          const f = i / steps;
          const br = blobR * (0.5 + 0.5 * Math.sin(f * Math.PI));
          oc.beginPath(); oc.arc(ox + dx * f, oy + dy * f, br, 0, Math.PI * 2); oc.fill();
        }
      }
    }
  }
  const off2 = document.createElement('canvas');
  off2.width = bw; off2.height = bh;
  const oc2 = off2.getContext('2d');
  oc2.filter = `blur(${rz * spread}px)`;
  oc2.drawImage(off, 0, 0);
  oc2.filter = 'none';
  const imgd = oc2.getImageData(0, 0, bw, bh);
  const d = imgd.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] > 80) { d[i] = fr; d[i+1] = fg; d[i+2] = fb; d[i+3] = 255; }
    else { d[i+3] = 0; }
  }
  oc2.putImageData(imgd, 0, 0);
  oc2.globalCompositeOperation = 'destination-out';
  const holes = Math.floor(rz * 0.5 * erosion);
  for (let i = 0; i < holes; i++) {
    const a = Math.random() * Math.PI * 2, rd = Math.random() * rz * 0.65;
    oc2.beginPath(); oc2.arc(ox + Math.cos(a) * rd, oy + Math.sin(a) * rd, 0.8 + Math.random() * 2.2, 0, Math.PI * 2); oc2.fill();
  }
  // draw at screen coordinates (bypass view transform)
  const m = ctx.getTransform();
  const sx = m.a * bx_w + m.c * by_w + m.e;
  const sy = m.b * bx_w + m.d * by_w + m.f;
  ctx.save(); ctx.resetTransform();
  ctx.drawImage(off2, sx, sy);
  ctx.restore();
}

function drawShape(ctx, style, type, x, y, size, fill, rot, opacity, font, text, jx, jy, jr, js, sc, sw, noFill, noStroke, sx, sy, imgEl, riso, nextPt, nextR, charArr, charColors, seedIdx, risoOpts, dither, lineLen, curvature) {
  const bristle = risoOpts && risoOpts.bristle !== undefined ? risoOpts.bristle : 1.0;
  const erosion = risoOpts && risoOpts.erosion !== undefined ? risoOpts.erosion : 1.0;
  const spread = risoOpts && risoOpts.spread !== undefined ? risoOpts.spread : 0.38;
  const bridge = risoOpts && risoOpts.bridge !== undefined ? risoOpts.bridge : 1.4;
  const s = Math.max(1, size + js);
  const scx = (sx || 100) / 100, scy = (sy || 100) / 100;
  let displayText = text || 'node';
  let displayFill = fill;
  if (charArr && charArr.length > 0) displayText = charArr[seedIdx % charArr.length];
  if (charColors && charColors.length > 0) displayFill = charColors[seedIdx % charColors.length];

  if (style === 'rough') {
    const ro = { stroke: sc || displayFill, strokeWidth: sw || 1.2, roughness: 1.4, fill: displayFill + '55', fillStyle: 'hachure' };
    if (type === 'circle') rc.circle(x+jx, y+jy, s, ro);
    else if (type === 'rect') rc.rectangle(x+jx-s/2, y+jy-s/2, s, s, ro);
    else if (type === 'triangle') rc.polygon([[x+jx,y+jy-s/2],[x+jx+s/2,y+jy+s/2],[x+jx-s/2,y+jy+s/2]], ro);
    else if (type === 'line') rc.line(x+jx-s/2, y+jy, x+jx+s/2, y+jy, { stroke: sc||displayFill, strokeWidth: sw||1.5, roughness: 1.2 });
    if (riso) applyRiso(ctx, x+jx, y+jy, s/2, displayFill, nextPt, nextR, null, {bristle,erosion,spread,bridge});
    return;
  }
  if (riso) {
    if (type === 'text') {
      // render text to offscreen canvas, then apply riso using text as mask
      const metrics_c = document.createElement('canvas');
      metrics_c.width = 4; metrics_c.height = 4;
      const mc = metrics_c.getContext('2d');
      mc.font = `${s}px ${font || 'sans-serif'}`;
      const tw = mc.measureText(displayText).width;
      const th = s * 1.4;
      const toff = document.createElement('canvas');
      toff.width = Math.ceil(tw) + 8; toff.height = Math.ceil(th) + 8;
      const tc = toff.getContext('2d');
      tc.font = `${s}px ${font || 'sans-serif'}`;
      tc.textAlign = 'center'; tc.textBaseline = 'middle';
      tc.fillStyle = '#000';
      tc.fillText(displayText, toff.width / 2, toff.height / 2);
      // draw riso using text mask — solid color, no blur
      const [fr, fg, fb] = parseColor(displayFill);
      const imgd = tc.getImageData(0, 0, toff.width, toff.height);
      const d = imgd.data;
      for (let ii = 0; ii < d.length; ii += 4) {
        if (d[ii+3] > 60) { d[ii]=fr; d[ii+1]=fg; d[ii+2]=fb; d[ii+3]=255; }
        else { d[ii+3]=0; }
      }
      tc.putImageData(imgd, 0, 0);
      // erosion holes
      tc.globalCompositeOperation = 'destination-out';
      const holes = Math.floor(tw * 0.08);
      for (let ii = 0; ii < holes; ii++) {
        tc.beginPath();
        tc.arc(Math.random()*toff.width, Math.random()*toff.height, 0.5+Math.random()*2, 0, Math.PI*2);
        tc.fill();
      }
      ctx.drawImage(toff, x+jx - toff.width/2, y+jy - toff.height/2);
    } else if (type === 'svg' && imgEl) {
      // render SVG to offscreen, recolor with riso effect
      const aspect = imgEl.naturalWidth / imgEl.naturalHeight || 1;
      const iw = Math.ceil(s * aspect), ih = Math.ceil(s);
      const toff = document.createElement('canvas');
      toff.width = iw + 8; toff.height = ih + 8;
      const tc = toff.getContext('2d');
      tc.drawImage(imgEl, 4, 4, iw, ih);
      const [fr, fg, fb] = parseColor(displayFill);
      const imgd = tc.getImageData(0, 0, toff.width, toff.height);
      const d = imgd.data;
      for (let ii = 0; ii < d.length; ii += 4) {
        if (d[ii+3] > 40) { d[ii]=fr; d[ii+1]=fg; d[ii+2]=fb; }
        else { d[ii+3]=0; }
      }
      tc.putImageData(imgd, 0, 0);
      tc.globalCompositeOperation = 'destination-out';
      const holes = Math.floor(iw * ih * 0.002);
      for (let ii = 0; ii < holes; ii++) {
        tc.beginPath();
        tc.arc(Math.random()*toff.width, Math.random()*toff.height, 0.5+Math.random()*2, 0, Math.PI*2);
        tc.fill();
      }
      ctx.drawImage(toff, x+jx - toff.width/2, y+jy - toff.height/2);
    } else {
      const _isStrokeOnly = type==='line'||type==='arc'||type==='curve'||type==='cross';
      if (!_isStrokeOnly && !noFill) {
        applyRiso(ctx, x+jx, y+jy, s/2*Math.max(scx,scy), displayFill, nextPt, nextR, null, {bristle,erosion,spread,bridge});
      } else {
        // riso ink effect for stroke-only and noFill shapes
        const _rsw = sw || 1.5;
        const _rll = lineLen !== undefined ? lineLen : 100;
        const _rcv = curvature !== undefined ? curvature : 50;
        const _rdim = Math.ceil(Math.max(s * Math.max(scx,scy), _rll * scx) * 2 + _rsw * 6 + 20);
        const _roff = document.createElement('canvas');
        _roff.width = _rdim; _roff.height = _rdim;
        const _roc = _roff.getContext('2d');
        _roc.save();
        _roc.translate(_rdim/2, _rdim/2); _roc.rotate(rot+jr); _roc.scale(scx, scy);
        _roc.strokeStyle = '#000'; _roc.fillStyle = '#000';
        if (type === 'line') {
          _roc.lineWidth = _rsw * 1.8; _roc.beginPath(); _roc.moveTo(-_rll/2,0); _roc.lineTo(_rll/2,0); _roc.stroke();
        } else if (type === 'arc') {
          const _bend = (_rcv/100)*(_rll/2);
          _roc.lineWidth = _rsw * 1.8; _roc.beginPath(); _roc.moveTo(-_rll/2,0); _roc.quadraticCurveTo(0,-_bend,_rll/2,0); _roc.stroke();
        } else if (type === 'curve') {
          const _b2 = (_rcv/100)*(_rll/2);
          _roc.lineWidth = _rsw * 1.8; _roc.beginPath(); _roc.moveTo(-_rll/2,0); _roc.bezierCurveTo(-_rll/4,-_b2,_rll/4,_b2,_rll/2,0); _roc.stroke();
        } else if (type === 'cross') {
          _roc.lineWidth = _rsw * 1.8; _roc.beginPath(); _roc.moveTo(-s/2,0); _roc.lineTo(s/2,0); _roc.moveTo(0,-s/2); _roc.lineTo(0,s/2); _roc.stroke();
        } else {
          _roc.lineWidth = _rsw;
          if (type === 'circle') { _roc.beginPath(); _roc.arc(0,0,s/2,0,Math.PI*2); _roc.stroke(); }
          else if (type === 'rect') { _roc.strokeRect(-s/2,-s/2,s,s); }
          else if (type === 'triangle') { _roc.beginPath(); _roc.moveTo(0,-s/2); _roc.lineTo(s/2,s/2); _roc.lineTo(-s/2,s/2); _roc.closePath(); _roc.stroke(); }
        }
        _roc.restore();
        const [_rfr,_rfg,_rfb] = parseColor(displayFill);
        const _roff2 = document.createElement('canvas');
        _roff2.width = _rdim; _roff2.height = _rdim;
        const _roc2 = _roff2.getContext('2d');
        _roc2.filter = `blur(${Math.max(0.5, _rsw * 0.7)}px)`;
        _roc2.drawImage(_roff, 0, 0);
        _roc2.filter = 'none';
        const _rimgd = _roc2.getImageData(0, 0, _rdim, _rdim);
        const _rd = _rimgd.data;
        for (let _ri = 0; _ri < _rd.length; _ri += 4) {
          if (_rd[_ri+3] > 60) { _rd[_ri]=_rfr; _rd[_ri+1]=_rfg; _rd[_ri+2]=_rfb; _rd[_ri+3]=Math.min(255,_rd[_ri+3]+80); }
          else { _rd[_ri+3]=0; }
        }
        _roc2.putImageData(_rimgd, 0, 0);
        _roc2.globalCompositeOperation = 'destination-out';
        const _rholes = Math.floor(_rsw * _rdim / 60 * (erosion||1));
        for (let _ri = 0; _ri < _rholes; _ri++) {
          _roc2.beginPath(); _roc2.arc(Math.random()*_rdim, Math.random()*_rdim, 0.4+Math.random()*1.2, 0, Math.PI*2); _roc2.fill();
        }
        ctx.save();
        ctx.globalAlpha = Math.max(0, Math.min(1, opacity));
        ctx.drawImage(_roff2, x+jx - _rdim/2, y+jy - _rdim/2);
        ctx.restore();
      }
    }
    return;
  }
  if (dither && !riso) {
    applyDither(_nodesCtx, x+jx, y+jy, Math.max(1,size+js), displayFill, type, rot+jr, (sx||100)/100, (sy||100)/100,
      Object.assign({}, dither, {noFill: !!noFill, noStroke: !!noStroke, sw: sw||0, font: font, text: displayText}));
    return;
  }
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, opacity));
  ctx.translate(x+jx, y+jy); ctx.rotate(rot+jr); ctx.scale(scx, scy);
  ctx.fillStyle = displayFill; ctx.strokeStyle = sc || displayFill; ctx.lineWidth = sw || 0;
  const doFill = !noFill, doStroke = !noStroke && sw > 0;
  if (type === 'image' && imgEl) {
    const aspect = imgEl.naturalWidth / imgEl.naturalHeight;
    const iw = s * aspect, ih = s;
    if (dither) {
      applyImageDither(ctx, imgEl, iw, ih, {
        mode: (dither.imgMode || dither.mode || 'bayer'),
        dotSize: dither.dotSize || 1,
        colorize: !!dither.colorize,
        fill: displayFill || fill || '#1a1a1a'
      });
    } else {
      ctx.drawImage(imgEl, -iw/2, -ih/2, iw, ih);
    }
    if (doStroke) ctx.strokeRect(-iw/2, -ih/2, iw, ih);
  } else if (type === 'svg' && imgEl) {
    // imgEl is an Image with SVG src — draw it centered
    const aspect = imgEl.naturalWidth / imgEl.naturalHeight || 1;
    const iw = s * aspect, ih = s;
    ctx.drawImage(imgEl, -iw/2, -ih/2, iw, ih);
    if (doStroke) ctx.strokeRect(-iw/2, -ih/2, iw, ih);
  } else if (type === 'circle') {
    ctx.beginPath(); ctx.arc(0, 0, s/2, 0, Math.PI*2); if (doFill) ctx.fill(); if (doStroke) ctx.stroke();
  } else if (type === 'rect') {
    ctx.beginPath(); ctx.rect(-s/2, -s/2, s, s); if (doFill) ctx.fill(); if (doStroke) ctx.stroke();
  } else if (type === 'triangle') {
    ctx.beginPath(); ctx.moveTo(0,-s/2); ctx.lineTo(s/2,s/2); ctx.lineTo(-s/2,s/2); ctx.closePath();
    if (doFill) ctx.fill(); if (doStroke) ctx.stroke();
  } else if (type === 'line') {
    const ll = (lineLen !== undefined ? lineLen : 100) / 2;
    ctx.lineWidth = sw||1.5; ctx.beginPath(); ctx.moveTo(-ll,0); ctx.lineTo(ll,0); ctx.stroke();
  } else if (type === 'arc') {
    const cv = curvature !== undefined ? curvature : 50;
    const ll2 = (lineLen !== undefined ? lineLen : 100) / 2;
    const bend = (cv / 100) * ll2;
    ctx.lineWidth = sw||1.5; ctx.beginPath();
    ctx.moveTo(-ll2, 0); ctx.quadraticCurveTo(0, -bend, ll2, 0); ctx.stroke();
  } else if (type === 'curve') {
    const cv2 = curvature !== undefined ? curvature : 50;
    const ll3 = (lineLen !== undefined ? lineLen : 100) / 2;
    const bend2 = (cv2 / 100) * ll3;
    ctx.lineWidth = sw||1.5; ctx.beginPath();
    ctx.moveTo(-ll3, 0); ctx.bezierCurveTo(-ll3/2, -bend2, ll3/2, bend2, ll3, 0); ctx.stroke();
  } else if (type === 'cross') {
    ctx.lineWidth = sw||1.5; ctx.beginPath();
    ctx.moveTo(-s/2,0); ctx.lineTo(s/2,0); ctx.moveTo(0,-s/2); ctx.lineTo(0,s/2); ctx.stroke();
  } else if (type === 'text') {
    ctx.font = `${s}px ${font||'sans-serif'}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    if (doFill) ctx.fillText(displayText, 0, 0);
    if (doStroke) ctx.strokeText(displayText, 0, 0);
  }
  ctx.restore();
}

// resolve node props — sub-layer inherits ALL distribution params from parent
function resolveNode(pObj, ni) {
  const n = pObj.nodes[ni];
  if (n.parentNi !== undefined && n.parentNi !== null && pObj.nodes[n.parentNi]) {
    const parent = pObj.nodes[n.parentNi];
    // child inherits parent's loop flags for distribution params
    const inheritedLoopKeys = ['offset','jitter','rotJitter','sizeJitter','sx','sy','opStart','opEnd'];
    const mergedLoop = Object.assign({}, n.loop || {});
    inheritedLoopKeys.forEach(k => { if (parent.loop && parent.loop[k]) mergedLoop[k] = true; });
    return Object.assign({}, n, {
      count:      parent.count,
      offset:     parent.offset,
      jitter:     parent.jitter,
      rotJitter:  parent.rotJitter,
      sizeJitter: parent.sizeJitter,
      follow:     parent.follow,
      tilt3d:     parent.tilt3d,
      tiltMode:   parent.tiltMode,
      sx:         parent.sx,
      sy:         parent.sy,
      opStart:    parent.opStart,
      opEnd:      parent.opEnd,
      sizeEnd:    n.sizeEnd !== undefined ? n.sizeEnd : n.size,
      loop:       mergedLoop,
    });
  }
  return n;
}

function renderNodes(pObj, pi) {
  const pp = pObj.paperPath;
  if (!pp || pp.length < 2) return;
  const totalLen = pp.length;
  pObj.nodes.forEach((rawN, ni) => {
    const n = resolveNode(pObj, ni);
    const count = n.count || 1;
    // sub-layer uses parent's seeds so jitter positions align
    const seedKey = (n.parentNi !== undefined && n.parentNi !== null) ? `${pi}-${n.parentNi}` : `${pi}-${ni}`;
    const seeds = getSeeds(seedKey, count * 5);
    const tilt = (n.tilt3d || 0) * Math.PI / 180;
    const hasTilt = tilt > 0;
    const bcx = hasTilt ? pp.bounds.center.x : 0;
    const bcy = hasTilt ? pp.bounds.center.y : 0;
    const charArr = (n.charArray || '').split('').filter(c => c.trim());
    const charColors = (n.colorArray || '').split(',').map(c => c.trim()).filter(Boolean);

    const _animOffset = _aval(n, 'offset', n.offset || 0, 0, 1);
    for (let i = 0; i < count; i++) {
      const t = count === 1 ? totalLen * _animOffset : ((_animOffset + i / count) % 1) * totalLen;
      const pt = pp.getPointAt(Math.min(t, totalLen - 0.01));
      const tan = pp.getTangentAt(Math.min(t, totalLen - 0.01));
      if (!pt) continue;
      const frac = count > 1 ? i / (count - 1) : 0;
      const sz0 = Math.max(1, _aval(n, 'size', n.size || 16, i, count));
      const sz1 = Math.max(1, _aval(n, 'sizeEnd', n.sizeEnd !== undefined ? n.sizeEnd : n.size || 16, i, count));
      const op0 = _aval(n, 'opStart', n.opStart !== undefined ? n.opStart : 1, i, count);
      const op1 = _aval(n, 'opEnd',   n.opEnd   !== undefined ? n.opEnd   : 1, i, count);
      let size = sz0 + (sz1 - sz0) * frac;
      const opacity = Math.max(0, Math.min(1, op0 + (op1 - op0) * frac));
      const _aj = _aval(n, 'jitter',     n.jitter     || 0, i, count);
      const _ar = _aval(n, 'rotJitter',  n.rotJitter  || 0, i, count);
      const _as = _aval(n, 'sizeJitter', n.sizeJitter || 0, i, count);
      const jx = _aj ? (seeds[i*5]   - 0.5) * _aj * 2 : 0;
      const jy = _aj ? (seeds[i*5+1] - 0.5) * _aj * 2 : 0;
      const jr = _ar ? (seeds[i*5+2] - 0.5) * _ar * Math.PI / 90 : 0;
      const js = _as ? (seeds[i*5+3] - 0.5) * _as * 2 : 0;
      const _asx = _aval(n, 'sx', n.sx || 100, i, count);
      const _asy = _aval(n, 'sy', n.sy || 100, i, count);
      const rot = (n.follow ? Math.atan2(tan.y, tan.x) : 0) + (_aval(n, 'rotation', n.rotation || 0, i, count)) * Math.PI / 180;
      let px = pt.x, py = pt.y;
      if (hasTilt) {
        const dx = pt.x - bcx, dy = pt.y - bcy;
        if (n.tiltMode === 'isometric') {
          const iso = Math.PI / 6;
          px = bcx + (dx - dy) * Math.cos(iso);
          py = bcy + (dx + dy) * Math.sin(iso) * Math.cos(tilt);
        } else {
          const ang = Math.atan2(dy, dx);
          const ps = Math.abs(Math.cos(ang) * Math.cos(tilt) + Math.sin(ang) * Math.sin(tilt));
          py = bcy + (pt.y - bcy) * Math.cos(tilt);
          size = size * (0.3 + 0.7 * ps);
        }
      }
      let nextPt = null, nextR = null;
      if (n.riso && count > 1) {
        const t2 = ((i + 1) / count) * totalLen;
        const pt2 = pp.getPointAt(Math.min(t2, totalLen - 0.01));
        if (pt2) { nextPt = { x: pt2.x, y: pt2.y }; nextR = size; }
      }
      const seedIdx = Math.floor(seeds[i*5+4] * 9999);
      const _zoom = paper.view.zoom || 1;
      const risoOpts = { bristle: n.risoBristle||1, erosion: n.risoErosion||1, spread: n.risoSpread||0.38, bridge: n.risoBridge||1.4, zoom: _zoom };
      const ditherOpts = n.dither ? { dotSize: n.ditherDot||2, threshold: n.ditherThreshold||0.5, feather: n.ditherFeather||0, colorize: n.ditherColorize !== false, imgMode: n.ditherImgMode||'bayer', lineLen: n.lineLen, curvature: n.curvature, strokeWidth: n.strokeWidth||1.5, zoom: _zoom } : null;
      _nodesCtx.globalCompositeOperation = n.blendMode || 'source-over';
      window._ditherCurrentNode = n;

      window._ditherCurrentIdx = i;

      drawShape(_nodesCtx, n.style||'flat', n.type||'circle', px, py, size,
        n.fill||'#c8b8a2', rot, opacity, n.font, n.text,
        jx, jy, jr, js, n.strokeColor||'#1a1a1a', n.strokeWidth||0,
        n.noFill, n.noStroke, _asx, _asy,
        n.imgEl||null, !!n.riso, nextPt, nextR, charArr, charColors, seedIdx, risoOpts, ditherOpts, n.lineLen, n.curvature);
    }
    _nodesCtx.globalCompositeOperation = 'source-over';
  });
}

const _draw = paper.view.draw.bind(paper.view);
paper.view.draw = function () {
  // apply path animations before drawing
  const _scaleRestores = [];
  paths.forEach(p => {
    if (!p.loop) return;
    const basOp = p.opacity !== undefined ? p.opacity : 1;
    const basSw = p.sw || 1.5;
    p.paperPath.opacity      = (_playing && p.loop.opacity) ? Math.max(0, Math.min(1, _aval(p, 'opacity', basOp, 0, 1))) : basOp;
    p.paperPath.strokeWidth  = (_playing && p.loop.sw)      ? Math.max(0, _aval(p, 'sw', basSw, 0, 1))                   : basSw;
    // scale: temporarily modify geometry so _draw() + renderNodes() both see scaled path
    if (_playing && p.loop.scale) {
      const basScale = p.scale || 1;
      const animScale = Math.max(0.01, _aval(p, 'scale', basScale, 0, 1));
      const f = animScale / basScale;
      if (Math.abs(f - 1) > 0.0001) {
        const center = p.paperPath.bounds.center;
        p.paperPath.scale(f, center);
        _scaleRestores.push({ p, invF: 1 / f, center });
      }
    }
  });
  _draw();
  _nodesCtx.clearRect(0, 0, _nodesCanvas.width, _nodesCanvas.height);

  // apply Paper.js view transform so world coords map correctly to screen
  const m = paper.view.matrix;
  const zoom = paper.view.zoom;
  _nodesCtx.save();
  _nodesCtx.setTransform(m.a, m.b, m.c, m.d, m.tx, m.ty);

  // draw grid in world space
  if (showGrid) {
    const vb = paper.view.bounds;
    const gs = 20;
    const dotSz = 1.5 / zoom;
    _nodesCtx.fillStyle = 'rgba(0,0,0,0.18)';
    const x0 = Math.floor(vb.x / gs) * gs, y0 = Math.floor(vb.y / gs) * gs;
    for (let x = x0; x < vb.x + vb.width + gs; x += gs)
      for (let y = y0; y < vb.y + vb.height + gs; y += gs)
        _nodesCtx.fillRect(x, y, dotSz, dotSz);
  }

  // draw nodes
  paths.forEach((p, pi) => renderNodes(p, pi));

  // restore temporarily scaled paths
  _scaleRestores.forEach(({ p, invF, center }) => p.paperPath.scale(invF, center));

  // riso noise in world space
  if (paths.some(p => p.nodes.some(n => n.riso))) {
    const vb = paper.view.bounds;
    _nodesCtx.save();
    for (let i = 0; i < 4000; i++) {
      _nodesCtx.globalAlpha = Math.random() * 0.05;
      _nodesCtx.fillStyle = '#000';
      _nodesCtx.fillRect(vb.x + Math.random() * vb.width, vb.y + Math.random() * vb.height, 1/zoom, 1/zoom);
    }
    _nodesCtx.restore();
  }

  // marquee in world space
  if (_marquee) {
    const mx1 = Math.min(_marquee.x1, _marquee.x2), mx2 = Math.max(_marquee.x1, _marquee.x2);
    const my1 = Math.min(_marquee.y1, _marquee.y2), my2 = Math.max(_marquee.y1, _marquee.y2);
    _nodesCtx.save();
    _nodesCtx.strokeStyle = '#4a90e2';
    _nodesCtx.lineWidth = 1 / zoom;
    _nodesCtx.setLineDash([4 / zoom, 3 / zoom]);
    _nodesCtx.strokeRect(mx1, my1, mx2 - mx1, my2 - my1);
    _nodesCtx.fillStyle = 'rgba(74,144,226,0.06)';
    _nodesCtx.fillRect(mx1, my1, mx2 - mx1, my2 - my1);
    _nodesCtx.restore();
  }

  _nodesCtx.restore(); // back to screen space

  // artboard overlay (screen space) — only when enabled and not exporting
  if (showArtboard && !_isExporting) {
    const ap1 = paper.view.projectToView(new paper.Point(artboard.x, artboard.y));
    const ap2 = paper.view.projectToView(new paper.Point(artboard.x + artboard.w, artboard.y + artboard.h));
    const ax = ap1.x, ay = ap1.y, aw = ap2.x - ap1.x, ah = ap2.y - ap1.y;
    const cw = _nodesCanvas.width, ch = _nodesCanvas.height;

    // dim outside
    _nodesCtx.fillStyle = 'rgba(0,0,0,0.02)';
    _nodesCtx.fillRect(0, 0, cw, ay);
    _nodesCtx.fillRect(0, ay + ah, cw, ch - ay - ah);
    _nodesCtx.fillRect(0, ay, ax, ah);
    _nodesCtx.fillRect(ax + aw, ay, cw - ax - aw, ah);

    // corner crosshair marks
    const arm = Math.min(18, aw * 0.06, ah * 0.06); // arm length
    _nodesCtx.strokeStyle = 'rgba(0,0,0,0.45)';
    _nodesCtx.lineWidth = 1;
    _nodesCtx.setLineDash([]);
    const corners = [[ax, ay], [ax + aw, ay], [ax + aw, ay + ah], [ax, ay + ah]];
    const dirs = [[ 1, 1], [-1, 1], [-1,-1], [ 1,-1]];
    corners.forEach(([cx2, cy2], i) => {
      const [dx2, dy2] = dirs[i];
      _nodesCtx.beginPath();
      _nodesCtx.moveTo(cx2 + dx2 * arm, cy2); _nodesCtx.lineTo(cx2, cy2); _nodesCtx.lineTo(cx2, cy2 + dy2 * arm);
      _nodesCtx.stroke();
    });
  }
};

let _highlightPath = null;
function highlightSelected() {
  clearHighlight();
  if (!selected || selected.type !== 'path') return;
  _highlightPath = paths[selected.pi].paperPath.clone();
  _highlightPath.strokeColor = '#4a90e2';
  _highlightPath.strokeWidth = 1;
  _highlightPath.dashArray = [4, 4];
  _highlightPath.fillColor = null;
  _highlightPath.opacity = 0.7;
}
function clearHighlight() {
  if (_highlightPath) { _highlightPath.remove(); _highlightPath = null; }
}

function updateArtboardBg() {
  // no Paper.js background rect — artboard is drawn as canvas2d overlay only
}

function buildPresetPath(pp, type, cx, cy, params) {
  pp.removeSegments();
  if (type === 'circle') {
    const r = params.radius || 160;
    const steps = 64;
    const arc = params.half ? Math.PI : Math.PI * 2;
    for (let i = 0; i <= steps; i++) {
      const a = (i/steps)*arc - Math.PI/2;
      pp.add(new paper.Point(cx + Math.cos(a)*r, cy + Math.sin(a)*r));
    }
    pp.smooth({ type: 'catmull-rom' });
  } else if (type === 'rect') {
    const r = params.size || 160;
    pp.add(new paper.Point(cx-r,cy-r)); pp.add(new paper.Point(cx+r,cy-r));
    pp.add(new paper.Point(cx+r,cy+r)); pp.add(new paper.Point(cx-r,cy+r)); pp.add(new paper.Point(cx-r,cy-r));
  } else if (type === 'line') {
    const hl = (params.length || 400) / 2;
    pp.add(new paper.Point(cx-hl,cy)); pp.add(new paper.Point(cx+hl,cy));
  } else if (type === 'wave') {
    const w = params.width || 400;
    const amp = params.amplitude || 60;
    const freq = params.frequency || 0.4;
    // ensure at least ~20 samples per cycle to avoid catmull-rom overshoot
    const cycles = freq * 40 / (2 * Math.PI);
    const steps = Math.max(40, Math.ceil(cycles * 20));
    for (let i = 0; i <= steps; i++) {
      pp.add(new paper.Point(cx - w/2 + i*(w/steps), cy + Math.sin(i*(freq*40/steps))*amp));
    }
    pp.smooth({ type: 'catmull-rom' });
  }
}

function regeneratePreset(pObj) {
  const c = pObj.paperPath.bounds.center;
  buildPresetPath(pObj.paperPath, pObj.presetType, c.x, c.y, pObj.presetParams || {});
  pushHistory();
  highlightSelected();
  paper.view.draw();
}

function makePreset(type) {
  const cx = paper.view.center.x, cy = paper.view.center.y;
  const pp = new paper.Path({ strokeColor: '#1a1a1a', strokeWidth: 1.5, strokeJoin: 'round', strokeCap: 'round' });
  const defaultParams = { circle:{radius:160,half:false}, rect:{size:160}, line:{length:400}, wave:{width:400,amplitude:60,frequency:0.4} };
  const params = defaultParams[type] || {};
  buildPresetPath(pp, type, cx, cy, params);
  const pObj = { paperPath:pp, stroke:'#1a1a1a', sw:1.5, opacity:1, visible:true, smooth:false, scale:1, nodes:[], presetType:type, presetParams: Object.assign({}, params) };
  paths.push(pObj);
      pushHistory();
  selected = { type:'path', pi:paths.length-1 };
  document.getElementById('empty-hint').style.display = 'none';
  highlightSelected(); updatePanel(); paper.view.draw();
}

['circle','rect','line','wave'].forEach(t => {
  const el = document.getElementById('pre-'+t);
  if (el) el.addEventListener('click', () => makePreset(t));
});

// preset shape param bindings
function _presetSlider(id, valId, paramKey, parse) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('input', e => {
    if (!selected || selected.type !== 'path') return;
    const pObj = paths[selected.pi];
    if (!pObj.presetType) return;
    const v = parse ? parse(e.target.value) : parseFloat(e.target.value);
    pObj.presetParams = pObj.presetParams || {};
    pObj.presetParams[paramKey] = v;
    document.getElementById(valId).textContent = v;
    regeneratePreset(pObj);
  });
}
_presetSlider('preset-radius', 'preset-radius-val', 'radius', parseFloat);
_presetSlider('preset-rect-size', 'preset-rect-size-val', 'size', parseFloat);
_presetSlider('preset-line-len', 'preset-line-len-val', 'length', parseFloat);
_presetSlider('preset-wave-width', 'preset-wave-width-val', 'width', parseFloat);
_presetSlider('preset-wave-amp', 'preset-wave-amp-val', 'amplitude', parseFloat);
_presetSlider('preset-wave-freq', 'preset-wave-freq-val', 'frequency', v => Math.round(parseFloat(v)*100)/100);

document.getElementById('preset-half').addEventListener('change', e => {
  if (!selected || selected.type !== 'path') return;
  const pObj = paths[selected.pi];
  if (!pObj.presetType) return;
  pObj.presetParams = pObj.presetParams || {};
  pObj.presetParams.half = e.target.checked;
  regeneratePreset(pObj);
});

const pt = new paper.Tool();
let _marquee = null;
let _penDragging = false;
let _penPreviewPath = null;

function _penClearPreview() {
  if (_penPreviewPath) { _penPreviewPath.remove(); _penPreviewPath = null; }
}

pt.onMouseMove = function (e) {
  if ((activeTool === 'path' || activeTool === 'pen') && currentDraw && currentDraw.paperPath.segments.length > 0) {
    _penClearPreview();
    const last = currentDraw.paperPath.lastSegment;
    _penPreviewPath = new paper.Path({ strokeColor:'#4a90e2', strokeWidth:1, opacity:0.5, dashArray:[4,4] });
    if (activeTool === 'pen' && last.handleOut && last.handleOut.length > 0.5) {
      // show curved preview using a temp bezier segment
      const seg0 = new paper.Segment(last.point, null, last.handleOut.clone());
      const seg1 = new paper.Segment(e.point);
      _penPreviewPath.add(seg0); _penPreviewPath.add(seg1);
    } else {
      _penPreviewPath.add(last.point); _penPreviewPath.add(e.point);
    }
    paper.view.draw();
  } else {
    if (_penPreviewPath) { _penClearPreview(); paper.view.draw(); }
  }
};

pt.onMouseDown = function (e) {
  if (_spacePan) { _panLast = { x: e.event.clientX, y: e.event.clientY }; return; }
  if (activeTool === 'select') {
    // start marquee if no hit
    const hit = paper.project.hitTest(e.point, { stroke:true, fill:true, tolerance:12 });
    let closest = -1, minDist = 16;
    paths.forEach((p, pi) => {
      const nearest = p.paperPath.getNearestPoint(e.point);
      if (nearest) { const d = nearest.getDistance(e.point); if (d < minDist) { minDist = d; closest = pi; } }
    });
    if (!hit && closest < 0) {
      _marquee = { x1: e.point.x, y1: e.point.y, x2: e.point.x, y2: e.point.y };
      return;
    }
  }
  if (activeTool === 'pen') {
    _penClearPreview();
    if (!currentDraw) {
      const pp = new paper.Path({ strokeColor:'#1a1a1a', strokeWidth:1.5, strokeJoin:'round', strokeCap:'round' });
      currentDraw = { paperPath:pp, stroke:'#1a1a1a', sw:1.5, opacity:1, visible:true, smooth:false, scale:1, nodes:[] };
      paths.push(currentDraw);
    }
    currentDraw.paperPath.add(new paper.Segment(e.point));
    _penDragging = true;
    paper.view.draw();
  } else if (activeTool === 'path') {
    if (!currentDraw) {
      const pp = new paper.Path({ strokeColor:'#1a1a1a', strokeWidth:1.5, strokeJoin:'round', strokeCap:'round' });
      currentDraw = { paperPath:pp, stroke:'#1a1a1a', sw:1.5, opacity:1, visible:true, smooth:false, scale:1, nodes:[] };
      paths.push(currentDraw);
    }
    currentDraw.paperPath.add(e.point); paper.view.draw();
  } else if (activeTool === 'select') {
    const hit = paper.project.hitTest(e.point, { stroke:true, fill:true, tolerance:12 });
    if (hit && hit.item) {
      const pi = paths.findIndex(p => p.paperPath === hit.item);
      if (pi >= 0) { selected = { type:'path', pi }; highlightSelected(); updatePanel(); return; }
    }
    let closest = -1, minDist = 16;
    paths.forEach((p, pi) => {
      const nearest = p.paperPath.getNearestPoint(e.point);
      if (nearest) { const d = nearest.getDistance(e.point); if (d < minDist) { minDist = d; closest = pi; } }
    });
    if (closest >= 0) { selected = { type:'path', pi:closest }; highlightSelected(); updatePanel(); return; }
    selected = null; clearHighlight(); updatePanel();
  }
};
pt.onMouseDrag = function (e) {
  // middle-mouse pan is handled by window mousemove; bail out here to avoid
  // simultaneously translating the selected path while panning the view
  if (_midPanLast) return;
  if (_spacePan && _panLast) {
    paper.view.center = paper.view.center.subtract(e.delta);
    paper.view.draw(); return;
  }
  if (activeTool === 'pen' && _penDragging && currentDraw) {
    const segs = currentDraw.paperPath.segments;
    const last = segs[segs.length - 1];
    const delta = e.point.subtract(last.point);
    last.handleOut = delta;
    last.handleIn = delta.negate();
    paper.view.draw();
    return;
  }
  if (activeTool === 'select') {
    if (_marquee) {
      _marquee.x2 = e.point.x; _marquee.y2 = e.point.y;
      paper.view.draw(); return;
    }
    if (selected && selected.type === 'path') {
      paths[selected.pi].paperPath.translate(e.delta);
      if (_highlightPath) _highlightPath.translate(e.delta);
      paper.view.draw();
    }
  }
};
pt.onMouseUp = function (e) {
  if (_spacePan) { _panLast = null; return; }
  if (activeTool === 'pen') { _penDragging = false; }
  if (_marquee) {
    const mx1 = Math.min(_marquee.x1, _marquee.x2), mx2 = Math.max(_marquee.x1, _marquee.x2);
    const my1 = Math.min(_marquee.y1, _marquee.y2), my2 = Math.max(_marquee.y1, _marquee.y2);
    if (mx2 - mx1 > 4 || my2 - my1 > 4) {
      // find first path whose bounds intersect marquee
      for (let pi = 0; pi < paths.length; pi++) {
        const b = paths[pi].paperPath.bounds;
        if (b.x < mx2 && b.x+b.width > mx1 && b.y < my2 && b.y+b.height > my1) {
          selected = { type:'path', pi }; highlightSelected(); updatePanel(); break;
        }
      }
    }
    _marquee = null; paper.view.draw();
  }
};
pt.onKeyDown = function (e) {
  if (e.key === 'escape') {
    _penClearPreview(); _penDragging = false;
    if (currentDraw && currentDraw.paperPath.segments.length < 2) { currentDraw.paperPath.remove(); paths.pop(); }
    currentDraw = null; paper.view.draw();
  }
};

document.getElementById('canvas').addEventListener('dblclick', () => {
  if ((activeTool === 'path' || activeTool === 'pen') && currentDraw) {
    _penClearPreview(); _penDragging = false;
    // remove the last segment added by the second click of dblclick
    if (currentDraw.paperPath.segments.length > 2) currentDraw.paperPath.removeSegment(currentDraw.paperPath.segments.length - 1);
    if (currentDraw.paperPath.segments.length >= 2) {
      if (currentDraw.smooth && activeTool === 'path') currentDraw.paperPath.smooth({ type:'catmull-rom' });
      selected = { type:'path', pi:paths.length-1 };
    } else { currentDraw.paperPath.remove(); paths.pop(); }
    currentDraw = null;
    document.getElementById('empty-hint').style.display = 'none';
    highlightSelected(); updatePanel(); paper.view.draw();
  }
});

function setTool(t) {
  activeTool = t;
  if (t !== 'path' && t !== 'pen' && currentDraw) {
    _penClearPreview(); _penDragging = false;
    if (currentDraw.paperPath.segments.length < 2) { currentDraw.paperPath.remove(); paths.pop(); }
    currentDraw = null;
  }
  if (t === 'select') { _penClearPreview(); }
  ['select','path','pen'].forEach(n => {
    const b = document.getElementById('btn-'+n); if (b) b.classList.toggle('active', n === t);
  });
  document.getElementById('canvas').style.cursor = (t === 'path' || t === 'pen') ? 'crosshair' : 'default';
}
document.getElementById('btn-select').addEventListener('click', () => setTool('select'));
document.getElementById('btn-path').addEventListener('click', () => setTool('path'));
document.getElementById('btn-pen').addEventListener('click', () => setTool('pen'));

// space keyup
document.addEventListener('keyup', e => {
  if (e.code === 'Space') {
    _spacePan = false; _panLast = null;
    _canvas.style.cursor = (activeTool === 'select') ? 'default' : 'crosshair';
  }
});

// middle-mouse pan
let _midPanLast = null;
_canvas.addEventListener('mousedown', e => {
  if (e.button === 1) { e.preventDefault(); _midPanLast = { x: e.clientX, y: e.clientY }; }
});
window.addEventListener('mousemove', e => {
  if (_midPanLast) {
    const dx = e.clientX - _midPanLast.x, dy = e.clientY - _midPanLast.y;
    paper.view.center = paper.view.center.subtract(new paper.Point(dx / paper.view.zoom, dy / paper.view.zoom));
    _midPanLast = { x: e.clientX, y: e.clientY };
    paper.view.draw();
  }
});
window.addEventListener('mouseup', e => { if (e.button === 1) _midPanLast = null; });

// scroll zoom
_canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
  const newZoom = Math.max(0.05, Math.min(20, paper.view.zoom * factor));
  const mouseWorld = paper.view.viewToProject(new paper.Point(e.offsetX, e.offsetY));
  const beta = paper.view.zoom / newZoom;
  const pc = mouseWorld.subtract(paper.view.center);
  const offset = mouseWorld.subtract(pc.multiply(beta)).subtract(paper.view.center);
  paper.view.zoom = newZoom;
  paper.view.center = paper.view.center.add(offset);
  // update zoom indicator
  const zi = document.getElementById('zoom-indicator');
  if (zi) zi.textContent = Math.round(paper.view.zoom * 100) + '%';
  paper.view.draw();
}, { passive: false });

document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.code === 'Space') {
    e.preventDefault();
    if (!_spacePan) { _spacePan = true; _canvas.style.cursor = 'grab'; }
    return;
  }
  if (e.key === 'v' || e.key === 'V') setTool('select');
  if (e.key === 'p' || e.key === 'P') setTool('path');
  if (e.key === 'b' || e.key === 'B') setTool('pen');
  if ((e.key === 'Delete' || e.key === 'Backspace') && selected) {
    if (selected.type === 'path') { paths[selected.pi].paperPath.remove(); paths.splice(selected.pi,1); selected=null; clearHighlight(); }
    else if (selected.type === 'node') {
      const _dpi = selected.pi, _dni = selected.ni;
      const _dnodes = paths[_dpi].nodes;
      _dnodes.splice(_dni, 1);
      _dnodes.forEach(nd => {
        if (nd.parentNi !== null && nd.parentNi !== undefined) {
          if (nd.parentNi === _dni) nd.parentNi = null;
          else if (nd.parentNi > _dni) nd.parentNi--;
        }
      });
      selected = {type:'path', pi:_dpi}; highlightSelected();
    }
    updatePanel(); paper.view.draw();
  }
});

// ── text → path (opentype.js + Outfit font) ──────────────────────────────
let _otFont = null;
const OUTFIT_URL = 'https://fonts.gstatic.com/s/outfit/v15/QGYyz_MVcBeNP4NjuGObqx1XmO1I4TC1C4E.ttf';
opentype.load(OUTFIT_URL, (err, font) => {
  const status = document.getElementById('text-path-font-status');
  if (err) { if (status) status.textContent = 'font failed'; return; }
  _otFont = font;
  if (status) status.textContent = 'Outfit';
});

document.getElementById('btn-text-path').addEventListener('click', e => {
  const pop = document.getElementById('text-path-popover');
  pop.classList.toggle('open');
  e.stopPropagation();
});
document.addEventListener('click', e => {
  const pop = document.getElementById('text-path-popover');
  if (!pop.contains(e.target) && e.target.id !== 'btn-text-path') pop.classList.remove('open');
});
document.getElementById('tp-size').addEventListener('input', e => {
  document.getElementById('tp-size-val').textContent = e.target.value;
});
// Convert opentype.js path commands directly to Paper.js paths — no importSVG, no regex
function otCommandsToPaperPaths(commands) {
  const result = [];
  let cur = null, lastX = 0, lastY = 0;
  commands.forEach(cmd => {
    if (cmd.type === 'M') {
      if (cur) { if (cur.segments.length > 1) result.push(cur); else cur.remove(); }
      cur = new paper.Path();
      cur.add(new paper.Segment(new paper.Point(cmd.x, cmd.y)));
      lastX = cmd.x; lastY = cmd.y;
    } else if (cmd.type === 'L') {
      if (!cur) return;
      cur.add(new paper.Segment(new paper.Point(cmd.x, cmd.y)));
      lastX = cmd.x; lastY = cmd.y;
    } else if (cmd.type === 'C') {
      if (!cur) return;
      cur.lastSegment.handleOut = new paper.Point(cmd.x1 - lastX, cmd.y1 - lastY);
      cur.add(new paper.Segment(new paper.Point(cmd.x, cmd.y), new paper.Point(cmd.x2 - cmd.x, cmd.y2 - cmd.y), null));
      lastX = cmd.x; lastY = cmd.y;
    } else if (cmd.type === 'Q') {
      if (!cur) return;
      // convert quadratic to cubic
      const cx1 = lastX + 2/3 * (cmd.x1 - lastX), cy1 = lastY + 2/3 * (cmd.y1 - lastY);
      const cx2 = cmd.x  + 2/3 * (cmd.x1 - cmd.x),  cy2 = cmd.y  + 2/3 * (cmd.y1 - cmd.y);
      cur.lastSegment.handleOut = new paper.Point(cx1 - lastX, cy1 - lastY);
      cur.add(new paper.Segment(new paper.Point(cmd.x, cmd.y), new paper.Point(cx2 - cmd.x, cy2 - cmd.y), null));
      lastX = cmd.x; lastY = cmd.y;
    } else if (cmd.type === 'Z') {
      if (cur) { cur.closed = true; if (cur.segments.length > 1) result.push(cur); else cur.remove(); cur = null; }
    }
  });
  if (cur) { if (cur.segments.length > 1) result.push(cur); else cur.remove(); }
  return result;
}

document.getElementById('tp-add').addEventListener('click', () => {
  if (!_otFont) { alert('Font not loaded yet, please wait.'); return; }
  const text = document.getElementById('tp-text').value.trim();
  if (!text) return;
  const size = parseInt(document.getElementById('tp-size').value) || 120;

  // getPaths() gives one opentype Path per glyph; convert commands directly to Paper.js paths
  const glyphPaths = _otFont.getPaths(text, 0, 0, size);
  const collected = [];
  glyphPaths.forEach(gp => {
    if (!gp.commands || gp.commands.length === 0) return;
    otCommandsToPaperPaths(gp.commands).forEach(p => collected.push(p));
  });

  if (collected.length === 0) return;

  // center on current view
  const cx = paper.view.center.x, cy = paper.view.center.y;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  collected.forEach(p => {
    const b = p.bounds;
    if (b.x < minX) minX = b.x; if (b.y < minY) minY = b.y;
    if (b.x + b.width > maxX) maxX = b.x + b.width;
    if (b.y + b.height > maxY) maxY = b.y + b.height;
  });
  const dx = cx - (minX + maxX) / 2, dy = cy - (minY + maxY) / 2;

  const firstPi = paths.length;
  collected.forEach(p => {
    p.translate(new paper.Point(dx, dy));
    p.strokeColor = new paper.Color('#1a1a1a');
    p.strokeWidth = 1.5;
    p.fillColor = null;
    paper.project.activeLayer.addChild(p);
    const pObj = { paperPath: p, stroke: '#1a1a1a', sw: 1.5, opacity: 1, visible: true, smooth: false, scale: 1, nodes: [] };
    paths.push(pObj);
  });

  selected = { type: 'path', pi: firstPi };
  document.getElementById('empty-hint').style.display = 'none';
  document.getElementById('text-path-popover').classList.remove('open');
  pushHistory(); highlightSelected(); updatePanel(); paper.view.draw();
});

document.getElementById('btn-import-svg').addEventListener('click', () => {
  document.getElementById('input-import-svg').click();
});
document.getElementById('input-import-svg').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    const svgStr = ev.target.result;
    const imported = paper.project.importSVG(svgStr, { expandShapes: true, insert: false });
    // collect all Paper.js Path objects from the imported group
    const collected = [];
    function collectPaths(item) {
      if (item instanceof paper.Path) { collected.push(item); }
      else if (item.children) { item.children.forEach(collectPaths); }
    }
    collectPaths(imported);
    if (collected.length === 0) { alert('No paths found in SVG.'); return; }
    const cx = paper.view.center.x, cy = paper.view.center.y;
    // compute bounding box of all collected paths
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    collected.forEach(p => {
      const b = p.bounds;
      if (b.x < minX) minX = b.x; if (b.y < minY) minY = b.y;
      if (b.x+b.width > maxX) maxX = b.x+b.width; if (b.y+b.height > maxY) maxY = b.y+b.height;
    });
    const dx = cx - (minX + maxX) / 2, dy = cy - (minY + maxY) / 2;
    let firstPi = paths.length;
    collected.forEach(p => {
      p.translate(new paper.Point(dx, dy));
      p.strokeColor = p.strokeColor || new paper.Color('#1a1a1a');
      p.strokeWidth = p.strokeWidth || 1.5;
      p.strokeJoin = 'round'; p.strokeCap = 'round';
      paper.project.activeLayer.addChild(p);
      const pObj = { paperPath: p, stroke: p.strokeColor.toCSS(true), sw: p.strokeWidth,
        opacity: 1, visible: true, smooth: false, scale: 1, nodes: [] };
      paths.push(pObj);
    });
    selected = { type: 'path', pi: firstPi };
    document.getElementById('empty-hint').style.display = 'none';
    pushHistory(); highlightSelected(); updatePanel(); paper.view.draw();
  };
  reader.readAsText(file);
  e.target.value = '';
});

document.getElementById('btn-delete').addEventListener('click', () => {
  if (!selected) return;
  if (selected.type === 'path') { paths[selected.pi].paperPath.remove(); paths.splice(selected.pi,1); selected=null; clearHighlight(); }
  else if (selected.type === 'node') {
    const _dpi = selected.pi, _dni = selected.ni;
    const _dnodes = paths[_dpi].nodes;
    _dnodes.splice(_dni, 1);
    _dnodes.forEach(nd => {
      if (nd.parentNi !== null && nd.parentNi !== undefined) {
        if (nd.parentNi === _dni) nd.parentNi = null;
        else if (nd.parentNi > _dni) nd.parentNi--;
      }
    });
    selected = {type:'path', pi:_dpi}; highlightSelected();
  }
  updatePanel(); paper.view.draw();
});
document.getElementById('btn-clear').addEventListener('click', () => {
  paths.forEach(p => p.paperPath.remove()); paths=[]; selected=null; currentDraw=null; clearHighlight();
  document.getElementById('empty-hint').style.display = 'block';
  updatePanel(); paper.view.draw();
});
document.getElementById('btn-add-node').addEventListener('click', () => {
  if (!selected || selected.type !== 'path') return;
  paths[selected.pi].nodes.push({
    name:'', style:'flat', type:'circle', fill:'#c8b8a2',
    strokeColor:'#1a1a1a', strokeWidth:0, size:16, sizeEnd:16,
    rotation:0, follow:false, count:1, offset:0,
    opStart:1, opEnd:1, jitter:0, rotJitter:0, sizeJitter:0,
    tilt3d:0, tiltMode:'perspective', sx:100, sy:100,
    noFill:false, noStroke:true, riso:false,
    charArray:'', colorArray:'', parentNi:null
  });
      pushHistory();
  selected = { type:'node', pi:selected.pi, ni:paths[selected.pi].nodes.length-1 };
  updatePanel(); paper.view.draw();
});
document.getElementById('btn-duplicate').addEventListener('click', () => {
  if (!selected || selected.type !== 'path') return;
  const orig = paths[selected.pi], clone = orig.paperPath.clone();
  clone.translate(new paper.Point(20,20));
  paths.push({ paperPath:clone, stroke:orig.stroke, sw:orig.sw, opacity:orig.opacity, visible:orig.visible, smooth:orig.smooth, scale:orig.scale||1, nodes:orig.nodes.map(n=>({...n,imgEl:undefined})) });
  selected = { type:'path', pi:paths.length-1 }; highlightSelected(); updatePanel(); paper.view.draw();
});

// ── node layer list with drag-to-reorder ──────────────────────────────────
let _dragNi = null;

function buildNodeList(pObj, pi) {
  const nl = document.getElementById('node-list');
  nl.innerHTML = '';
  pObj.nodes.forEach((n, ni) => {
    const isSub = n.parentNi !== null && n.parentNi !== undefined;
    const isSel = selected && selected.type === 'node' && selected.ni === ni;
    const div = document.createElement('div');
    div.className = 'node-item' + (isSel ? ' sel' : '') + (isSub ? ' sub' : '');
    div.draggable = true;
    div.dataset.ni = ni;
    const icon = n.riso ? '◎' : n.style === 'rough' ? '⌇' : '●';
    const subIcon = isSub ? `<span class="sub-badge">↳</span>` : '';
    const label = n.name || (n.charArray ? `[${n.charArray}]` : n.text ? `"${n.text}"` : n.type);
    div.innerHTML = `
      <span class="node-drag-handle">⠿</span>
      ${subIcon}
      <span class="node-dot" style="background:${n.fill||'#c8b8a2'}"></span>
      <span class="node-lbl">${icon} ${label}</span>
      <span class="node-cnt">×${n.count||1}</span>
      <span class="node-link-btn" title="link as sub-layer" data-ni="${ni}">⊕</span>
    `;
    div.addEventListener('click', (e) => {
      if (e.target.classList.contains('node-link-btn')) return;
      selected = { type:'node', pi, ni }; updatePanel();
    });
    div.querySelector('.node-link-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      const targetNi = parseInt(e.target.dataset.ni);
      const n2 = pObj.nodes[targetNi];
      // toggle: if already has parent, unlink; else link to previous node
      if (n2.parentNi !== null && n2.parentNi !== undefined) {
        n2.parentNi = null;
      } else {
        const prevNi = targetNi > 0 ? targetNi - 1 : null;
        if (prevNi !== null) n2.parentNi = prevNi;
      }
      updatePanel(); paper.view.draw();
    });
    // drag reorder
    div.addEventListener('dragstart', () => { _dragNi = ni; div.style.opacity = '0.4'; });
    div.addEventListener('dragend', () => { _dragNi = null; div.style.opacity = ''; });
    div.addEventListener('dragover', (e) => { e.preventDefault(); div.style.background = 'rgba(74,144,226,0.12)'; });
    div.addEventListener('dragleave', () => { div.style.background = ''; });
    div.addEventListener('drop', (e) => {
      e.preventDefault(); div.style.background = '';
      if (_dragNi === null || _dragNi === ni) return;
      const nodes = pObj.nodes;
      pushHistory();
      const moved = nodes.splice(_dragNi, 1)[0];
      const newNi = _dragNi < ni ? ni - 1 : ni;
      nodes.splice(newNi, 0, moved);
      // fix parentNi references after reorder
      nodes.forEach(nd => {
        if (nd.parentNi !== null && nd.parentNi !== undefined) {
          if (nd.parentNi === _dragNi) nd.parentNi = newNi;
          else if (_dragNi < newNi) {
            if (nd.parentNi > _dragNi && nd.parentNi <= newNi) nd.parentNi--;
          } else {
            if (nd.parentNi >= newNi && nd.parentNi < _dragNi) nd.parentNi++;
          }
        }
      });
      if (selected && selected.type === 'node') {
        if (selected.ni === _dragNi) selected.ni = newNi;
        else if (_dragNi < newNi && selected.ni > _dragNi && selected.ni <= newNi) selected.ni--;
        else if (_dragNi > newNi && selected.ni >= newNi && selected.ni < _dragNi) selected.ni++;
      }
      updatePanel(); paper.view.draw();
    });
    nl.appendChild(div);
  });
}

function updatePanel() {
  ['props-empty','props-path','props-node'].forEach(id => document.getElementById(id).style.display = 'none');
  document.getElementById('node-list').innerHTML = '';
  if (!selected) {
    document.getElementById('props-empty').style.display = 'block';
    document.getElementById('panel-title').textContent = 'Properties'; return;
  }
  const pObj = paths[selected.pi];
  const nlw = document.getElementById('node-list-wrap');
  nlw.style.display = pObj.nodes.length > 0 ? 'block' : 'none';
  buildNodeList(pObj, selected.pi);

  if (selected.type === 'path') {
    document.getElementById('panel-title').textContent = 'Path';
    document.getElementById('props-path').style.display = 'block';
    const p = pObj;
    document.getElementById('path-stroke').value = p.stroke||'#1a1a1a';
    document.getElementById('path-sw').value = p.sw||1.5; document.getElementById('path-sw-val').textContent = p.sw||1.5;
    document.getElementById('path-op').value = p.opacity||1; document.getElementById('path-op-val').textContent = Math.round((p.opacity||1)*100)+'%';
    document.getElementById('path-visible').checked = p.visible!==false;
    document.getElementById('path-smooth').checked = !!p.smooth;
    // sync path loop buttons
    document.querySelectorAll('.path-loop-btn').forEach(btn => {
      btn.classList.toggle('on', !!(p.loop && p.loop[btn.dataset.pathloop]));
    });
    const sc = p.scale||1; document.getElementById('path-scale').value = Math.round(sc*100); document.getElementById('path-scale-val').textContent = Math.round(sc*100)+'%';
    // preset shape params
    const presetWrap = document.getElementById('preset-shape-params');
    ['circle','rect','line','wave'].forEach(t => document.getElementById('preset-'+t+'-params').style.display='none');
    if (p.presetType) {
      presetWrap.style.display = 'block';
      document.getElementById('preset-'+p.presetType+'-params').style.display = 'block';
      const pr = p.presetParams || {};
      if (p.presetType === 'circle') {
        document.getElementById('preset-radius').value = pr.radius||160;
        document.getElementById('preset-radius-val').textContent = pr.radius||160;
        document.getElementById('preset-half').checked = !!pr.half;
      } else if (p.presetType === 'rect') {
        document.getElementById('preset-rect-size').value = pr.size||160;
        document.getElementById('preset-rect-size-val').textContent = pr.size||160;
      } else if (p.presetType === 'line') {
        document.getElementById('preset-line-len').value = pr.length||400;
        document.getElementById('preset-line-len-val').textContent = pr.length||400;
      } else if (p.presetType === 'wave') {
        document.getElementById('preset-wave-width').value = pr.width||400;
        document.getElementById('preset-wave-width-val').textContent = pr.width||400;
        document.getElementById('preset-wave-amp').value = pr.amplitude||60;
        document.getElementById('preset-wave-amp-val').textContent = pr.amplitude||60;
        document.getElementById('preset-wave-freq').value = pr.frequency||0.4;
        document.getElementById('preset-wave-freq-val').textContent = pr.frequency||0.4;
      }
    } else {
      presetWrap.style.display = 'none';
    }
  }
  if (selected.type === 'node') {
    const n = pObj.nodes[selected.ni];
    document.getElementById('panel-title').textContent = n.parentNi !== null && n.parentNi !== undefined ? 'Sub-layer' : 'Node Layer';
    document.getElementById('props-node').style.display = 'block';
    const sv = (id,v) => document.getElementById(id).value = v;
    const tv = (id,v) => document.getElementById(id).textContent = v;
    const pc = v => Math.round(v*100)+'%';
    sv('node-name', n.name||'');
    sv('node-style', n.style||'flat'); sv('node-type', n.type||'circle');
    sv('node-blend', n.blendMode||'source-over');
    document.getElementById('node-riso').checked = !!n.riso;
    // parent selector
    const parentSel = document.getElementById('node-parent');
    parentSel.innerHTML = '<option value="">— none —</option>';
    pObj.nodes.forEach((nd, idx) => {
      if (idx === selected.ni) return;
      const opt = document.createElement('option');
      opt.value = idx; opt.textContent = `#${idx} ${nd.name||nd.type}`;
      if (n.parentNi === idx) opt.selected = true;
      parentSel.appendChild(opt);
    });
    sv('node-fill', n.fill||'#c8b8a2'); sv('node-stroke-color', n.strokeColor||'#1a1a1a');
    sv('node-sw', n.strokeWidth||0); tv('node-sw-val', n.strokeWidth||0);
    document.getElementById('node-no-fill').checked = !n.noFill;
    document.getElementById('node-no-stroke').checked = !n.noStroke;
    sv('node-size', n.size||16); tv('node-size-val', n.size||16);
    if (n.sizeEnd === undefined) n.sizeEnd = n.size || 16;
    sv('node-size-end', n.sizeEnd); tv('node-size-end-val', n.sizeEnd!==undefined?n.sizeEnd:n.size||16);
    sv('node-rot', n.rotation||0); tv('node-rot-val', (n.rotation||0)+'°');
    document.getElementById('node-follow').checked = !!n.follow;
    sv('node-count', n.count||1); tv('node-count-val', n.count||1);
    sv('node-offset', n.offset||0); tv('node-offset-val', pc(n.offset||0));
    sv('node-tilt', n.tilt3d||0); tv('node-tilt-val', (n.tilt3d||0)+'°');
    document.getElementById('node-tilt-mode').value = n.tiltMode||'perspective';
    sv('node-sx', n.sx||100); tv('node-sx-val', (n.sx||100)+'%');
    sv('node-sy', n.sy||100); tv('node-sy-val', (n.sy||100)+'%');
    sv('node-op-start', n.opStart!==undefined?n.opStart:1); tv('node-op-start-val', pc(n.opStart!==undefined?n.opStart:1));
    sv('node-op-end', n.opEnd!==undefined?n.opEnd:1); tv('node-op-end-val', pc(n.opEnd!==undefined?n.opEnd:1));
    sv('node-jitter', n.jitter||0); tv('node-jitter-val', n.jitter||0);
    sv('node-rot-jitter', n.rotJitter||0); tv('node-rot-jitter-val', (n.rotJitter||0)+'°');
    sv('node-size-jitter', n.sizeJitter||0); tv('node-size-jitter-val', n.sizeJitter||0);
    // Feature 3: grey out ALL inputs for child nodes except size/size-end/size-mode
    const isChild = n.parentNi !== null && n.parentNi !== undefined;
  const _childDisabled = [
    'node-jitter','node-rot-jitter','node-size-jitter',
    'node-tilt','node-tilt-mode','node-sx','node-sy',
    'node-offset','node-follow','node-count'
  ];
  const _allNodeInputs = [
    'node-style','node-type','node-blend','node-riso','node-parent',
    'node-fill','node-stroke-color','node-sw','node-no-fill','node-no-stroke',
    'node-rot','node-follow','node-count','node-offset',
    'node-tilt','node-tilt-mode','node-sx','node-sy',
    'node-op-start','node-op-end','node-jitter','node-rot-jitter','node-size-jitter',
    'node-dither','node-linelen','node-curvature',
    'node-text','node-font','node-char-array','node-color-array',
    'node-imgarray-mode','node-imgarray-count'
  ];
  _allNodeInputs.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    const shouldDisable = isChild && _childDisabled.includes(id);
    el.disabled = shouldDisable;
    const row = el.closest('.prop-row') || el.closest('.row-inline') || el.parentElement;
    if (row) row.style.opacity = shouldDisable ? '0.4' : '';
  });
    const isText = n.type==='text', isImage = n.type==='image', isSvg = n.type==='svg';
    document.getElementById('node-text-row').style.display = isText?'block':'none';
    document.getElementById('node-font-row').style.display = isText?'block':'none';
    document.getElementById('node-char-row').style.display = isText?'block':'none';
    document.getElementById('node-color-array-row').style.display = 'block';
    document.getElementById('node-image-row').style.display = isImage?'block':'none';
    document.getElementById('node-svg-row').style.display = isSvg?'block':'none';
    if (isSvg) { document.getElementById('node-svg-name').textContent = n.svgName||'no svg loaded'; }
    if (isText) { sv('node-text', n.text||''); sv('node-font', n.font||'sans-serif'); sv('node-char-array', n.charArray||''); sv('node-color-array', n.colorArray||''); }
    if (isImage) { document.getElementById('node-image-name').textContent = n.imgName||'no image loaded'; }
    // Feature 4: shape-specific params
    const isLine = n.type==='line', isArcCurve = n.type==='arc'||n.type==='curve';
    document.getElementById('node-linelen-row').style.display = (isLine||isArcCurve)?'block':'none';
    document.getElementById('node-curvature-row').style.display = isArcCurve?'block':'none';
    if (isLine||isArcCurve) {
      if (n.lineLen===undefined) n.lineLen = 100;
      sv('node-linelen', n.lineLen); tv('node-linelen-val', n.lineLen);
    }
    if (isArcCurve) {
      if (n.curvature===undefined) n.curvature = 50;
      sv('node-curvature', n.curvature); tv('node-curvature-val', n.curvature);
    }
    // sync loop buttons
    document.querySelectorAll('.loop-btn').forEach(btn => {
      btn.classList.toggle('on', !!(n.loop && n.loop[btn.dataset.loop]));
    });
  }
}

const gP = () => selected && selected.type==='path' ? paths[selected.pi] : null;
const gN = () => selected && selected.type==='node' ? paths[selected.pi].nodes[selected.ni] : null;
const pct = v => Math.round(v*100)+'%';
function bR(id,vid,fmt,cb){document.getElementById(id).addEventListener('input',e=>{const v=parseFloat(e.target.value);if(vid)document.getElementById(vid).textContent=fmt?fmt(v):v;cb(v);paper.view.draw();});}
function bC(id,cb){document.getElementById(id).addEventListener('change',e=>{cb(e.target.checked);paper.view.draw();});}
function bCol(id,cb){document.getElementById(id).addEventListener('input',e=>{cb(e.target.value);paper.view.draw();});}
function bSel(id,cb){document.getElementById(id).addEventListener('change',e=>{cb(e.target.value);updatePanel();paper.view.draw();});}
function bTxt(id,cb){document.getElementById(id).addEventListener('input',e=>{cb(e.target.value);paper.view.draw();});}

bTxt('node-name',v=>{const n=gN();if(n)n.name=v;});
bCol('path-stroke',v=>{const p=gP();if(p){p.stroke=v;p.paperPath.strokeColor=v;}});
bR('path-sw','path-sw-val',null,v=>{const p=gP();if(p){p.sw=v;p.paperPath.strokeWidth=v;}});
bR('path-op','path-op-val',pct,v=>{const p=gP();if(p){p.opacity=v;p.paperPath.opacity=v;}});
bC('path-visible',v=>{const p=gP();if(p){p.visible=v;p.paperPath.visible=v;}});
bC('path-smooth',v=>{const p=gP();if(!p)return;p.smooth=v;if(v)p.paperPath.smooth({type:'catmull-rom'});else p.paperPath.segments.forEach(s=>{s.handleIn=new paper.Point(0,0);s.handleOut=new paper.Point(0,0);});});
document.getElementById('path-scale').addEventListener('input',e=>{
  const p=gP();if(!p)return;
  const ns=parseFloat(e.target.value)/100,os=p.scale||1,f=ns/os;
  p.paperPath.scale(f,p.paperPath.bounds.center);
  if(_highlightPath)_highlightPath.scale(f,_highlightPath.bounds.center);
  p.scale=ns;document.getElementById('path-scale-val').textContent=Math.round(ns*100)+'%';
  paper.view.draw();
});
bSel('node-style',v=>{const n=gN();if(n)n.style=v;});
bC('node-riso',v=>{const n=gN();if(n)n.riso=v;});
bSel('node-type',v=>{const n=gN();if(n)n.type=v;});
bCol('node-fill',v=>{const n=gN();if(n)n.fill=v;});
bCol('node-stroke-color',v=>{const n=gN();if(n)n.strokeColor=v;});
bR('node-sw','node-sw-val',null,v=>{const n=gN();if(n)n.strokeWidth=v;});
bC('node-no-fill',v=>{const n=gN();if(n)n.noFill=!v;});
bC('node-no-stroke',v=>{const n=gN();if(n)n.noStroke=!v;});
bR('node-size','node-size-val',null,v=>{
  const n=gN();if(!n)return;
  // sync sizeEnd if it was equal to size (user hasn't diverged them)
  if(n.sizeEnd===undefined||n.sizeEnd===n.size) {
    n.sizeEnd=v;
    document.getElementById('node-size-end').value=v;
    document.getElementById('node-size-end-val').textContent=v;
  }
  n.size=v;
});
bR('node-size-end','node-size-end-val',null,v=>{const n=gN();if(n)n.sizeEnd=v;});
bR('node-rot','node-rot-val',v=>v+'°',v=>{const n=gN();if(n)n.rotation=v;});
bC('node-follow',v=>{const n=gN();if(n)n.follow=v;});
bR('node-count','node-count-val',v=>Math.round(v),v=>{const n=gN();if(n)n.count=Math.round(v);});
bR('node-offset','node-offset-val',pct,v=>{const n=gN();if(n)n.offset=v;});
bR('node-tilt','node-tilt-val',v=>v+'°',v=>{const n=gN();if(n)n.tilt3d=v;});
bSel('node-tilt-mode',v=>{const n=gN();if(n)n.tiltMode=v;});
bR('node-sx','node-sx-val',v=>Math.round(v)+'%',v=>{const n=gN();if(n)n.sx=v;});
bR('node-sy','node-sy-val',v=>Math.round(v)+'%',v=>{const n=gN();if(n)n.sy=v;});
bR('node-op-start','node-op-start-val',pct,v=>{const n=gN();if(n)n.opStart=v;});
bR('node-op-end','node-op-end-val',pct,v=>{const n=gN();if(n)n.opEnd=v;});
bR('node-jitter','node-jitter-val',null,v=>{const n=gN();if(n)n.jitter=v;});
bR('node-rot-jitter','node-rot-jitter-val',v=>v+'°',v=>{const n=gN();if(n)n.rotJitter=v;});
bR('node-size-jitter','node-size-jitter-val',null,v=>{const n=gN();if(n)n.sizeJitter=v;});
bR('node-linelen','node-linelen-val',null,v=>{const n=gN();if(n){n.lineLen=v;paper.view.draw();}});
bR('node-curvature','node-curvature-val',null,v=>{const n=gN();if(n){n.curvature=v;paper.view.draw();}});
bTxt('node-text',v=>{const n=gN();if(n)n.text=v;});
bSel('node-font',v=>{const n=gN();if(n)n.font=v;});
bTxt('node-char-array',v=>{const n=gN();if(n)n.charArray=v;});
bTxt('node-color-array',v=>{const n=gN();if(n)n.colorArray=v;});

// color palette presets
const COLOR_PALETTES = [
  { name:'mono', colors:['#1a1a1a','#555','#999','#ccc','#f5f2ee'] },
  { name:'warm', colors:['#c0392b','#e67e22','#f1c40f','#e8d5b7','#fff8f0'] },
  { name:'cool', colors:['#2c3e50','#2980b9','#1abc9c','#bdc3c7','#ecf0f1'] },
  { name:'riso', colors:['#ff6e4a','#ffda00','#00a95c','#0078bf','#ff48b0'] },
  { name:'earth', colors:['#3d2b1f','#7b4f2e','#c4956a','#e8d5b7','#f5efe6'] },
  { name:'neon', colors:['#ff00ff','#00ffff','#ffff00','#ff0080','#00ff80'] },
];
function buildPaletteUI() {
  const wrap = document.getElementById('node-color-array').parentNode;
  let palDiv = document.getElementById('color-palettes');
  if (!palDiv) {
    palDiv = document.createElement('div');
    palDiv.id = 'color-palettes';
    palDiv.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin-top:6px;';
    wrap.appendChild(palDiv);
  }
  palDiv.innerHTML = '';
  COLOR_PALETTES.forEach(p => {
    const btn = document.createElement('div');
    btn.title = p.name;
    btn.style.cssText = 'display:flex;border-radius:4px;overflow:hidden;cursor:pointer;border:1px solid rgba(0,0,0,0.1);';
    p.colors.forEach(c => {
      const s = document.createElement('span');
      s.style.cssText = `width:14px;height:14px;background:${c};display:block;`;
      btn.appendChild(s);
    });
    btn.addEventListener('click', () => {
      const n = gN(); if (!n) return;
      n.colorArray = p.colors.join(',');
      document.getElementById('node-color-array').value = n.colorArray;
      paper.view.draw();
    });
    palDiv.appendChild(btn);
  });
}
buildPaletteUI();

document.getElementById('node-parent').addEventListener('change', e => {
  const n = gN(); if (!n) return;
  const val = e.target.value;
  n.parentNi = val === '' ? null : parseInt(val);
  updatePanel(); paper.view.draw();
});

document.getElementById('node-image-btn').addEventListener('click',()=>document.getElementById('node-image-upload').click());
document.getElementById('node-image-upload').addEventListener('change',e=>{
  const n=gN();if(!n)return;
  const file=e.target.files[0];if(!file)return;
  const img=new Image();
  img.onload=()=>{n.imgEl=img;n.imgName=file.name;updatePanel();paper.view.draw();};
  img.src=URL.createObjectURL(file);
});

function _renderToArtboardCanvas(cb) {
  // temporarily resize both canvases to artboard size at zoom=1
  // so paths and nodes align perfectly at true artboard resolution
  const savedZoom = paper.view.zoom;
  const savedCenter = paper.view.center.clone();
  const savedW = _canvas.width, savedH = _canvas.height;
  const aw = artboard.w, ah = artboard.h;
  const acx = artboard.x + aw / 2, acy = artboard.y + ah / 2;

  _canvas.width = aw; _canvas.height = ah;
  _nodesCanvas.width = aw; _nodesCanvas.height = ah;
  paper.view.viewSize = new paper.Size(aw, ah);
  paper.view.zoom = 1;
  paper.view.center = new paper.Point(acx, acy);

  _isExporting = true;
  paper.view.draw();
  _isExporting = false;

  cb(_canvas, _nodesCanvas, aw, ah);

  // restore
  _canvas.width = savedW; _canvas.height = savedH;
  _nodesCanvas.width = savedW; _nodesCanvas.height = savedH;
  paper.view.viewSize = new paper.Size(savedW, savedH);
  paper.view.zoom = savedZoom;
  paper.view.center = savedCenter;
  paper.view.draw();
}

document.getElementById('btn-export-png').addEventListener('click', () => {
  _renderToArtboardCanvas((pc, nc, aw, ah) => {
    const out = document.createElement('canvas');
    out.width = aw; out.height = ah;
    const octx = out.getContext('2d');
    octx.fillStyle = 'white';
    octx.fillRect(0, 0, aw, ah);
    octx.drawImage(pc, 0, 0);
    octx.drawImage(nc, 0, 0);
    const a = document.createElement('a'); a.download = 'traceit.png';
    a.href = out.toDataURL('image/png'); a.click();
  });
});

document.getElementById('btn-export-svg').addEventListener('click', () => {
  _renderToArtboardCanvas((pc, nc, aw, ah) => {
    // Build SVG: Paper.js vector paths + nodes canvas as embedded raster
    const vb = `${artboard.x} ${artboard.y} ${aw} ${ah}`;

    // get Paper.js paths as SVG elements
    let pathSVG = '';
    paths.forEach(p => {
      if (!p.visible || !p.paperPath) return;
      const el = p.paperPath.exportSVG({ asString: true });
      pathSVG += el + '\n';
    });

    // composite paths + nodes onto a temp canvas for raster embed
    const tmp = document.createElement('canvas'); tmp.width = aw; tmp.height = ah;
    const tc = tmp.getContext('2d');
    tc.fillStyle = 'white'; tc.fillRect(0, 0, aw, ah);
    tc.drawImage(pc, 0, 0); tc.drawImage(nc, 0, 0);
    const imgData = tmp.toDataURL('image/png');

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" width="${aw}" height="${ah}">
<image href="${imgData}" x="${artboard.x}" y="${artboard.y}" width="${aw}" height="${ah}"/>
${pathSVG}</svg>`;
    const a = document.createElement('a'); a.download = 'traceit.svg';
    a.href = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); a.click();
  });
});

// ── Play / Pause ─────────────────────────────────────────────────────────────
document.getElementById('btn-play').addEventListener('click', () => {
  _playing = !_playing;
  document.getElementById('btn-play').textContent = _playing ? '⏹ stop' : '▶ play';
  document.getElementById('btn-play').classList.toggle('active', _playing);
  if (_playing) {
    _animLastTime = null;
    _animRaf = requestAnimationFrame(_tickAnim);
  } else {
    if (_animRaf) cancelAnimationFrame(_animRaf);
    paper.view.draw();
  }
});

// ── Loop button toggle (delegated) ───────────────────────────────────────────
document.getElementById('panel-body').addEventListener('click', e => {
  // path loop buttons
  const pathBtn = e.target.closest('.path-loop-btn');
  if (pathBtn) {
    if (!selected || selected.type !== 'path') return;
    const p = paths[selected.pi];
    const key = pathBtn.dataset.pathloop;
    p.loop = p.loop || {};
    p.loop[key] = !p.loop[key];
    pathBtn.classList.toggle('on', !!p.loop[key]);
    paper.view.draw();
    return;
  }
  // node loop buttons
  const btn = e.target.closest('.loop-btn');
  if (!btn) return;
  if (!selected || selected.type !== 'node') return;
  const n = paths[selected.pi].nodes[selected.ni];
  const key = btn.dataset.loop;
  n.loop = n.loop || {};
  n.loop[key] = !n.loop[key];
  btn.classList.toggle('on', !!n.loop[key]);
});

// ── GIF export ───────────────────────────────────────────────────────────────
document.getElementById('btn-export-gif').addEventListener('click', () => {
  const hasLoop = paths.some(p =>
    (p.loop && Object.values(p.loop).some(Boolean)) ||
    p.nodes.some(n => n.loop && Object.values(n.loop).some(Boolean)));
  if (!hasLoop) { alert('No loop parameters active. Enable ∿ on a slider first.'); return; }

  const btn = document.getElementById('btn-export-gif');
  btn.textContent = 'recording…'; btn.disabled = true;

  const frames = 24, delay = 42; // ~24fps, 1-second loop
  const savedT = _animT, savedPlaying = _playing;
  _playing = true;

  const { GIFEncoder, quantize, applyPalette } = gifenc;
  const encoder = GIFEncoder();

  // collect frames synchronously (offscreen render)
  for (let f = 0; f < frames; f++) {
    _animT = f / frames;
    _renderToArtboardCanvas((pc, nc, aw, ah) => {
      const tmp = document.createElement('canvas'); tmp.width = aw; tmp.height = ah;
      const tc = tmp.getContext('2d');
      tc.fillStyle = 'white'; tc.fillRect(0, 0, aw, ah);
      tc.drawImage(pc, 0, 0); tc.drawImage(nc, 0, 0);
      const imgd = tc.getImageData(0, 0, aw, ah);
      const palette = quantize(imgd.data, 256, { format: 'rgb565' });
      const index = applyPalette(imgd.data, palette);
      encoder.writeFrame(index, aw, ah, { palette, delay });
    });
  }
  encoder.finish();
  const buf = encoder.bytes();
  const blob = new Blob([buf], { type: 'image/gif' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.download = 'traceit.gif'; a.href = url; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);

  _animT = savedT; _playing = savedPlaying;
  btn.textContent = 'GIF'; btn.disabled = false;
  paper.view.draw();
});

// Feature 1: grid toggle
document.getElementById('btn-grid').addEventListener('click', () => {
  showGrid = !showGrid;
  document.getElementById('btn-grid').classList.toggle('active', showGrid);
  paper.view.draw();
});

// artboard
function applyArtboard(w, h) {
  artboard.w = w; artboard.h = h;
  artboard.x = -w / 2; artboard.y = -h / 2;
  updateArtboardBg();
  // fit view to artboard
  const pad = 60;
  const cw = _nodesCanvas.width, ch = _nodesCanvas.height;
  const zx = (cw - pad * 2) / w, zy = (ch - pad * 2) / h;
  paper.view.zoom = Math.min(zx, zy);
  paper.view.center = new paper.Point(artboard.x + w / 2, artboard.y + h / 2);
  document.getElementById('zoom-indicator').textContent = Math.round(paper.view.zoom * 100) + '%';
  paper.view.draw();
}

document.getElementById('btn-artboard').addEventListener('click', e => {
  const pop = document.getElementById('artboard-popover');
  const isOpen = pop.style.display === 'flex';
  pop.style.display = isOpen ? 'none' : 'flex';
  e.stopPropagation();
});
document.addEventListener('click', e => {
  const pop = document.getElementById('artboard-popover');
  if (!pop.contains(e.target) && e.target.id !== 'btn-artboard' && e.target.id !== 'chk-artboard') pop.style.display = 'none';
});
document.getElementById('chk-artboard').addEventListener('change', e => {
  showArtboard = e.target.checked;
  paper.view.draw();
});
document.getElementById('ab-apply').addEventListener('click', () => {
  const w = parseInt(document.getElementById('ab-w').value) || 800;
  const h = parseInt(document.getElementById('ab-h').value) || 600;
  applyArtboard(w, h);
  document.getElementById('artboard-popover').style.display = 'none';
});
document.querySelectorAll('.ab-preset').forEach(btn => {
  btn.addEventListener('click', () => {
    const w = parseInt(btn.dataset.w), h = parseInt(btn.dataset.h);
    document.getElementById('ab-w').value = w;
    document.getElementById('ab-h').value = h;
    applyArtboard(w, h);
    document.getElementById('artboard-popover').style.display = 'none';
  });
});

// Feature 2: path z-order via drag-to-reorder (handled in buildPathList)

setTimeout(() => {
  // init artboard centered at paper origin
  applyArtboard(800, 600);
  makePreset('circle');
  paths[0].nodes.push({
    name:'dots', style:'flat', type:'circle', fill:'#c8b8a2',
    strokeColor:'#1a1a1a', strokeWidth:0, size:10, sizeEnd:10,
    rotation:0, follow:false, count:24, offset:0,
    opStart:1, opEnd:1, jitter:0, rotJitter:0, sizeJitter:0,
    tilt3d:0, tiltMode:'perspective', sx:100, sy:100,
    noFill:false, noStroke:true, riso:false,
    charArray:'', colorArray:'', parentNi:null
  });
  selected={type:'path',pi:0};
  highlightSelected(); updatePanel(); paper.view.draw();
}, 50);

// SVG upload handler
document.getElementById('node-svg-btn').addEventListener('click', () => document.getElementById('node-svg-upload').click());
document.getElementById('node-svg-upload').addEventListener('change', e => {
  const n = gN(); if (!n) return;
  const file = e.target.files[0]; if (!file) return;
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    n.imgEl = img; n.svgName = file.name;
    updatePanel(); paper.view.draw();
  };
  img.src = url;
});

// dither: render shape to offscreen, apply ordered dither, composite back
function applyDither(ctx, x, y, size, fill, type, rot, scx, scy, opts) {
  opts = opts || {};
  const dotSize = opts.dotSize || 2;
  const threshold = opts.threshold || 0.5;
  const mode = opts.imgMode || opts.mode || 'bayer';
  const z = opts.zoom || 1;
  const pad = size * 1.2;
  let ow = Math.ceil((size * 2 * scx + pad * 2) * z);
  let oh = Math.ceil((size * 2 * scy + pad * 2) * z);
  // text type needs a wider canvas based on actual text measurement
  if (type === 'text' && opts.text) {
    const _mc = document.createElement('canvas'); _mc.width = 4; _mc.height = 4;
    const _mctx = _mc.getContext('2d');
    _mctx.font = `${size}px ${opts.font || 'sans-serif'}`;
    const _tw = _mctx.measureText(opts.text).width || size;
    ow = Math.ceil((_tw + pad * 2 + 8) * z);
    oh = Math.ceil((size * 1.4 + pad * 2 + 8) * z);
  }
  const off = document.createElement('canvas');
  off.width = ow; off.height = oh;
  const oc = off.getContext('2d');
  const cxo = ow / 2, cyo = oh / 2;
  oc.save();
  oc.translate(cxo, cyo); oc.scale(z, z); oc.rotate(rot); oc.scale(scx, scy);
  const _dNoFill = !!opts.noFill, _dNoStroke = !!opts.noStroke;
  const _dSw = opts.sw > 0 ? opts.sw : (opts.strokeWidth || 1.5);
  oc.fillStyle = '#000'; oc.strokeStyle = '#000'; oc.lineWidth = _dSw;
  if (type === 'circle') {
    oc.beginPath(); oc.arc(0,0,size/2,0,Math.PI*2);
    if (!_dNoFill) oc.fill();
    if (!_dNoStroke && opts.sw > 0) oc.stroke();
  } else if (type === 'rect') {
    oc.beginPath(); oc.rect(-size/2,-size/2,size,size);
    if (!_dNoFill) oc.fill();
    if (!_dNoStroke && opts.sw > 0) oc.stroke();
  } else if (type === 'triangle') {
    oc.beginPath(); oc.moveTo(0,-size/2); oc.lineTo(size/2,size/2); oc.lineTo(-size/2,size/2); oc.closePath();
    if (!_dNoFill) oc.fill();
    if (!_dNoStroke && opts.sw > 0) oc.stroke();
  } else if (type === 'line') {
    const ll = (opts.lineLen !== undefined ? opts.lineLen : 100) / 2;
    oc.lineWidth = opts.strokeWidth || 1.5;
    oc.beginPath(); oc.moveTo(-ll, 0); oc.lineTo(ll, 0); oc.stroke();
  } else if (type === 'arc') {
    const ll2 = (opts.lineLen !== undefined ? opts.lineLen : 100) / 2;
    const bend = ((opts.curvature !== undefined ? opts.curvature : 50) / 100) * ll2;
    oc.lineWidth = opts.strokeWidth || 1.5;
    oc.beginPath(); oc.moveTo(-ll2, 0); oc.quadraticCurveTo(0, -bend, ll2, 0); oc.stroke();
  } else if (type === 'curve') {
    const ll3 = (opts.lineLen !== undefined ? opts.lineLen : 100) / 2;
    const bend2 = ((opts.curvature !== undefined ? opts.curvature : 50) / 100) * ll3;
    oc.lineWidth = opts.strokeWidth || 1.5;
    oc.beginPath(); oc.moveTo(-ll3, 0); oc.bezierCurveTo(-ll3/2, -bend2, ll3/2, bend2, ll3, 0); oc.stroke();
  } else if (type === 'cross') {
    oc.lineWidth = opts.strokeWidth || 1.5;
    oc.beginPath(); oc.moveTo(-size/2,0); oc.lineTo(size/2,0); oc.moveTo(0,-size/2); oc.lineTo(0,size/2); oc.stroke();
  } else if (type === 'text' && opts.text) {
    oc.font = `${size}px ${opts.font || 'sans-serif'}`;
    oc.textAlign = 'center'; oc.textBaseline = 'middle';
    if (!_dNoFill) oc.fillText(opts.text, 0, 0);
    if (!_dNoStroke && _dSw > 0) { oc.lineWidth = _dSw; oc.strokeStyle = '#000'; oc.strokeText(opts.text, 0, 0); }
  }
  oc.restore();
  // feather: blur the shape before dithering to create soft scattered edge
  const feather = (opts.feather || 0) * z;
  if (feather > 0) {
    const blurred = document.createElement('canvas');
    blurred.width = ow; blurred.height = oh;
    const bc = blurred.getContext('2d');
    bc.filter = `blur(${feather}px)`;
    bc.drawImage(off, 0, 0);
    bc.filter = 'none';
    oc.clearRect(0, 0, ow, oh);
    oc.drawImage(blurred, 0, 0);
  }
  const imgd = oc.getImageData(0,0,ow,oh);
  const d = imgd.data;
  const [fr,fg,fb] = parseColor(fill);
  const _useFill = opts.colorize !== false;
  const _dotR = _useFill ? fr : 0, _dotG = _useFill ? fg : 0, _dotB = _useFill ? fb : 0;
  const out = oc.createImageData(ow, oh);
  const od = out.data;
  if (mode === 'floyd') {
    // Floyd-Steinberg error diffusion on alpha channel
    const af = new Float32Array(ow * oh);
    for (let i = 0; i < ow * oh; i++) af[i] = d[i*4+3] / 255;
    for (let py2 = 0; py2 < oh; py2++) {
      for (let px2 = 0; px2 < ow; px2++) {
        const i = py2*ow+px2;
        const oldV = af[i], newV = oldV > threshold ? 1 : 0, err = oldV - newV;
        af[i] = newV;
        if (newV > 0.5) { const idx=i*4; od[idx]=_dotR; od[idx+1]=_dotG; od[idx+2]=_dotB; od[idx+3]=255; }
        if (px2+1<ow) af[i+1] = Math.min(1,Math.max(0,af[i+1]+err*7/16));
        if (py2+1<oh&&px2>0) af[(py2+1)*ow+px2-1] = Math.min(1,Math.max(0,af[(py2+1)*ow+px2-1]+err*3/16));
        if (py2+1<oh) af[(py2+1)*ow+px2] = Math.min(1,Math.max(0,af[(py2+1)*ow+px2]+err*5/16));
        if (py2+1<oh&&px2+1<ow) af[(py2+1)*ow+px2+1] = Math.min(1,Math.max(0,af[(py2+1)*ow+px2+1]+err/16));
      }
    }
  } else {
    // Bayer 4x4 ordered dither
    const bayer = [[ 0,8,2,10],[12,4,14,6],[3,11,1,9],[15,7,13,5]];
    for (let py2 = 0; py2 < oh; py2++) {
      for (let px2 = 0; px2 < ow; px2++) {
        const idx = (py2 * ow + px2) * 4;
        const alpha = d[idx+3] / 255;
        const b = bayer[py2 % 4][px2 % 4] / 16;
        if (alpha > b * threshold + (1-threshold)) {
          od[idx]=_dotR; od[idx+1]=_dotG; od[idx+2]=_dotB; od[idx+3]=255;
        }
      }
    }
  }
  oc.putImageData(out, 0, 0);
  // scale up dots — render at 1/dotSize then scale up with no smoothing
  if (dotSize > 1) {
    const sw2 = Math.ceil(ow / dotSize), sh2 = Math.ceil(oh / dotSize);
    const small = document.createElement('canvas');
    small.width = sw2; small.height = sh2;
    const sc2 = small.getContext('2d');
    sc2.imageSmoothingEnabled = false;
    sc2.drawImage(off, 0, 0, ow, oh, 0, 0, sw2, sh2);
    const big = document.createElement('canvas');
    big.width = ow; big.height = oh;
    const bc = big.getContext('2d');
    bc.imageSmoothingEnabled = false;
    bc.drawImage(small, 0, 0, sw2, sh2, 0, 0, ow, oh);
    const m2 = ctx.getTransform();
    const sx2 = m2.a*(x - ow/2/z) + m2.c*(y - oh/2/z) + m2.e;
    const sy2 = m2.b*(x - ow/2/z) + m2.d*(y - oh/2/z) + m2.f;
    ctx.save(); ctx.resetTransform();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(big, sx2, sy2);
    ctx.imageSmoothingEnabled = true;
    ctx.restore();
  } else {
    const m2 = ctx.getTransform();
    const sx2 = m2.a*(x - ow/2/z) + m2.c*(y - oh/2/z) + m2.e;
    const sy2 = m2.b*(x - ow/2/z) + m2.d*(y - oh/2/z) + m2.f;
    ctx.save(); ctx.resetTransform();
    ctx.drawImage(off, sx2, sy2);
    ctx.restore();
  }
}

// riso params bindings
document.getElementById('node-riso').addEventListener('change', e => {
  const n = gN(); if (!n) return;
  n.riso = e.target.checked;
  document.getElementById('riso-params').style.display = n.riso ? 'block' : 'none';
  paper.view.draw();
});
bR('riso-bristle','riso-bristle-val',null,v=>{const n=gN();if(n)n.risoBristle=v;});
bR('riso-erosion','riso-erosion-val',null,v=>{const n=gN();if(n)n.risoErosion=v;});
bR('riso-spread','riso-spread-val',null,v=>{const n=gN();if(n)n.risoSpread=v;});
bR('riso-bridge','riso-bridge-val',null,v=>{const n=gN();if(n)n.risoBridge=v;});

// dither params bindings
document.getElementById('node-dither').addEventListener('change', e => {
  const n = gN(); if (!n) return;
  n.dither = e.target.checked;
  const dp = document.getElementById('dither-params');
  dp.style.display = n.dither ? 'block' : 'none';
  document.getElementById('dither-img-mode-row').style.display = n.dither ? 'block' : 'none';
  if (n.dither) document.getElementById('dither-img-mode').value = n.ditherImgMode || 'bayer';
  paper.view.draw();
});
bR('dither-dot','dither-dot-val',null,v=>{const n=gN();if(n)n.ditherDot=v;});
bR('dither-threshold','dither-threshold-val',null,v=>{const n=gN();if(n)n.ditherThreshold=v;});
bR('dither-feather','dither-feather-val',null,v=>{const n=gN();if(n)n.ditherFeather=v;});
document.getElementById('node-dither-colorize').addEventListener('change', e => {
  const n = gN(); if (!n) return;
  n.ditherColorize = e.target.checked;
  paper.view.draw();
});
document.getElementById('dither-img-mode').addEventListener('change', e => {
  const n = gN(); if (!n) return;
  n.ditherImgMode = e.target.value;
  paper.view.draw();
});

// sync riso/dither panel visibility in updatePanel
const _origUpdatePanel2 = updatePanel;
updatePanel = function() {
  _origUpdatePanel2();
  const n = gN();
  const rp = document.getElementById('riso-params');
  const dp = document.getElementById('dither-params');
  if (n) {
    rp.style.display = n.riso ? 'block' : 'none';
    dp.style.display = n.dither ? 'block' : 'none';
    document.getElementById('node-dither').checked = !!n.dither;
    if (n.riso) {
      document.getElementById('riso-bristle').value = n.risoBristle||1;
      document.getElementById('riso-bristle-val').textContent = n.risoBristle||1;
      document.getElementById('riso-erosion').value = n.risoErosion||1;
      document.getElementById('riso-erosion-val').textContent = n.risoErosion||1;
      document.getElementById('riso-spread').value = n.risoSpread||0.38;
      document.getElementById('riso-spread-val').textContent = n.risoSpread||0.38;
      document.getElementById('riso-bridge').value = n.risoBridge||1.4;
      document.getElementById('riso-bridge-val').textContent = n.risoBridge||1.4;
    }
    if (n.dither) {
      document.getElementById('dither-dot').value = n.ditherDot||2;
      document.getElementById('dither-dot-val').textContent = n.ditherDot||2;
      document.getElementById('dither-threshold').value = n.ditherThreshold||0.5;
      document.getElementById('dither-threshold-val').textContent = n.ditherThreshold||0.5;
      document.getElementById('dither-feather').value = n.ditherFeather||0;
      document.getElementById('dither-feather-val').textContent = n.ditherFeather||0;
      document.getElementById('dither-img-mode-row').style.display = 'block';
      document.getElementById('dither-img-mode').value = n.ditherImgMode || 'bayer';
      document.getElementById('node-dither-colorize-row').style.display = 'flex';
      document.getElementById('node-dither-colorize').checked = n.ditherColorize !== false;
    } else {
      document.getElementById('node-dither-colorize-row').style.display = 'none';
      document.getElementById('dither-img-mode-row').style.display = 'none';
    }
  } else {
    rp.style.display = 'none';
    dp.style.display = 'none';
  }
};

// dither scatter: random dots on top of riso shape
function applyDitherScatter(ctx, x, y, r, opts) {
  opts = opts || {};
  const dotSize = opts.dotSize || 2;
  const threshold = opts.threshold || 0.5;
  const count = Math.floor(Math.PI * r * r * (1 - threshold) * 0.15);
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2;
    const d = Math.random() * r;
    const px = x + Math.cos(a) * d;
    const py = y + Math.sin(a) * d;
    ctx.beginPath();
    ctx.arc(px, py, dotSize * (0.5 + Math.random() * 0.8), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// blend mode binding
bSel('node-blend', v => { const n = gN(); if (n) n.blendMode = v; });

// ── path list ─────────────────────────────────────────────────────────────
let _dragPi = null;
function buildPathList() {
  const pl = document.getElementById('path-list');
  const pc = document.getElementById('path-list-count');
  pl.innerHTML = '';
  pc.textContent = paths.length ? `${paths.length} path${paths.length>1?'s':''}` : '';
  paths.forEach((p, pi) => {
    const isSel = selected && selected.pi === pi;
    const div = document.createElement('div');
    div.className = 'path-item' + (isSel ? ' sel' : '') + (p.visible===false ? ' hidden' : '');
    div.draggable = true;
    div.dataset.pi = pi;
    const nodeCount = p.nodes.length;
    const label = `path ${pi+1}`;
    div.innerHTML = `
      <span class="path-drag-handle" title="drag to reorder" style="cursor:grab;margin-right:4px;opacity:0.4;user-select:none">⠿</span>
      <span class="path-eye" data-pi="${pi}" title="toggle visibility">${p.visible===false ? '○' : '●'}</span>
      <span class="path-lbl">${label}</span>
      <span class="path-meta">${nodeCount} layer${nodeCount!==1?'s':''}</span>
    `;
    div.addEventListener('click', (e) => {
      if (e.target.classList.contains('path-eye')) return;
      if (e.target.classList.contains('path-drag-handle')) return;
      selected = { type:'path', pi };
      highlightSelected(); updatePanel();
    });
    div.querySelector('.path-eye').addEventListener('click', (e) => {
      e.stopPropagation();
      p.visible = p.visible === false ? true : false;
      p.paperPath.visible = p.visible !== false;
      buildPathList(); paper.view.draw();
    });
    div.addEventListener('dragstart', (e) => {
      _dragPi = pi;
      e.dataTransfer.effectAllowed = 'move';
      div.style.opacity = '0.5';
    });
    div.addEventListener('dragend', () => {
      div.style.opacity = '';
      _dragPi = null;
      document.querySelectorAll('.path-item').forEach(el => el.classList.remove('drag-over'));
    });
    div.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      document.querySelectorAll('.path-item').forEach(el => el.classList.remove('drag-over'));
      div.classList.add('drag-over');
    });
    div.addEventListener('drop', (e) => {
      e.preventDefault();
      const fromPi = _dragPi;
      const toPi = pi;
      if (fromPi === null || fromPi === toPi) return;
      pushHistory();
      const moved = paths.splice(fromPi, 1)[0];
      paths.splice(toPi, 0, moved);
      if (selected && selected.type === 'path') {
        if (selected.pi === fromPi) selected.pi = toPi;
        else if (fromPi < toPi && selected.pi > fromPi && selected.pi <= toPi) selected.pi--;
        else if (fromPi > toPi && selected.pi >= toPi && selected.pi < fromPi) selected.pi++;
      }
      highlightSelected(); updatePanel(); paper.view.draw();
    });
    // Double-click path label to rename
    div.addEventListener('dblclick', (e) => {
      if (e.target.classList.contains('path-eye')) return;
      if (e.target.classList.contains('path-drag-handle')) return;
      e.stopPropagation();
      const lblEl = div.querySelector('.path-lbl');
      if (!lblEl) return;
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.value = p.name || label;
      inp.style.cssText = 'width:80px;font-size:inherit;padding:0 2px;';
      lblEl.replaceWith(inp);
      inp.focus(); inp.select();
      function saveName() {
        const v = inp.value.trim();
        if (v) p.name = v;
        buildPathList();
      }
      inp.addEventListener('blur', saveName);
      inp.addEventListener('keydown', (ke) => {
        if (ke.key === 'Enter') { inp.blur(); }
        if (ke.key === 'Escape') { p.name = p.name; buildPathList(); }
      });
    });
    pl.appendChild(div);
  });
}

// patch updatePanel to also rebuild path list
const _origUpdatePanelFinal = updatePanel;
updatePanel = function() {
  _origUpdatePanelFinal();
  buildPathList();
};

// also rebuild on path add/delete — patch paper.view.draw
const _origDraw2 = paper.view.draw.bind(paper.view);
paper.view.draw = function() {
  _origDraw2();
  buildPathList();
};

// fix: ensure image/svg upload rows show correctly on type change
(function() {
  const typeEl = document.getElementById('node-type');
  if (!typeEl) return;
  function syncUploadRows() {
    const n = (typeof gN === 'function') ? gN() : null;
    const t = n ? (n.type || 'circle') : (typeEl ? typeEl.value : 'circle');
    const imgRow = document.getElementById('node-image-row');
    const svgRow = document.getElementById('node-svg-row');
    if (imgRow) imgRow.style.display = t === 'image' ? 'block' : 'none';
    if (svgRow) svgRow.style.display = t === 'svg' ? 'block' : 'none';
    if (t === 'image' && n && n.imgEl) {
      const nm = document.getElementById('node-image-name');
      if (nm) nm.textContent = n.imgName || 'image loaded';
    }
    if (t === 'svg' && n && n.imgEl) {
      const nm = document.getElementById('node-svg-name');
      if (nm) nm.textContent = n.svgName || 'svg loaded';
    }
  }
  // patch updatePanel chain to call syncUploadRows
  const _prev = updatePanel;
  updatePanel = function() { _prev(); syncUploadRows(); };
  // also on type select change
  typeEl.addEventListener('change', () => setTimeout(syncUploadRows, 0));
})();

// image dither: bayer or floyd-steinberg
function applyImageDither(ctx, imgEl, w, h, opts) {
  opts = opts || {};
  const mode = opts.mode || 'bayer';
  const dotSize = Math.max(1, opts.dotSize || 1);
  const colorize = opts.colorize || false;
  const fill = opts.fill || '#1a1a1a';
  const ow = Math.max(1, Math.ceil(w / dotSize));
  const oh = Math.max(1, Math.ceil(h / dotSize));
  const off = document.createElement('canvas');
  off.width = ow; off.height = oh;
  const oc = off.getContext('2d');
  oc.drawImage(imgEl, 0, 0, ow, oh);
  const imgd = oc.getImageData(0, 0, ow, oh);
  const d = imgd.data;
  for (let i = 0; i < d.length; i += 4) {
    const g = d[i]*0.299 + d[i+1]*0.587 + d[i+2]*0.114;
    d[i] = d[i+1] = d[i+2] = g;
  }
  const [fr, fg, fb] = parseColor(fill);
  if (mode === 'floyd') {
    for (let py = 0; py < oh; py++) {
      for (let px = 0; px < ow; px++) {
        const ii = (py*ow+px)*4, oldV = d[ii], nw = oldV<128?0:255, err = oldV-nw;
        d[ii]=d[ii+1]=d[ii+2]=nw;
        if(px+1<ow){const j=(py*ow+px+1)*4;d[j]+=err*7/16;d[j+1]+=err*7/16;d[j+2]+=err*7/16;}
        if(py+1<oh&&px>0){const j=((py+1)*ow+px-1)*4;d[j]+=err*3/16;d[j+1]+=err*3/16;d[j+2]+=err*3/16;}
        if(py+1<oh){const j=((py+1)*ow+px)*4;d[j]+=err*5/16;d[j+1]+=err*5/16;d[j+2]+=err*5/16;}
        if(py+1<oh&&px+1<ow){const j=((py+1)*ow+px+1)*4;d[j]+=err/16;d[j+1]+=err/16;d[j+2]+=err/16;}
      }
    }
  } else {
    const bayer=[[0,8,2,10],[12,4,14,6],[3,11,1,9],[15,7,13,5]];
    for(let py=0;py<oh;py++) for(let px=0;px<ow;px++){
      const ii=(py*ow+px)*4, thr=(bayer[py%4][px%4]/16)*255;
      d[ii]=d[ii+1]=d[ii+2]=d[ii]>thr?255:0;
    }
  }
  if (colorize) {
    for(let i=0;i<d.length;i+=4){
      if(d[i]<128){d[i]=fr;d[i+1]=fg;d[i+2]=fb;d[i+3]=255;}else{d[i+3]=0;}
    }
  }
  oc.putImageData(imgd, 0, 0);
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(off, 0, 0, ow, oh, -w/2, -h/2, w, h);
  ctx.restore();
}
document.addEventListener('keydown', function(e){
  if((e.ctrlKey||e.metaKey) && e.key==='z'){ undo(); e.preventDefault(); }
});
var _propNode = document.getElementById('props-node');
if(_propNode) _propNode.addEventListener('dblclick', function(e){
  if(e.target && e.target.type==='range'){
    e.target.value = e.target.defaultValue;
    e.target.dispatchEvent(new Event('input', { bubbles: true }));
    paper.view.draw();
  }
});