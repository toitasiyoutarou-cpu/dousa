'use strict';

const $ = (id) => document.getElementById(id);
const els = {
  input: $('videoInput'), drop: $('dropZone'), fileInfo: $('fileInfo'), loadState: $('loadState'),
  workspace: $('workspace'), marking: $('markingSection'), results: $('resultsSection'), compare: $('compareSection'),
  video: $('video'), overlay: $('overlay'), processor: $('processor'), stage: $('stage'),
  playBtn: $('playBtn'), prevBtn: $('prevFrameBtn'), nextBtn: $('nextFrameBtn'), speed: $('speedSelect'),
  timeline: $('timeline'), currentTime: $('currentTime'), frameNo: $('frameNo'), duration: $('duration'),
  fps: $('fpsInput'), ballRadius: $('ballRadiusInput'), trackFrames: $('trackFramesInput'),
  setContact: $('setContactFrameBtn'), contactText: $('contactFrameText'), state: $('analysisState'),
  markHelp: $('markingHelp'), clearMarks: $('clearMarksBtn'), autoTrack: $('autoTrackBtn'), calculate: $('calculateBtn'),
  metrics: $('metrics'), contactDiagram: $('contactDiagram'), trajectoryChart: $('trajectoryChart'), quality: $('qualityBadge'),
  saveServe: $('saveServeBtn'), csv: $('downloadCsvBtn'), compareBody: $('compareBody'), clearCompare: $('clearCompareBtn')
};

const ctx = els.overlay.getContext('2d');
const pctx = els.processor.getContext('2d', { willReadFrequently: true });
const state = {
  objectUrl: null,
  file: null,
  contactTime: null,
  activeMode: null,
  marks: {},
  trajectory: [],
  trackingScores: [],
  result: null,
  loading: false,
  dragging: false
};

const COLORS = {
  ball: '#ffe44d', contact: '#ff4757', wristBefore: '#7bed9f', wristContact: '#2ed573',
  indexBase: '#70a1ff', pinkyBase: '#a29bfe'
};
const LABELS = {
  ball: 'ボール中心', contact: '接触点', wristBefore: '直前の手首', wristContact: '接触時の手首',
  indexBase: '人差し指付け根', pinkyBase: '小指付け根'
};

function setStatus(text, kind = 'ok') {
  els.state.textContent = text;
  els.state.className = 'status' + (kind === 'muted' ? ' muted' : '');
}

function fps() { return Math.max(1, Number(els.fps.value) || 30); }
function frameDuration() { return 1 / fps(); }
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function deg(rad) { return rad * 180 / Math.PI; }
function round(v, d = 1) { const p = 10 ** d; return Math.round(v * p) / p; }
function angleBetween(a, b) { return deg(Math.atan2(-(b.y - a.y), b.x - a.x)); }
function formatAngle(a) { return Number.isFinite(a) ? `${round(a)}°` : '未測定'; }

// Prevent the browser from navigating to a dropped local video anywhere on the page.
['dragenter', 'dragover', 'dragleave', 'drop'].forEach(type => {
  window.addEventListener(type, e => { e.preventDefault(); e.stopPropagation(); }, false);
});

els.drop.addEventListener('dragenter', () => els.drop.classList.add('dragover'));
els.drop.addEventListener('dragover', () => els.drop.classList.add('dragover'));
els.drop.addEventListener('dragleave', () => els.drop.classList.remove('dragover'));
els.drop.addEventListener('drop', (e) => {
  els.drop.classList.remove('dragover');
  const file = [...(e.dataTransfer?.files || [])].find(f => f.type.startsWith('video/') || /\.(mp4|mov|webm|m4v)$/i.test(f.name));
  if (!file) return showLoadError('動画ファイルが見つかりませんでした。MP4を選んでください。');
  loadVideoFile(file);
});
els.input.addEventListener('change', () => {
  const file = els.input.files?.[0];
  if (file) loadVideoFile(file);
});

function showLoadError(message) {
  els.loadState.textContent = '読込エラー';
  els.loadState.className = 'status';
  els.fileInfo.textContent = message;
  els.fileInfo.classList.remove('hidden');
}

async function loadVideoFile(file) {
  try {
    resetAnalysis();
    state.file = file;
    els.loadState.textContent = '読込中';
    els.loadState.className = 'status';
    els.fileInfo.textContent = `${file.name}（${(file.size / 1024 / 1024).toFixed(1)} MB）を読み込んでいます…`;
    els.fileInfo.classList.remove('hidden');

    if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
    state.objectUrl = URL.createObjectURL(file);
    els.video.pause();
    els.video.removeAttribute('src');
    els.video.load();
    const metadataReady = waitForVideoMetadata(els.video, 12000);
    els.video.src = state.objectUrl;
    els.video.load();

    await metadataReady;
    if (!Number.isFinite(els.video.duration) || els.video.duration <= 0) throw new Error('動画の長さを取得できませんでした');

    els.overlay.width = els.video.videoWidth;
    els.overlay.height = els.video.videoHeight;
    els.processor.width = els.video.videoWidth;
    els.processor.height = els.video.videoHeight;
    els.timeline.max = Math.max(1, Math.round(els.video.duration * 1000));
    els.timeline.value = 0;
    els.duration.textContent = `${els.video.duration.toFixed(3)}秒`;
    els.fileInfo.textContent = `${file.name}｜${els.video.videoWidth}×${els.video.videoHeight}｜${els.video.duration.toFixed(2)}秒｜${(file.size / 1024 / 1024).toFixed(1)} MB`;
    els.loadState.textContent = '読込完了';
    els.loadState.className = 'status';
    els.workspace.classList.remove('hidden');
    els.marking.classList.remove('hidden');
    els.video.currentTime = 0;
    await once(els.video, 'loadeddata', 12000).catch(() => {});
    updateTimeUI();
    drawOverlay();
    setStatus('動画を操作できます');
    setTimeout(() => els.workspace.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
  } catch (err) {
    console.error(err);
    showLoadError(`動画を開けませんでした：${err.message}。MP4（H.264）へ変換すると安定します。`);
  }
}


function waitForVideoMetadata(video, timeoutMs = 12000) {
  if (video.readyState >= 1 && Number.isFinite(video.duration)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let timer;
    const ok = () => { cleanup(); resolve(); };
    const fail = () => { cleanup(); reject(new Error('動画形式をブラウザが読み込めませんでした')); };
    const cleanup = () => {
      clearTimeout(timer);
      video.removeEventListener('loadedmetadata', ok);
      video.removeEventListener('error', fail);
    };
    video.addEventListener('loadedmetadata', ok, { once: true });
    video.addEventListener('error', fail, { once: true });
    timer = setTimeout(() => { cleanup(); reject(new Error('動画情報の読み込みがタイムアウトしました')); }, timeoutMs);
  });
}

function once(target, eventName, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let timer;
    const ok = (e) => { cleanup(); resolve(e); };
    const fail = () => { cleanup(); reject(new Error(`${eventName}を待っている間にエラーが発生しました`)); };
    const cleanup = () => {
      target.removeEventListener(eventName, ok);
      target.removeEventListener('error', fail);
      clearTimeout(timer);
    };
    target.addEventListener(eventName, ok, { once: true });
    target.addEventListener('error', fail, { once: true });
    timer = setTimeout(() => { cleanup(); reject(new Error(`${eventName}がタイムアウトしました`)); }, timeoutMs);
  });
}

function resetAnalysis() {
  state.contactTime = null; state.activeMode = null; state.marks = {}; state.trajectory = []; state.trackingScores = []; state.result = null;
  els.results.classList.add('hidden');
  els.contactText.textContent = '接触フレーム：未設定';
  els.autoTrack.disabled = true; els.calculate.disabled = true;
  document.querySelectorAll('.mark-btn').forEach(b => b.classList.remove('active'));
}

els.video.addEventListener('timeupdate', () => { updateTimeUI(); drawOverlay(); });
els.video.addEventListener('seeked', () => { updateTimeUI(); drawOverlay(); });
els.video.addEventListener('play', animateOverlay);
els.video.addEventListener('pause', () => { els.playBtn.textContent = '▶ 再生'; });
els.video.addEventListener('ended', () => { els.playBtn.textContent = '▶ 再生'; });

function animateOverlay() {
  if (els.video.paused || els.video.ended) return;
  updateTimeUI(); drawOverlay();
  requestAnimationFrame(animateOverlay);
}

els.playBtn.addEventListener('click', async () => {
  if (!els.video.src) return;
  if (els.video.paused) {
    try { await els.video.play(); els.playBtn.textContent = '⏸ 一時停止'; } catch (e) { showLoadError(`再生できません：${e.message}`); }
  } else { els.video.pause(); }
});
els.prevBtn.addEventListener('click', () => stepFrame(-1));
els.nextBtn.addEventListener('click', () => stepFrame(1));
els.speed.addEventListener('change', () => { els.video.playbackRate = Number(els.speed.value); });
els.timeline.addEventListener('input', () => {
  if (!els.video.duration) return;
  els.video.currentTime = clamp(Number(els.timeline.value) / 1000, 0, els.video.duration);
});

function stepFrame(dir) {
  if (!els.video.src) return;
  els.video.pause();
  els.video.currentTime = clamp(els.video.currentTime + dir * frameDuration(), 0, els.video.duration);
}

function updateTimeUI() {
  const t = els.video.currentTime || 0;
  els.currentTime.textContent = `${t.toFixed(3)}秒`;
  els.frameNo.textContent = `${Math.round(t * fps())}コマ`;
  els.timeline.value = Math.round(t * 1000);
}

els.setContact.addEventListener('click', () => {
  state.contactTime = els.video.currentTime;
  els.video.pause();
  els.contactText.textContent = `接触フレーム：${state.contactTime.toFixed(3)}秒（${Math.round(state.contactTime * fps())}コマ）`;
  setStatus('接触フレームを設定しました');
  drawOverlay();
});

document.querySelectorAll('.mark-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    const mode = btn.dataset.mode;
    if (mode === 'wristBefore' && state.contactTime != null) {
      await seekTo(clamp(state.contactTime - frameDuration(), 0, els.video.duration));
    } else if (state.contactTime != null) {
      await seekTo(state.contactTime);
    }
    state.activeMode = mode;
    document.querySelectorAll('.mark-btn').forEach(b => b.classList.toggle('active', b === btn));
    els.markHelp.textContent = `動画上の「${LABELS[mode]}」をクリックしてください。`;
  });
});

els.overlay.addEventListener('click', (e) => {
  if (!state.activeMode || !els.video.videoWidth) return;
  const rect = els.overlay.getBoundingClientRect();
  const x = (e.clientX - rect.left) * els.overlay.width / rect.width;
  const y = (e.clientY - rect.top) * els.overlay.height / rect.height;
  state.marks[state.activeMode] = { x, y, time: els.video.currentTime };
  const done = state.activeMode;
  state.activeMode = null;
  document.querySelectorAll('.mark-btn').forEach(b => b.classList.remove('active'));
  els.markHelp.textContent = `${LABELS[done]}を記録しました。必要な点を続けて指定してください。`;
  els.autoTrack.disabled = !state.marks.ball;
  updateCalculateEnabled();
  drawOverlay();
});

els.clearMarks.addEventListener('click', () => {
  state.marks = {}; state.trajectory = []; state.trackingScores = []; state.result = null;
  els.autoTrack.disabled = true; els.calculate.disabled = true; els.results.classList.add('hidden');
  els.markHelp.textContent = '点をリセットしました。ボール中心から指定してください。';
  drawOverlay();
});

function updateCalculateEnabled() {
  const required = ['ball', 'contact', 'wristBefore', 'wristContact', 'indexBase', 'pinkyBase'];
  els.calculate.disabled = !required.every(k => state.marks[k]) || state.trajectory.length < 4;
}

function drawOverlay() {
  ctx.clearRect(0, 0, els.overlay.width, els.overlay.height);
  if (!els.overlay.width) return;

  if (state.contactTime != null && Math.abs(els.video.currentTime - state.contactTime) < frameDuration() * 0.6) {
    ctx.fillStyle = '#ff475733'; ctx.fillRect(0, 0, els.overlay.width, 7);
    ctx.font = 'bold 20px sans-serif'; ctx.fillStyle = '#ff6b81'; ctx.fillText('接触フレーム', 16, 34);
  }

  for (const [key, p] of Object.entries(state.marks)) {
    drawPoint(p, COLORS[key] || '#fff', LABELS[key] || key);
  }
  if (state.marks.ball) {
    const r = Number(els.ballRadius.value) || 18;
    ctx.beginPath(); ctx.arc(state.marks.ball.x, state.marks.ball.y, r, 0, Math.PI * 2);
    ctx.strokeStyle = '#ffe44d'; ctx.lineWidth = 3; ctx.stroke();
  }
  if (state.trajectory.length > 1) {
    ctx.beginPath();
    state.trajectory.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
    ctx.strokeStyle = '#00e5ff'; ctx.lineWidth = 4; ctx.stroke();
    state.trajectory.forEach((p, i) => {
      if (i % 2 !== 0) return;
      ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, Math.PI * 2); ctx.fillStyle = '#00e5ff'; ctx.fill();
    });
  }
  drawVectors();
}

function drawPoint(p, color, label) {
  ctx.beginPath(); ctx.arc(p.x, p.y, 7, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
  ctx.lineWidth = 2; ctx.strokeStyle = '#10233d'; ctx.stroke();
  ctx.font = 'bold 15px sans-serif'; ctx.fillStyle = color; ctx.fillText(label, p.x + 10, p.y - 10);
}

function drawVectors() {
  const m = state.marks;
  if (m.wristBefore && m.wristContact) drawArrow(m.wristBefore, m.wristContact, '#2ed573', '手の進入');
  if (m.indexBase && m.pinkyBase) {
    ctx.beginPath(); ctx.moveTo(m.indexBase.x, m.indexBase.y); ctx.lineTo(m.pinkyBase.x, m.pinkyBase.y);
    ctx.strokeStyle = '#a29bfe'; ctx.lineWidth = 4; ctx.stroke();
  }
  if (state.trajectory.length >= 3) drawArrow(state.trajectory[0], state.trajectory[Math.min(3, state.trajectory.length - 1)], '#00e5ff', '打ち出し');
}

function drawArrow(a, b, color, label) {
  const ang = Math.atan2(b.y - a.y, b.x - a.x), head = 13;
  ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
  ctx.lineTo(b.x - head * Math.cos(ang - Math.PI / 6), b.y - head * Math.sin(ang - Math.PI / 6));
  ctx.moveTo(b.x, b.y); ctx.lineTo(b.x - head * Math.cos(ang + Math.PI / 6), b.y - head * Math.sin(ang + Math.PI / 6));
  ctx.strokeStyle = color; ctx.lineWidth = 4; ctx.stroke();
  ctx.font = 'bold 15px sans-serif'; ctx.fillStyle = color; ctx.fillText(label, (a.x + b.x) / 2 + 6, (a.y + b.y) / 2 - 7);
}

function seekTo(t) {
  return new Promise((resolve, reject) => {
    if (Math.abs(els.video.currentTime - t) < 0.0005) { resolve(); return; }
    const timer = setTimeout(() => { cleanup(); reject(new Error('動画のコマ移動がタイムアウトしました')); }, 5000);
    const done = () => { cleanup(); resolve(); };
    const cleanup = () => { clearTimeout(timer); els.video.removeEventListener('seeked', done); };
    els.video.addEventListener('seeked', done, { once: true });
    els.video.currentTime = clamp(t, 0, els.video.duration);
  });
}

els.autoTrack.addEventListener('click', async () => {
  if (!state.marks.ball || state.loading) return;
  state.loading = true;
  els.autoTrack.disabled = true; els.calculate.disabled = true;
  setStatus('ボールを追跡中…');
  try {
    els.video.pause();
    const startTime = state.contactTime ?? state.marks.ball.time ?? els.video.currentTime;
    const r = clamp(Number(els.ballRadius.value) || 18, 5, 80);
    const n = clamp(Number(els.trackFrames.value) || 18, 4, 60);
    await seekTo(startTime);
    drawVideoToProcessor();
    const template = extractTemplate(state.marks.ball.x, state.marks.ball.y, r);
    if (!template) throw new Error('ボールが画面端に近すぎます');

    const points = [{ x: state.marks.ball.x, y: state.marks.ball.y, time: startTime }];
    const scores = [0];
    let prev = points[0], velocity = { x: 0, y: 0 };

    for (let i = 1; i < n; i++) {
      const t = startTime + i * frameDuration();
      if (t >= els.video.duration) break;
      await seekTo(t);
      drawVideoToProcessor();
      const pred = { x: prev.x + velocity.x, y: prev.y + velocity.y };
      const found = findBestMatch(template, pred.x, pred.y, r, i < 2 ? 105 : 80);
      if (!found || found.score > 95) break;
      const p = { x: found.x, y: found.y, time: t };
      if (points.length > 1) {
        const last = points[points.length - 1];
        velocity = { x: 0.65 * velocity.x + 0.35 * (p.x - last.x), y: 0.65 * velocity.y + 0.35 * (p.y - last.y) };
      } else velocity = { x: p.x - prev.x, y: p.y - prev.y };
      points.push(p); scores.push(found.score); prev = p;
    }

    state.trajectory = points;
    state.trackingScores = scores;
    await seekTo(startTime);
    setStatus(`${points.length}コマ追跡しました`);
    els.markHelp.textContent = `${points.length}コマを自動追跡しました。水色の軌跡を確認し、問題なければ結果を計算してください。`;
    updateCalculateEnabled();
    drawOverlay();
  } catch (err) {
    console.error(err);
    setStatus('追跡に失敗', 'muted');
    els.markHelp.textContent = `自動追跡できませんでした：${err.message}。ボール半径を調整して再実行してください。`;
  } finally {
    state.loading = false;
    els.autoTrack.disabled = !state.marks.ball;
  }
});

function drawVideoToProcessor() {
  pctx.drawImage(els.video, 0, 0, els.processor.width, els.processor.height);
}

function extractTemplate(cx, cy, r) {
  const x = Math.round(cx - r), y = Math.round(cy - r), s = r * 2 + 1;
  if (x < 0 || y < 0 || x + s >= els.processor.width || y + s >= els.processor.height) return null;
  const data = pctx.getImageData(x, y, s, s);
  return { data, r, s };
}

function findBestMatch(template, cx, cy, r, searchRadius) {
  const W = els.processor.width, H = els.processor.height;
  const x0 = Math.max(r, Math.round(cx - searchRadius));
  const x1 = Math.min(W - r - 1, Math.round(cx + searchRadius));
  const y0 = Math.max(r, Math.round(cy - searchRadius));
  const y1 = Math.min(H - r - 1, Math.round(cy + searchRadius));
  if (x1 <= x0 || y1 <= y0) return null;

  const region = pctx.getImageData(x0 - r, y0 - r, (x1 - x0) + 2 * r + 1, (y1 - y0) + 2 * r + 1);
  const rd = region.data, rw = region.width, td = template.data.data, s = template.s;
  let best = null;
  const candidateStep = 3;
  const sampleStep = Math.max(2, Math.round(r / 6));

  for (let y = y0; y <= y1; y += candidateStep) {
    for (let x = x0; x <= x1; x += candidateStep) {
      let sum = 0, count = 0;
      for (let py = -r; py <= r; py += sampleStep) {
        for (let px = -r; px <= r; px += sampleStep) {
          if (px * px + py * py > r * r) continue;
          const ti = ((py + r) * s + (px + r)) * 4;
          const ri = ((y + py - (y0 - r)) * rw + (x + px - (x0 - r))) * 4;
          const dr = td[ti] - rd[ri], dg = td[ti + 1] - rd[ri + 1], db = td[ti + 2] - rd[ri + 2];
          sum += Math.sqrt(dr * dr + dg * dg + db * db) / 4.42;
          count++;
        }
      }
      const score = sum / Math.max(1, count);
      const distancePenalty = Math.hypot(x - cx, y - cy) * 0.06;
      const total = score + distancePenalty;
      if (!best || total < best.total) best = { x, y, score, total };
    }
  }
  return best;
}

els.calculate.addEventListener('click', calculateResults);
function calculateResults() {
  try {
    const m = state.marks;
    const handApproach = angleBetween(m.wristBefore, m.wristContact);
    const palmAngle = angleBetween(m.indexBase, m.pinkyBase);
    const r = Number(els.ballRadius.value) || 18;
    const offsetX = (m.contact.x - m.ball.x) / r * 100;
    const offsetY = (m.ball.y - m.contact.y) / r * 100;
    const contactLabel = classifyContact(offsetX, offsetY);

    const tr = state.trajectory;
    const firstN = tr.slice(0, Math.min(5, tr.length));
    const fx = linearRegression(firstN.map(p => [p.time, p.x]));
    const fy = linearRegression(firstN.map(p => [p.time, p.y]));
    const launchAngle = deg(Math.atan2(-fy.slope, fx.slope));
    const last = tr[tr.length - 1];
    const predX = fx.intercept + fx.slope * last.time;
    const predY = fy.intercept + fy.slope * last.time;
    const lateralPct = (last.x - predX) / els.video.videoWidth * 100;
    const dropPct = (last.y - predY) / els.video.videoHeight * 100;
    const speedPx = Math.hypot(fx.slope, fy.slope);
    const avgScore = state.trackingScores.length > 1 ? state.trackingScores.slice(1).reduce((a,b)=>a+b,0)/(state.trackingScores.length-1) : 999;
    const quality = tr.length >= 12 && avgScore < 45 ? '高' : tr.length >= 7 && avgScore < 75 ? '中' : '低';

    state.result = { handApproach, palmAngle, offsetX, offsetY, contactLabel, launchAngle, lateralPct, dropPct, speedPx, quality, frames: tr.length };
    renderMetrics(state.result);
    drawContactDiagram(state.result);
    drawTrajectoryChart(state.result);
    els.quality.textContent = `追跡信頼度：${quality}`;
    els.results.classList.remove('hidden');
    els.results.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    console.error(err);
    els.markHelp.textContent = `計算できませんでした：${err.message}`;
  }
}

function linearRegression(points) {
  const n = points.length;
  const sx = points.reduce((a,p)=>a+p[0],0), sy = points.reduce((a,p)=>a+p[1],0);
  const sxx = points.reduce((a,p)=>a+p[0]*p[0],0), sxy = points.reduce((a,p)=>a+p[0]*p[1],0);
  const den = n*sxx - sx*sx;
  const slope = Math.abs(den) < 1e-9 ? 0 : (n*sxy - sx*sy)/den;
  return { slope, intercept: (sy - slope*sx)/n };
}

function classifyContact(x, y) {
  const h = x < -18 ? '左' : x > 18 ? '右' : '中央';
  const v = y > 18 ? '上' : y < -18 ? '下' : '中央';
  return h === '中央' && v === '中央' ? '中央' : `${h}${v === '中央' ? '' : v}`;
}

function renderMetrics(r) {
  const items = [
    ['手の進入角', formatAngle(r.handApproach)], ['手のひら角', formatAngle(r.palmAngle)],
    ['接触位置', r.contactLabel], ['打ち出し角', formatAngle(r.launchAngle)],
    ['左右変化', `${r.lateralPct >= 0 ? '右へ ' : '左へ '}${Math.abs(round(r.lateralPct,2))}%`],
    ['落下傾向', `${r.dropPct >= 0 ? '下へ ' : '上へ '}${Math.abs(round(r.dropPct,2))}%`],
    ['初期速度', `${round(r.speedPx)} px/s`], ['追跡コマ数', `${r.frames}コマ`]
  ];
  els.metrics.innerHTML = items.map(([k,v]) => `<div class="metric"><span>${k}</span><strong>${v}</strong></div>`).join('');
}

function drawContactDiagram(r) {
  const c = els.contactDiagram, g = c.getContext('2d');
  g.clearRect(0,0,c.width,c.height); g.fillStyle='#fbfdff'; g.fillRect(0,0,c.width,c.height);
  const cx=240, cy=160, R=95;
  g.beginPath(); g.arc(cx,cy,R,0,Math.PI*2); g.fillStyle='#ffe44d'; g.fill(); g.strokeStyle='#10233d'; g.lineWidth=3; g.stroke();
  g.beginPath(); g.moveTo(cx-R,cy); g.lineTo(cx+R,cy); g.moveTo(cx,cy-R); g.lineTo(cx,cy+R); g.strokeStyle='#10233d44'; g.lineWidth=1; g.stroke();
  const px=cx+clamp(r.offsetX/100,-1.2,1.2)*R, py=cy-clamp(r.offsetY/100,-1.2,1.2)*R;
  g.beginPath(); g.arc(px,py,10,0,Math.PI*2); g.fillStyle='#ff4757'; g.fill(); g.strokeStyle='#fff'; g.lineWidth=3; g.stroke();
  g.font='bold 18px sans-serif'; g.fillStyle='#10233d'; g.fillText(`接触：${r.contactLabel}`,20,30);
  g.font='15px sans-serif'; g.fillText(`横 ${round(r.offsetX)}% / 縦 ${round(r.offsetY)}%`,20,55);
}

function drawTrajectoryChart() {
  const c=els.trajectoryChart,g=c.getContext('2d'),pts=state.trajectory;
  g.clearRect(0,0,c.width,c.height); g.fillStyle='#fbfdff'; g.fillRect(0,0,c.width,c.height);
  if(pts.length<2)return;
  const minX=Math.min(...pts.map(p=>p.x)),maxX=Math.max(...pts.map(p=>p.x));
  const minY=Math.min(...pts.map(p=>p.y)),maxY=Math.max(...pts.map(p=>p.y));
  const pad=40, sx=(c.width-pad*2)/Math.max(1,maxX-minX), sy=(c.height-pad*2)/Math.max(1,maxY-minY), scale=Math.min(sx,sy);
  const map=p=>({x:pad+(p.x-minX)*scale,y:pad+(p.y-minY)*scale});
  g.beginPath();pts.forEach((p,i)=>{const q=map(p);i?g.lineTo(q.x,q.y):g.moveTo(q.x,q.y)});g.strokeStyle='#2463eb';g.lineWidth=4;g.stroke();
  pts.forEach((p,i)=>{const q=map(p);g.beginPath();g.arc(q.x,q.y,i===0?7:4,0,Math.PI*2);g.fillStyle=i===0?'#ff4757':'#00a8c6';g.fill()});
  g.font='14px sans-serif';g.fillStyle='#10233d';g.fillText('赤：接触直後　青：追跡軌道',18,24);
}

els.saveServe.addEventListener('click', () => {
  if (!state.result) return;
  const list = getComparison();
  list.push({ ...state.result, savedAt: new Date().toISOString() });
  localStorage.setItem('volleyMotionComparisonV1', JSON.stringify(list));
  renderComparison();
  els.compare.classList.remove('hidden');
  els.compare.scrollIntoView({ behavior:'smooth', block:'start' });
});
els.clearCompare.addEventListener('click', () => { localStorage.removeItem('volleyMotionComparisonV1'); renderComparison(); });
function getComparison(){try{return JSON.parse(localStorage.getItem('volleyMotionComparisonV1')||'[]')}catch{return[]}}
function renderComparison(){
  const list=getComparison(); els.compare.classList.toggle('hidden',list.length===0);
  els.compareBody.innerHTML=list.map((r,i)=>`<tr><td>${i+1}</td><td>${round(r.handApproach)}°</td><td>${round(r.palmAngle)}°</td><td>${r.contactLabel}</td><td>${round(r.launchAngle)}°</td><td>${r.lateralPct>=0?'右':'左'} ${Math.abs(round(r.lateralPct,2))}%</td><td>${r.dropPct>=0?'下':'上'} ${Math.abs(round(r.dropPct,2))}%</td></tr>`).join('');
}

els.csv.addEventListener('click', () => {
  if (!state.result) return;
  const r=state.result;
  const rows=[['項目','値'],['手の進入角',r.handApproach],['手のひら角',r.palmAngle],['接触位置',r.contactLabel],['接触横ずれ%',r.offsetX],['接触縦ずれ%',r.offsetY],['打ち出し角',r.launchAngle],['左右変化%',r.lateralPct],['落下傾向%',r.dropPct],['初期速度px/s',r.speedPx],['追跡信頼度',r.quality],[],['time_s','x_px','y_px'],...state.trajectory.map(p=>[p.time,p.x,p.y])];
  const csv='\uFEFF'+rows.map(row=>row.map(v=>`"${String(v??'').replaceAll('"','""')}"`).join(',')).join('\r\n');
  const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));a.download=`volley_motion_${Date.now()}.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);
});

renderComparison();
window.addEventListener('beforeunload',()=>{if(state.objectUrl)URL.revokeObjectURL(state.objectUrl)});
