const $ = id => document.getElementById(id);
const video = $('video');
const overlay = $('overlay');
const octx = overlay.getContext('2d');
const work = $('workCanvas');
const wctx = work.getContext('2d', { willReadFrequently: true });

const state = {
  mode: 'init',
  points: [], // {t, frame, x, y, confidence, type, auto}
  marks: [], // center/scale/init markers {type,x,y,t}
  startTime: 0,
  endTime: 0,
  initPoint: null,
  initColor: null,
  tracking: false,
  videoNatural: {w:0,h:0},
  renderRect: {x:0,y:0,w:0,h:0},
  scalePx: null,
  centerLine: null,
  log: []
};

function log(msg){
  const time = new Date().toLocaleTimeString('ja-JP', {hour12:false});
  state.log.unshift(`[${time}] ${msg}`);
  state.log = state.log.slice(0, 80);
  $('logBox').textContent = state.log.join('\n');
}

function fps(){ return parseFloat($('fps').value) || 30; }
function frameStep(){ return 1 / fps(); }
function frameNo(t){ return Math.round(t * fps()); }

$('videoInput').addEventListener('change', e => {
  const file = e.target.files[0];
  if(!file) return;
  video.src = URL.createObjectURL(file);
  state.points = [];
  state.marks = [];
  state.initPoint = null;
  state.initColor = null;
  state.startTime = 0;
  state.endTime = 0;
  log(`動画を読み込みました: ${file.name}`);
  recalcAll();
});

video.addEventListener('loadedmetadata', () => {
  state.videoNatural.w = video.videoWidth;
  state.videoNatural.h = video.videoHeight;
  state.endTime = video.duration || 0;
  $('rangeNow').textContent = `${state.startTime.toFixed(2)}s - ${state.endTime.toFixed(2)}s`;
  resizeOverlay();
  log(`動画情報: ${video.videoWidth}x${video.videoHeight}, ${video.duration.toFixed(2)}s`);
});
video.addEventListener('timeupdate', () => { updateTime(); drawOverlay(); });
video.addEventListener('seeked', () => { updateTime(); drawOverlay(); });
window.addEventListener('resize', resizeOverlay);

function resizeOverlay(){
  const r = overlay.getBoundingClientRect();
  overlay.width = r.width * devicePixelRatio;
  overlay.height = r.height * devicePixelRatio;
  octx.setTransform(devicePixelRatio,0,0,devicePixelRatio,0,0);
  computeRenderRect();
  drawOverlay();
  drawCharts();
}

function computeRenderRect(){
  const cw = overlay.clientWidth, ch = overlay.clientHeight;
  const vw = video.videoWidth || 16, vh = video.videoHeight || 9;
  const scale = Math.min(cw / vw, ch / vh);
  const w = vw * scale, h = vh * scale;
  state.renderRect = {x:(cw-w)/2, y:(ch-h)/2, w, h};
}

function canvasToVideo(x,y){
  const r = state.renderRect;
  return {
    x: (x - r.x) * (video.videoWidth / r.w),
    y: (y - r.y) * (video.videoHeight / r.h)
  };
}
function videoToCanvas(x,y){
  const r = state.renderRect;
  return {
    x: r.x + x * (r.w / video.videoWidth),
    y: r.y + y * (r.h / video.videoHeight)
  };
}

$('playPause').onclick = () => video.paused ? video.play() : video.pause();
$('backFrame').onclick = () => seekTo(Math.max(0, video.currentTime - frameStep()));
$('forwardFrame').onclick = () => seekTo(Math.min(video.duration || Infinity, video.currentTime + frameStep()));
$('setStartBtn').onclick = () => { state.startTime = video.currentTime; updateRange(); log(`開始時刻を設定: ${state.startTime.toFixed(2)}s`); };
$('setEndBtn').onclick = () => { state.endTime = video.currentTime; updateRange(); log(`終了時刻を設定: ${state.endTime.toFixed(2)}s`); };
$('goStartBtn').onclick = () => seekTo(state.startTime);

function seekTo(t){ video.currentTime = t; updateTime(); }
function updateTime(){ $('timeNow').textContent = `${video.currentTime.toFixed(2)}s`; }
function updateRange(){ $('rangeNow').textContent = `${state.startTime.toFixed(2)}s - ${state.endTime.toFixed(2)}s`; }

$('autoTrackBtn').onclick = autoTrack;
$('stopTrackBtn').onclick = () => { state.tracking = false; log('追跡停止'); };
$('clearTrackBtn').onclick = () => { if(confirm('追跡点を消しますか？')){ state.points=[]; recalcAll(); log('追跡点をクリアしました'); } };
$('sampleColorBtn').onclick = () => {
  if(!state.initPoint){ alert('先に初期ボールをクリックしてください。'); return; }
  captureFrame(video.currentTime);
  state.initColor = sampleColor(state.initPoint.x, state.initPoint.y, 4);
  log(`初期色を再取得: rgb(${state.initColor.r},${state.initColor.g},${state.initColor.b})`);
};

Array.from(document.querySelectorAll('[data-mode]')).forEach(btn => {
  btn.onclick = () => {
    state.mode = btn.dataset.mode;
    document.querySelectorAll('[data-mode]').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    $('modeNow').textContent = btn.textContent;
  };
});

['fps','scaleMeters','rotationFrames','searchRadius','colorTolerance','minArea','detectMode'].forEach(id => $(id).addEventListener('input', recalcAll));

overlay.addEventListener('click', e => {
  if(!video.videoWidth) return;
  const rect = overlay.getBoundingClientRect();
  const cx = e.clientX - rect.left;
  const cy = e.clientY - rect.top;
  const p = canvasToVideo(cx, cy);
  if(p.x < 0 || p.y < 0 || p.x > video.videoWidth || p.y > video.videoHeight) return;

  if(state.mode === 'init'){
    state.initPoint = {x:p.x, y:p.y, t:video.currentTime, frame:frameNo(video.currentTime)};
    state.marks = state.marks.filter(m => m.type !== 'init');
    state.marks.push({type:'init', x:p.x, y:p.y, t:video.currentTime});
    captureFrame(video.currentTime);
    state.initColor = sampleColor(p.x, p.y, 4);
    upsertTrackPoint({t:video.currentTime, frame:frameNo(video.currentTime), x:p.x, y:p.y, confidence:1, type:'init', auto:false});
    state.startTime = video.currentTime;
    updateRange();
    log(`初期ボール設定: (${p.x.toFixed(1)}, ${p.y.toFixed(1)})`);
  } else if(state.mode === 'center'){
    let cs = state.marks.filter(m => m.type === 'center');
    if(cs.length >= 2) state.marks = state.marks.filter(m => m.type !== 'center');
    state.marks.push({type:'center', x:p.x, y:p.y, t:video.currentTime});
    log('中心線の点を記録');
  } else if(state.mode === 'scale'){
    let ss = state.marks.filter(m => m.type === 'scale');
    if(ss.length >= 2) state.marks = state.marks.filter(m => m.type !== 'scale');
    state.marks.push({type:'scale', x:p.x, y:p.y, t:video.currentTime});
    log('基準線の点を記録');
  } else if(state.mode === 'correct'){
    upsertTrackPoint({t:video.currentTime, frame:frameNo(video.currentTime), x:p.x, y:p.y, confidence:1, type:'manual', auto:false});
    log(`補正点を記録: ${video.currentTime.toFixed(3)}s`);
  } else if(state.mode === 'delete'){
    const idx = nearestPointIndex(p.x, p.y, video.currentTime);
    if(idx >= 0){ state.points.splice(idx,1); log('近い追跡点を削除'); }
  }
  recalcAll();
});

function nearestPointIndex(x,y,t){
  let best = -1, bestScore = Infinity;
  state.points.forEach((p,i)=>{
    const d = Math.hypot(p.x-x, p.y-y) + Math.abs(p.t-t)*50;
    if(d < bestScore){ bestScore=d; best=i; }
  });
  return best;
}

function upsertTrackPoint(pt){
  const existing = state.points.findIndex(p => Math.abs(p.t - pt.t) < frameStep()*0.6);
  if(existing >= 0) state.points[existing] = {...state.points[existing], ...pt};
  else state.points.push(pt);
  state.points.sort((a,b)=>a.t-b.t);
}

function captureFrame(t){
  if(!video.videoWidth) return null;
  work.width = video.videoWidth;
  work.height = video.videoHeight;
  wctx.drawImage(video, 0, 0, work.width, work.height);
  return wctx.getImageData(0,0,work.width,work.height);
}

function sampleColor(x,y,radius=3){
  const img = wctx.getImageData(Math.max(0,Math.floor(x-radius)), Math.max(0,Math.floor(y-radius)), radius*2+1, radius*2+1).data;
  let rr=0,gg=0,bb=0,n=0;
  for(let i=0;i<img.length;i+=4){ rr+=img[i]; gg+=img[i+1]; bb+=img[i+2]; n++; }
  return {r:Math.round(rr/n), g:Math.round(gg/n), b:Math.round(bb/n)};
}

async function autoTrack(){
  if(!video.src){ alert('動画を読み込んでください。'); return; }
  if(!state.initPoint){ alert('まず「初期ボールをクリック」でボールを1回クリックしてください。'); return; }
  if(!state.initColor){ captureFrame(state.initPoint.t); state.initColor = sampleColor(state.initPoint.x, state.initPoint.y, 4); }
  state.tracking = true;
  video.pause();
  const skip = parseInt($('frameSkip').value,10) || 1;
  const dt = frameStep() * skip;
  const end = Math.max(state.endTime || video.duration || 0, state.startTime);
  let t = state.startTime;
  let prev = nearestTrackBefore(t) || state.initPoint;
  log(`自動追跡開始: ${state.startTime.toFixed(2)}s - ${end.toFixed(2)}s / ${skip}フレームごと`);

  let count = 0, fail = 0;
  while(state.tracking && t <= end + 1e-6){
    await seekAndWait(t);
    captureFrame(t);
    const found = detectBall(prev);
    if(found){
      const pt = {t, frame:frameNo(t), x:found.x, y:found.y, confidence:found.confidence, type:'auto', auto:true};
      upsertTrackPoint(pt);
      prev = pt;
      count++;
    }else{
      fail++;
      prev = {...prev, x:prev.x, y:prev.y};
      log(`検出失敗: ${t.toFixed(3)}s`);
    }
    if(count % 5 === 0){ recalcAll(false); await sleep(0); }
    t += dt;
  }
  state.tracking = false;
  recalcAll();
  log(`自動追跡終了: 成功 ${count} 点 / 失敗 ${fail} 回`);
}

function nearestTrackBefore(t){
  const pts = state.points.filter(p => p.t <= t).sort((a,b)=>b.t-a.t);
  return pts[0] || null;
}
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }
function seekAndWait(t){
  return new Promise(resolve => {
    const done = () => { video.removeEventListener('seeked', done); setTimeout(resolve, 20); };
    video.addEventListener('seeked', done, {once:true});
    video.currentTime = Math.min(Math.max(t,0), video.duration || t);
  });
}

function detectBall(prev){
  const img = wctx.getImageData(0,0,work.width,work.height);
  const data = img.data;
  const radius = parseInt($('searchRadius').value,10) || 70;
  const tol = parseInt($('colorTolerance').value,10) || 80;
  const minArea = parseInt($('minArea').value,10) || 8;
  const mode = $('detectMode').value;
  const base = state.initColor || {r:240,g:240,b:240};
  const x0 = Math.max(0, Math.floor(prev.x - radius));
  const x1 = Math.min(work.width-1, Math.floor(prev.x + radius));
  const y0 = Math.max(0, Math.floor(prev.y - radius));
  const y1 = Math.min(work.height-1, Math.floor(prev.y + radius));

  const candidates = [];
  const step = 2;
  for(let y=y0; y<=y1; y+=step){
    for(let x=x0; x<=x1; x+=step){
      const dx = x - prev.x, dy = y - prev.y;
      if(dx*dx + dy*dy > radius*radius) continue;
      const idx = (y*work.width + x)*4;
      const r=data[idx], g=data[idx+1], b=data[idx+2];
      const brightness = (r+g+b)/3;
      const colorDist = Math.sqrt((r-base.r)**2 + (g-base.g)**2 + (b-base.b)**2);
      const whiteness = Math.max(r,g,b) - Math.min(r,g,b);
      let ok = false;
      let score = 0;
      if(mode === 'color'){
        ok = colorDist < tol;
        score = colorDist + Math.hypot(dx,dy)*0.35;
      }else if(mode === 'bright'){
        ok = brightness > 165 && whiteness < 95;
        score = (255-brightness) + whiteness*0.5 + Math.hypot(dx,dy)*0.35;
      }else{
        ok = (colorDist < tol*1.15) || (brightness > 170 && whiteness < 105);
        score = Math.min(colorDist, 255-brightness + whiteness) + Math.hypot(dx,dy)*0.35;
      }
      if(ok) candidates.push({x,y,score,brightness,colorDist});
    }
  }
  if(candidates.length < minArea) return null;

  // clustering: choose dense group near the best-scoring candidate
  candidates.sort((a,b)=>a.score-b.score);
  let bestCluster = null;
  const clusterRadius = 14;
  const seeds = candidates.slice(0, Math.min(40,candidates.length));
  for(const seed of seeds){
    let sx=0, sy=0, weight=0, n=0, totalScore=0;
    for(const c of candidates){
      const d = Math.hypot(c.x-seed.x, c.y-seed.y);
      if(d <= clusterRadius){
        const wt = 1 / (1 + c.score);
        sx += c.x * wt; sy += c.y * wt; weight += wt; n++; totalScore += c.score;
      }
    }
    if(n >= minArea){
      const cx = sx / weight, cy = sy / weight;
      const distancePenalty = Math.hypot(cx-prev.x, cy-prev.y) * 0.15;
      const score = totalScore/n - n*0.6 + distancePenalty;
      if(!bestCluster || score < bestCluster.score){ bestCluster = {x:cx,y:cy,n,score}; }
    }
  }
  if(!bestCluster) return null;
  const confidence = Math.max(0.05, Math.min(1, bestCluster.n / 60));
  return {x:bestCluster.x, y:bestCluster.y, confidence};
}

function recalcAll(redraw=true){
  recalcScaleCenter();
  renderSummary();
  renderTable();
  if(redraw){ drawOverlay(); drawCharts(); }
}

function recalcScaleCenter(){
  const ss = state.marks.filter(m=>m.type==='scale');
  state.scalePx = ss.length === 2 ? dist(ss[0],ss[1]) : null;
  const cs = state.marks.filter(m=>m.type==='center');
  state.centerLine = cs.length === 2 ? [cs[0],cs[1]] : null;
}
function dist(a,b){ return Math.hypot(a.x-b.x, a.y-b.y); }
function mPerPx(){ return state.scalePx ? (parseFloat($('scaleMeters').value)||0)/state.scalePx : null; }
function deviationFromCenter(p){
  if(!state.centerLine) return null;
  const [a,b] = state.centerLine;
  const dx=b.x-a.x, dy=b.y-a.y;
  const len=Math.hypot(dx,dy);
  if(!len) return null;
  const signed=((p.x-a.x)*dy - (p.y-a.y)*dx)/len;
  const scale=mPerPx();
  return {px:signed, m:scale?signed*scale:null};
}
function speeds(){
  const scale=mPerPx();
  const pts=state.points.slice().sort((a,b)=>a.t-b.t);
  const arr=[];
  for(let i=1;i<pts.length;i++){
    const dt=pts[i].t-pts[i-1].t;
    if(dt<=0) continue;
    const dpx=dist(pts[i],pts[i-1]);
    arr.push({t:pts[i].t, value:scale?dpx*scale/dt:dpx/dt, unit:scale?'m/s':'px/s'});
  }
  return arr;
}
function estimatedRPM(){
  const frames=parseFloat($('rotationFrames').value);
  return frames>0 ? fps()/frames*60 : null;
}

function renderSummary(){
  const pts=state.points;
  const sp=speeds();
  const scale=mPerPx();
  const avgSpeed=sp.length ? sp.reduce((a,b)=>a+b.value,0)/sp.length : null;
  const devs=pts.map(deviationFromCenter).filter(Boolean);
  const vals=devs.map(d=>Math.abs(scale?d.m:d.px));
  const avgDev=vals.length?vals.reduce((a,b)=>a+b,0)/vals.length:null;
  const maxDev=vals.length?Math.max(...vals):null;
  const rpm=estimatedRPM();
  $('trackCount').textContent=pts.length;
  $('avgSpeed').textContent=avgSpeed==null?'-':`${avgSpeed.toFixed(2)} ${scale?'m/s':'px/s'}`;
  $('summaryCards').innerHTML=`
    <div class="stat-box">追跡点<strong>${pts.length}</strong></div>
    <div class="stat-box">平均速度<strong>${avgSpeed==null?'-':`${avgSpeed.toFixed(2)} ${scale?'m/s':'px/s'}`}</strong></div>
    <div class="stat-box">最大速度<strong>${sp.length?`${Math.max(...sp.map(s=>s.value)).toFixed(2)} ${scale?'m/s':'px/s'}`:'-'}</strong></div>
    <div class="stat-box">平均左右ズレ<strong>${avgDev==null?'-':`${avgDev.toFixed(2)} ${scale?'m':'px'}`}</strong></div>
    <div class="stat-box">最大左右ズレ<strong>${maxDev==null?'-':`${maxDev.toFixed(2)} ${scale?'m':'px'}`}</strong></div>
    <div class="stat-box">推定回転数<strong>${rpm?`${rpm.toFixed(1)} rpm`:'-'}</strong></div>
    <div class="stat-box">基準線<strong>${state.scalePx?`${$('scaleMeters').value}m / ${state.scalePx.toFixed(1)}px`:'未設定'}</strong></div>
    <div class="stat-box">中心線<strong>${state.centerLine?'設定済み':'未設定'}</strong></div>
  `;
}

function drawOverlay(){
  const w=overlay.clientWidth, h=overlay.clientHeight;
  octx.clearRect(0,0,w,h);
  const r=state.renderRect;
  octx.strokeStyle='rgba(255,255,255,.35)'; octx.lineWidth=1; octx.strokeRect(r.x,r.y,r.w,r.h);

  const center=state.marks.filter(m=>m.type==='center'); if(center.length===2) drawMarkLine(center[0],center[1],'#22c55e',3);
  const scale=state.marks.filter(m=>m.type==='scale'); if(scale.length===2) drawMarkLine(scale[0],scale[1],'#a855f7',3);
  const init=state.marks.find(m=>m.type==='init'); if(init) drawMark(init,'#0ea5e9',9,'初');

  const pts=state.points.slice().sort((a,b)=>a.t-b.t);
  if(pts.length>1){
    octx.beginPath();
    pts.forEach((p,i)=>{ const c=videoToCanvas(p.x,p.y); i?octx.lineTo(c.x,c.y):octx.moveTo(c.x,c.y); });
    octx.strokeStyle='#f97316'; octx.lineWidth=3; octx.stroke();
  }
  pts.forEach((p,i)=>{
    const c=videoToCanvas(p.x,p.y);
    octx.beginPath(); octx.arc(c.x,c.y,p.auto?4:7,0,Math.PI*2);
    octx.fillStyle=p.auto?'#f97316':'#2563eb'; octx.fill();
    if(i%3===0 || !p.auto){ octx.fillStyle='white'; octx.font='12px sans-serif'; octx.fillText(String(i+1), c.x+7, c.y-7); }
  });
}
function drawMarkLine(a,b,color,width){ const ca=videoToCanvas(a.x,a.y), cb=videoToCanvas(b.x,b.y); octx.beginPath(); octx.moveTo(ca.x,ca.y); octx.lineTo(cb.x,cb.y); octx.strokeStyle=color; octx.lineWidth=width; octx.stroke(); }
function drawMark(p,color,r,label){ const c=videoToCanvas(p.x,p.y); octx.beginPath(); octx.arc(c.x,c.y,r,0,Math.PI*2); octx.fillStyle=color; octx.fill(); octx.fillStyle='white'; octx.font='12px sans-serif'; octx.fillText(label,c.x-5,c.y+4); }

function renderTable(){
  const sp=speeds();
  const tbody=$('dataTable').querySelector('tbody');
  tbody.innerHTML=state.points.map((p,i)=>{
    const d=deviationFromCenter(p); const scale=mPerPx();
    const dev=d?(scale?`${d.m.toFixed(3)} m`:`${d.px.toFixed(1)} px`):'';
    const speed=i>0&&sp[i-1]?`${sp[i-1].value.toFixed(2)} ${sp[i-1].unit}`:'';
    return `<tr><td>${i+1}</td><td>${p.t.toFixed(3)}</td><td>${p.frame}</td><td>${p.x.toFixed(1)}</td><td>${p.y.toFixed(1)}</td><td>${dev}</td><td>${speed}</td><td>${(p.confidence??0).toFixed(2)}</td><td>${p.auto?'自動':'手動'}</td><td><button data-del="${i}">削除</button></td></tr>`;
  }).join('');
  tbody.querySelectorAll('[data-del]').forEach(btn=>btn.onclick=()=>{ state.points.splice(Number(btn.dataset.del),1); recalcAll(); });
}

function setupChart(canvas){
  const g=canvas.getContext('2d'); const w=canvas.clientWidth,h=canvas.clientHeight;
  canvas.width=w*devicePixelRatio; canvas.height=h*devicePixelRatio; g.setTransform(devicePixelRatio,0,0,devicePixelRatio,0,0); g.clearRect(0,0,w,h); return [g,w,h];
}
function axes(g,w,h,xlab,ylab){
  g.strokeStyle='#cbd5e1';g.lineWidth=1;g.beginPath();g.moveTo(45,12);g.lineTo(45,h-36);g.lineTo(w-20,h-36);g.stroke();
  g.fillStyle='#334155';g.font='12px sans-serif';g.fillText(xlab,w/2,h-12);g.save();g.translate(14,h/2+30);g.rotate(-Math.PI/2);g.fillText(ylab,0,0);g.restore();
}
function empty(g,text){g.fillStyle='#64748b';g.fillText(text,60,60)}
function drawCharts(){ drawTrajectoryChart(); drawDeviationChart(); drawSpeedChart(); }
function drawTrajectoryChart(){
  const [g,w,h]=setupChart($('trajectoryChart')); axes(g,w,h,'x','y'); const pts=state.points;
  if(pts.length<2){empty(g,'自動追跡すると軌道が表示されます');return;}
  const minX=Math.min(...pts.map(p=>p.x)),maxX=Math.max(...pts.map(p=>p.x)),minY=Math.min(...pts.map(p=>p.y)),maxY=Math.max(...pts.map(p=>p.y));
  const sx=x=>45+(w-70)*(x-minX)/((maxX-minX)||1); const sy=y=>15+(h-55)*(y-minY)/((maxY-minY)||1);
  g.beginPath(); pts.forEach((p,i)=>i?g.lineTo(sx(p.x),sy(p.y)):g.moveTo(sx(p.x),sy(p.y))); g.strokeStyle='#f97316'; g.lineWidth=3; g.stroke();
  pts.forEach(p=>{g.beginPath();g.arc(sx(p.x),sy(p.y),4,0,Math.PI*2);g.fillStyle=p.auto?'#f97316':'#2563eb';g.fill();});
}
function drawDeviationChart(){
  const [g,w,h]=setupChart($('deviationChart')); axes(g,w,h,'時刻','左右ズレ'); const scale=mPerPx(); const data=state.points.map(p=>({t:p.t,d:deviationFromCenter(p)})).filter(x=>x.d);
  if(data.length<2){empty(g,'中心線2点を設定すると表示されます');return;}
  const vals=data.map(x=>scale?x.d.m:x.d.px); const times=data.map(x=>x.t); const minT=Math.min(...times),maxT=Math.max(...times),maxAbs=Math.max(1,...vals.map(v=>Math.abs(v)))*1.1;
  const sx=t=>45+(w-70)*(t-minT)/((maxT-minT)||1); const sy=v=>(h-36)/2-(h-70)*v/(2*maxAbs)+10;
  g.strokeStyle='#e2e8f0';g.beginPath();g.moveTo(45,sy(0));g.lineTo(w-20,sy(0));g.stroke();
  g.beginPath();vals.forEach((v,i)=>i?g.lineTo(sx(times[i]),sy(v)):g.moveTo(sx(times[i]),sy(v)));g.strokeStyle='#2563eb';g.lineWidth=3;g.stroke();
}
function drawSpeedChart(){
  const [g,w,h]=setupChart($('speedChart')); axes(g,w,h,'時刻','速度'); const sp=speeds();
  if(sp.length<2){empty(g,'追跡点が増えると表示されます');return;}
  const times=sp.map(s=>s.t), vals=sp.map(s=>s.value); const minT=Math.min(...times),maxT=Math.max(...times),maxV=Math.max(...vals)*1.1||1;
  const sx=t=>45+(w-70)*(t-minT)/((maxT-minT)||1); const sy=v=>(h-36)-(h-58)*v/maxV;
  g.beginPath();vals.forEach((v,i)=>i?g.lineTo(sx(times[i]),sy(v)):g.moveTo(sx(times[i]),sy(v)));g.strokeStyle='#22c55e';g.lineWidth=3;g.stroke();
}

$('exportCsvBtn').onclick=()=>{
  const sp=speeds();
  const rows=[
    ['分析名', $('projectName').value], ['サーブ分類', $('serveType').value], ['メモ', $('memo').value], ['FPS', $('fps').value], ['基準線m', $('scaleMeters').value], ['推定rpm', estimatedRPM()?estimatedRPM().toFixed(1):''], ['結果', $('resultNotes').value], ['誤差', $('errorNotes').value], [],
    ['#','時刻s','frame','x','y','中心線ズレpx','中心線ズレm','速度','速度単位','信頼度','種別']
  ];
  state.points.forEach((p,i)=>{ const d=deviationFromCenter(p); const s=i>0?sp[i-1]:null; rows.push([i+1,p.t.toFixed(3),p.frame,p.x.toFixed(2),p.y.toFixed(2),d?d.px.toFixed(2):'',d&&d.m!=null?d.m.toFixed(4):'',s?s.value.toFixed(3):'',s?s.unit:'',p.confidence??'',p.auto?'auto':'manual']); });
  downloadText('serve_lab_auto_data.csv', '\ufeff'+rows.map(r=>r.map(v=>`"${String(v??'').replace(/"/g,'""')}"`).join(',')).join('\n'), 'text/csv;charset=utf-8');
};
$('exportJsonBtn').onclick=()=>{ downloadText('serve_lab_auto_project.json', JSON.stringify(exportState(),null,2), 'application/json'); };
$('importJson').addEventListener('change', e=>{ const f=e.target.files[0]; if(!f)return; const reader=new FileReader(); reader.onload=()=>{ try{ importState(JSON.parse(reader.result)); recalcAll(); log('JSONを読み込みました'); }catch(err){ alert('JSONを読み込めませんでした'); } }; reader.readAsText(f); });
function exportState(){ return {fields:{projectName:$('projectName').value,fps:$('fps').value,scaleMeters:$('scaleMeters').value,frameSkip:$('frameSkip').value,searchRadius:$('searchRadius').value,colorTolerance:$('colorTolerance').value,minArea:$('minArea').value,detectMode:$('detectMode').value,rotationFrames:$('rotationFrames').value,serveType:$('serveType').value,memo:$('memo').value,resultNotes:$('resultNotes').value,errorNotes:$('errorNotes').value}, state:{points:state.points,marks:state.marks,startTime:state.startTime,endTime:state.endTime,initPoint:state.initPoint,initColor:state.initColor} }; }
function importState(data){ Object.entries(data.fields||{}).forEach(([k,v])=>{ if($(k)) $(k).value=v; }); Object.assign(state, data.state||{}); updateRange(); }
function downloadText(filename, text, type){ const blob=new Blob([text],{type}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=filename; a.click(); }

setInterval(updateTime,200);
resizeOverlay();
recalcAll();
log('待機中：動画ファイルを読み込んでください');
