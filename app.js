const $ = id => document.getElementById(id);

let player = null;
let apiReady = false;
let apiLoading = false;
let playerReady = false;

const state = {
  videoId: null,
  mode: 'ball',
  clickEnabled: false,
  points: [],
  scalePx: null,
  centerLine: null
};

function setStatus(msg){ $('statusBox').textContent = msg; }

function extractYoutubeId(url){
  const s = String(url || '').trim();
  const m = s.match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([\w-]{11})/);
  if(m) return m[1];
  if(/^[\w-]{11}$/.test(s)) return s;
  return null;
}

function loadYouTubeApi(callback){
  if(window.YT && window.YT.Player){ apiReady = true; callback(); return; }
  window.onYouTubeIframeAPIReady = () => { apiReady = true; setStatus('YouTube API 読み込み完了'); callback(); };
  if(apiLoading) return;
  apiLoading = true;
  const tag = document.createElement('script');
  tag.src = 'https://www.youtube.com/iframe_api';
  tag.onerror = () => setStatus('YouTube APIの読み込みに失敗。動画表示のみで使ってください。');
  document.head.appendChild(tag);
}

function embedUrl(id){
  const origin = location.origin && location.origin !== 'null' ? location.origin : '';
  const originParam = origin ? `&origin=${encodeURIComponent(origin)}` : '';
  return `https://www.youtube.com/embed/${id}?enablejsapi=1&playsinline=1&rel=0&modestbranding=1${originParam}`;
}

$('loadYoutube').onclick = () => {
  const id = extractYoutubeId($('youtubeUrl').value);
  if(!id){ alert('YouTube URLを確認してください。'); return; }
  state.videoId = id;
  playerReady = false;
  player = null;
  setStatus('動画を表示中...');

  $('ytHost').innerHTML = `<iframe id="ytFrame" src="${embedUrl(id)}" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe>`;
  resizeOverlay();

  loadYouTubeApi(() => {
    try{
      player = new YT.Player('ytFrame', {
        events: {
          onReady: () => { playerReady = true; setStatus('動画表示OK / API操作OK。解析するときだけクリック解析ONにしてください。'); updateLoop(); },
          onError: (e) => {
            const code = e.data;
            const msg = code === 101 || code === 150 ? 'この動画は埋め込み再生が許可されていない可能性があります。別動画で試してください。' :
              code === 100 ? '動画が削除・非公開・見つからない可能性があります。' :
              code === 2 ? '動画IDが不正です。URLを確認してください。' :
              `YouTubeエラー: ${code}`;
            setStatus(msg);
          }
        }
      });
    }catch(err){
      console.warn(err);
      setStatus('動画は表示されましたが、API操作に失敗。クリック解析OFFでYouTube側を操作してください。');
    }
  });
  saveState();
};

function currentTime(){
  try{ return playerReady && player && player.getCurrentTime ? player.getCurrentTime() : 0; }catch(e){ return 0; }
}
function duration(){
  try{ return playerReady && player && player.getDuration ? player.getDuration() : 0; }catch(e){ return 0; }
}
function seek(delta){
  if(!playerReady || !player || !player.seekTo){ setStatus('まだAPI操作が使えません。動画表示後に少し待ってください。'); return; }
  const t = Math.max(0, Math.min(duration() || 99999, currentTime() + delta));
  player.seekTo(t, true);
  updateTime();
}
function frameStep(){ return 1 / (parseFloat($('fps').value) || 30); }

$('playPause').onclick = () => {
  if(!playerReady || !player){ setStatus('まだAPI操作が使えません。クリック解析OFFで動画本体から再生してください。'); return; }
  const s = player.getPlayerState && player.getPlayerState();
  if(s === YT.PlayerState.PLAYING) player.pauseVideo();
  else player.playVideo();
};
$('backFrame').onclick = () => seek(-frameStep());
$('forwardFrame').onclick = () => seek(frameStep());
$('back01').onclick = () => seek(-0.1);
$('forward01').onclick = () => seek(0.1);
$('back1').onclick = () => seek(-1);
$('forward1').onclick = () => seek(1);

$('toggleClick').onclick = () => {
  state.clickEnabled = !state.clickEnabled;
  $('overlay').style.pointerEvents = state.clickEnabled ? 'auto' : 'none';
  $('toggleClick').textContent = `クリック解析：${state.clickEnabled ? 'ON' : 'OFF'}`;
  $('toggleClick').className = state.clickEnabled ? 'accent' : '';
};

const overlay = $('overlay');
const ctx = overlay.getContext('2d');
window.addEventListener('resize', resizeOverlay);
setTimeout(resizeOverlay, 300);

function resizeOverlay(){
  const r = overlay.getBoundingClientRect();
  overlay.width = r.width * devicePixelRatio;
  overlay.height = r.height * devicePixelRatio;
  ctx.setTransform(devicePixelRatio,0,0,devicePixelRatio,0,0);
  drawOverlay();
  drawCharts();
}

document.querySelectorAll('[data-mode]').forEach(btn => {
  btn.onclick = () => {
    state.mode = btn.dataset.mode;
    document.querySelectorAll('[data-mode]').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    $('modeNow').textContent = btn.textContent;
  };
});

overlay.addEventListener('click', e => {
  const r = overlay.getBoundingClientRect();
  const x = e.clientX - r.left;
  const y = e.clientY - r.top;
  const type = state.mode;
  if(type === 'center' && state.points.filter(p=>p.type==='center').length >= 2){ state.points = state.points.filter(p=>p.type!=='center'); }
  if(type === 'scale' && state.points.filter(p=>p.type==='scale').length >= 2){ state.points = state.points.filter(p=>p.type!=='scale'); }
  if(['toss','hit','target'].includes(type)){ state.points = state.points.filter(p=>p.type!==type); }
  state.points.push({
    t: Number(currentTime().toFixed(3)), type, x, y,
    serveType: $('serveType').value,
    memo: $('pointMemo').value.trim()
  });
  recalc();
});

$('undoBtn').onclick = () => { state.points.pop(); recalc(); };
$('clearAll').onclick = () => {
  if(confirm('クリックデータをすべて削除しますか？')){ state.points = []; recalc(); saveState(); }
};

['scaleMeters','fps','rotationFrames','playerName','formNotes','trajectoryNotes','resultNotes','nextNotes','youtubeUrl'].forEach(id=>{
  $(id).addEventListener('input', () => { recalc(); saveState(); });
});

function recalc(){
  recalcScaleAndCenter();
  renderTable(); renderSummary(); drawOverlay(); drawCharts(); saveState();
}
function recalcScaleAndCenter(){
  const scale = state.points.filter(p=>p.type==='scale');
  state.scalePx = scale.length === 2 ? dist(scale[0], scale[1]) : null;
  const center = state.points.filter(p=>p.type==='center');
  state.centerLine = center.length === 2 ? [center[0], center[1]] : null;
  $('scaleStatus').textContent = state.scalePx ? `${$('scaleMeters').value}m / ${state.scalePx.toFixed(1)}px` : '未設定';
  $('centerStatus').textContent = state.centerLine ? '設定済み' : '未設定';
}
function dist(a,b){ return Math.hypot(a.x-b.x, a.y-b.y); }
function mPerPx(){ const meters = parseFloat($('scaleMeters').value); return state.scalePx && meters ? meters / state.scalePx : null; }
function deviationFromCenter(p){
  if(!state.centerLine) return null;
  const [a,b] = state.centerLine;
  const dx = b.x-a.x, dy = b.y-a.y, len = Math.hypot(dx,dy);
  if(!len) return null;
  const signed = ((p.x-a.x)*dy - (p.y-a.y)*dx) / len;
  const scale = mPerPx();
  return { px: signed, m: scale ? signed * scale : null };
}
function ballPoints(){ return state.points.filter(p=>p.type==='ball').sort((a,b)=>a.t-b.t); }
function averageSpeed(){
  const b = ballPoints(); if(b.length < 2) return null;
  let dpx = 0; for(let i=1;i<b.length;i++) dpx += dist(b[i-1], b[i]);
  const dt = b[b.length-1].t - b[0].t; if(dt <= 0) return null;
  const scale = mPerPx(); return scale ? { value: dpx*scale/dt, unit:'m/s' } : { value: dpx/dt, unit:'px/s' };
}
function estimatedRPM(){ const frames = parseFloat($('rotationFrames').value); const fps = parseFloat($('fps').value) || 0; return frames > 0 && fps > 0 ? fps / frames * 60 : null; }

function renderSummary(){
  const b = ballPoints(), speed = averageSpeed(), rpm = estimatedRPM();
  const devs = b.map(deviationFromCenter).filter(Boolean), scale = mPerPx();
  let avgDev = null, maxDev = null;
  if(devs.length){ const vals = devs.map(d => Math.abs(scale ? d.m : d.px)); avgDev = vals.reduce((a,c)=>a+c,0) / vals.length; maxDev = Math.max(...vals); }
  $('speedStatus').textContent = speed ? `${speed.value.toFixed(2)} ${speed.unit}` : '-';
  $('summaryCards').innerHTML = `
    <div class="stat-box">ボール記録点<strong>${b.length}</strong></div>
    <div class="stat-box">平均速度<strong>${speed ? `${speed.value.toFixed(2)} ${speed.unit}` : '-'}</strong></div>
    <div class="stat-box">推定回転数<strong>${rpm ? `${rpm.toFixed(1)} rpm` : '-'}</strong></div>
    <div class="stat-box">平均左右ズレ<strong>${avgDev==null ? '-' : `${avgDev.toFixed(2)} ${scale?'m':'px'}`}</strong></div>
    <div class="stat-box">最大左右ズレ<strong>${maxDev==null ? '-' : `${maxDev.toFixed(2)} ${scale?'m':'px'}`}</strong></div>`;
}

function drawOverlay(){
  const w = overlay.clientWidth, h = overlay.clientHeight; ctx.clearRect(0,0,w,h);
  const center = state.points.filter(p=>p.type==='center'); if(center.length === 2) drawLine(center[0], center[1], '#22c55e', 3);
  const scale = state.points.filter(p=>p.type==='scale'); if(scale.length === 2) drawLine(scale[0], scale[1], '#a855f7', 3);
  const b = ballPoints(); if(b.length > 1){ ctx.beginPath(); b.forEach((p,i)=> i ? ctx.lineTo(p.x,p.y) : ctx.moveTo(p.x,p.y)); ctx.strokeStyle = '#f97316'; ctx.lineWidth = 3; ctx.stroke(); }
  state.points.forEach((p,i)=>{ const color = colorFor(p.type), r = ['hit','toss','target'].includes(p.type) ? 8 : 5; ctx.beginPath(); ctx.arc(p.x,p.y,r,0,Math.PI*2); ctx.fillStyle=color; ctx.fill(); ctx.fillStyle='#fff'; ctx.font='12px sans-serif'; ctx.fillText(String(i+1), p.x+8, p.y-8); });
}
function drawLine(a,b,color,width){ ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); ctx.strokeStyle=color; ctx.lineWidth=width; ctx.stroke(); }
function colorFor(type){ return {ball:'#f97316',center:'#22c55e',scale:'#a855f7',toss:'#0ea5e9',hit:'#2563eb',target:'#ef4444',body:'#64748b'}[type] || '#111827'; }
function labelFor(type){ return {ball:'ボール',center:'中心線',scale:'基準線',toss:'トス',hit:'打点',target:'落下/狙い',body:'体軸/着地'}[type] || type; }

function renderTable(){
  const tbody = $('dataTable').querySelector('tbody');
  tbody.innerHTML = state.points.map((p,i)=>{ const d = deviationFromCenter(p); const dev = d ? (d.m!=null ? `${d.m.toFixed(2)} m` : `${d.px.toFixed(1)} px`) : ''; return `<tr><td>${i+1}</td><td>${p.t.toFixed(3)}</td><td>${labelFor(p.type)}</td><td>${p.x.toFixed(1)}</td><td>${p.y.toFixed(1)}</td><td>${dev}</td><td>${escapeHtml(p.serveType||'')}</td><td>${escapeHtml(p.memo||'')}</td><td><button data-del="${i}">削除</button></td></tr>`; }).join('');
  tbody.querySelectorAll('[data-del]').forEach(btn=>{ btn.onclick = () => { state.points.splice(Number(btn.dataset.del),1); recalc(); }; });
}

function setupCanvas(c){ const g = c.getContext('2d'); const w = c.clientWidth, h = c.clientHeight; c.width = w * devicePixelRatio; c.height = h * devicePixelRatio; g.setTransform(devicePixelRatio,0,0,devicePixelRatio,0,0); g.clearRect(0,0,w,h); return [g,w,h]; }
function drawCharts(){ drawTrajectoryChart(); drawDeviationChart(); }
function drawTrajectoryChart(){
  const [g,w,h] = setupCanvas($('trajectoryChart')); const b = ballPoints(); axes(g,w,h,'x','y'); if(b.length < 2){ empty(g,'ボール軌道をクリックすると表示されます'); return; }
  const minX=Math.min(...b.map(p=>p.x)), maxX=Math.max(...b.map(p=>p.x)), minY=Math.min(...b.map(p=>p.y)), maxY=Math.max(...b.map(p=>p.y));
  const sx=x=>45+(w-70)*(x-minX)/((maxX-minX)||1), sy=y=>15+(h-55)*(y-minY)/((maxY-minY)||1);
  g.beginPath(); b.forEach((p,i)=> i?g.lineTo(sx(p.x),sy(p.y)):g.moveTo(sx(p.x),sy(p.y))); g.strokeStyle='#f97316'; g.lineWidth=3; g.stroke();
  b.forEach(p=>{g.beginPath();g.arc(sx(p.x),sy(p.y),5,0,Math.PI*2);g.fillStyle='#f97316';g.fill();});
}
function drawDeviationChart(){
  const [g,w,h] = setupCanvas($('deviationChart')); const b = ballPoints().map(p=>({p,d:deviationFromCenter(p)})).filter(x=>x.d); axes(g,w,h,'時刻','中心線からのズレ'); if(b.length < 2){ empty(g,'中心線とボール軌道を記録すると表示されます'); return; }
  const scale = mPerPx(), vals = b.map(x=> scale ? x.d.m : x.d.px), times = b.map(x=>x.p.t); const minT=Math.min(...times), maxT=Math.max(...times), maxAbs=Math.max(1,...vals.map(v=>Math.abs(v))) * 1.1;
  const sx=t=>45+(w-70)*(t-minT)/((maxT-minT)||1), sy=v=>(h-35)/2-(h-65)*v/(2*maxAbs)+10;
  g.strokeStyle='#cbd5e1'; g.beginPath(); g.moveTo(45,sy(0)); g.lineTo(w-25,sy(0)); g.stroke(); g.beginPath(); vals.forEach((v,i)=> i?g.lineTo(sx(times[i]),sy(v)):g.moveTo(sx(times[i]),sy(v))); g.strokeStyle='#2563eb'; g.lineWidth=3; g.stroke(); vals.forEach((v,i)=>{g.beginPath();g.arc(sx(times[i]),sy(v),5,0,Math.PI*2);g.fillStyle='#2563eb';g.fill();});
}
function axes(g,w,h,xlab,ylab){ g.strokeStyle='#cbd5e1'; g.lineWidth=1; g.beginPath(); g.moveTo(45,10); g.lineTo(45,h-35); g.lineTo(w-20,h-35); g.stroke(); g.fillStyle='#334155'; g.font='12px sans-serif'; g.fillText(xlab,w/2,h-12); g.save(); g.translate(14,h/2+25); g.rotate(-Math.PI/2); g.fillText(ylab,0,0); g.restore(); }
function empty(g,text){ g.fillStyle='#64748b'; g.fillText(text,60,60); }
function updateTime(){ $('timeNow').textContent = `${currentTime().toFixed(2)}s`; }
function updateLoop(){ updateTime(); requestAnimationFrame(updateLoop); }

function saveState(){
  const fields = ['playerName','youtubeUrl','fps','scaleMeters','rotationFrames','serveType','formNotes','trajectoryNotes','resultNotes','nextNotes'];
  const data = { fields:{}, points:state.points, videoId:state.videoId };
  fields.forEach(id=>data.fields[id]=$(id).value);
  localStorage.setItem('yt_serve_click_v6', JSON.stringify(data));
}
function loadState(){
  try{ const raw = localStorage.getItem('yt_serve_click_v6'); if(!raw) return; const data = JSON.parse(raw); Object.entries(data.fields||{}).forEach(([k,v])=>{ if($(k)) $(k).value=v; }); state.points = data.points || []; state.videoId = data.videoId || null; }catch(e){}
}
$('saveBtn').onclick = () => { saveState(); alert('保存しました。'); };
$('exportBtn').onclick = () => {
  const rows = [
    ['選手名・動画名', $('playerName').value], ['YouTube URL', $('youtubeUrl').value], ['FPS', $('fps').value], ['基準線実距離m', $('scaleMeters').value], ['1回転フレーム数', $('rotationFrames').value], ['推定rpm', estimatedRPM() ? estimatedRPM().toFixed(1) : ''], ['フォーム特徴', $('formNotes').value], ['軌道・回転特徴', $('trajectoryNotes').value], ['分析から言えること', $('resultNotes').value], ['次に確認したいこと', $('nextNotes').value], [], ['#','時刻s','種類','x','y','中心線ズレpx','中心線ズレm','サーブ分類','メモ'],
    ...state.points.map((p,i)=>{ const d=deviationFromCenter(p); return [i+1,p.t,labelFor(p.type),p.x.toFixed(1),p.y.toFixed(1),d?d.px.toFixed(2):'',d&&d.m!=null?d.m.toFixed(3):'',p.serveType||'',p.memo||'']; })
  ];
  const csv = rows.map(r=>r.map(v=>`"${String(v??'').replace(/"/g,'""')}"`).join(',')).join('\n'); const blob = new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8'}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='yt_serve_click_analysis_v6.csv'; a.click();
};
function escapeHtml(s){ return String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

loadState(); recalc(); setInterval(updateTime, 200);
