import {
  FilesetResolver,
  PoseLandmarker,
  DrawingUtils
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/vision_bundle.mjs";

const MODEL_URLS = {
  full: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task",
  lite: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task"
};
const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm";
const SAMPLE_FPS = 12;
const DISPLAY_FPS = 30;
const MAX_SAMPLES = 900;
const MIN_VISIBILITY = 0.35;

const POSE = {
  NOSE: 0,
  LEFT_SHOULDER: 11,
  RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13,
  RIGHT_ELBOW: 14,
  LEFT_WRIST: 15,
  RIGHT_WRIST: 16,
  LEFT_HIP: 23,
  RIGHT_HIP: 24,
  LEFT_KNEE: 25,
  RIGHT_KNEE: 26,
  LEFT_ANKLE: 27,
  RIGHT_ANKLE: 28
};

const els = Object.fromEntries([
  "videoFile", "dropZone", "handedness", "viewDirection", "serveType", "modelQuality",
  "clipStart", "clipEnd", "analyzeButton", "cancelButton", "progressWrap", "progressText",
  "progressPercent", "analysisProgress", "notice", "modelStatus", "sourceVideo", "overlayCanvas",
  "videoStage", "playPauseButton", "prevFrameButton", "nextFrameButton", "timeline", "timeDisplay",
  "playbackRate", "skeletonToggle", "jumpHitButton", "setHitButton", "hitTimeLabel", "youtubeUrl",
  "loadYoutubeButton", "youtubeFrameWrap", "youtubeFrame", "youtubePlaceholder", "exportCsvButton",
  "exportImageButton", "elbowMetric", "kneeMetric", "shoulderMetric", "trunkMetric", "detectionMetric",
  "angleChart", "chartEmpty", "observationText", "phaseButtons"
].map(id => [id, document.getElementById(id)]));

const ctx = els.overlayCanvas.getContext("2d");
let drawingUtils = null;
let poseLandmarker = null;
let loadedModelQuality = null;
let analysis = null;
let sourceObjectUrl = null;
let angleChart = null;
let renderAnimationId = null;
let cancelRequested = false;
let lastInferenceTimestamp = 0;

function setNotice(message, type = "info") {
  els.notice.textContent = message;
  els.notice.className = `notice${type === "info" ? "" : ` ${type}`}`;
}

function setModelStatus(text, state) {
  els.modelStatus.textContent = text;
  els.modelStatus.className = `status-pill status-${state}`;
}

function formatTime(seconds) {
  return Number.isFinite(seconds) ? seconds.toFixed(2) : "0.00";
}

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

function mean(values) {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : NaN;
}

function visibilityOf(point) {
  return Number.isFinite(point?.visibility) ? point.visibility : 1;
}

function pointsVisible(...points) {
  return points.every(point => point && visibilityOf(point) >= MIN_VISIBILITY);
}

function angle3Points(a, b, c) {
  if (!pointsVisible(a, b, c)) return NaN;
  const ba = { x: a.x - b.x, y: a.y - b.y, z: (a.z || 0) - (b.z || 0) };
  const bc = { x: c.x - b.x, y: c.y - b.y, z: (c.z || 0) - (b.z || 0) };
  const dot = ba.x * bc.x + ba.y * bc.y + ba.z * bc.z;
  const lenA = Math.hypot(ba.x, ba.y, ba.z);
  const lenC = Math.hypot(bc.x, bc.y, bc.z);
  if (!lenA || !lenC) return NaN;
  return Math.acos(clamp(dot / (lenA * lenC), -1, 1)) * 180 / Math.PI;
}

function lineAngle(a, b) {
  if (!pointsVisible(a, b)) return NaN;
  return Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
}

function midpoint(a, b) {
  if (!a || !b) return null;
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
    z: ((a.z || 0) + (b.z || 0)) / 2,
    visibility: Math.min(visibilityOf(a), visibilityOf(b))
  };
}

function normalizeHorizontalAngle(degrees) {
  let angle = degrees;
  while (angle > 90) angle -= 180;
  while (angle < -90) angle += 180;
  return angle;
}

function computeMetrics(landmarks, handedness) {
  const right = handedness === "right";
  const shoulder = landmarks[right ? POSE.RIGHT_SHOULDER : POSE.LEFT_SHOULDER];
  const elbow = landmarks[right ? POSE.RIGHT_ELBOW : POSE.LEFT_ELBOW];
  const wrist = landmarks[right ? POSE.RIGHT_WRIST : POSE.LEFT_WRIST];
  const leftShoulder = landmarks[POSE.LEFT_SHOULDER];
  const rightShoulder = landmarks[POSE.RIGHT_SHOULDER];
  const leftHip = landmarks[POSE.LEFT_HIP];
  const rightHip = landmarks[POSE.RIGHT_HIP];
  const shoulderMid = midpoint(leftShoulder, rightShoulder);
  const hipMid = midpoint(leftHip, rightHip);
  const leftKnee = angle3Points(leftHip, landmarks[POSE.LEFT_KNEE], landmarks[POSE.LEFT_ANKLE]);
  const rightKnee = angle3Points(rightHip, landmarks[POSE.RIGHT_KNEE], landmarks[POSE.RIGHT_ANKLE]);

  const torsoLength = shoulderMid && hipMid ? Math.hypot(shoulderMid.x - hipMid.x, shoulderMid.y - hipMid.y) : NaN;
  const wristAboveShoulder = pointsVisible(wrist, shoulder) && torsoLength > 0
    ? (shoulder.y - wrist.y) / torsoLength
    : NaN;

  return {
    elbow: angle3Points(shoulder, elbow, wrist),
    knee: mean([leftKnee, rightKnee]),
    leftKnee,
    rightKnee,
    shoulderTilt: normalizeHorizontalAngle(lineAngle(leftShoulder, rightShoulder)),
    hipTilt: normalizeHorizontalAngle(lineAngle(leftHip, rightHip)),
    trunkLean: shoulderMid && hipMid
      ? Math.atan2(shoulderMid.x - hipMid.x, hipMid.y - shoulderMid.y) * 180 / Math.PI
      : NaN,
    wristX: wrist?.x,
    wristY: wrist?.y,
    wristVisibility: visibilityOf(wrist),
    wristAboveShoulder,
    hipMidY: hipMid?.y
  };
}

async function initializePoseLandmarker() {
  const quality = els.modelQuality.value;
  if (poseLandmarker && loadedModelQuality === quality) return;

  setModelStatus("AI読込中", "loading");
  setNotice("骨格検出AIを読み込んでいます。初回のみ通信環境により時間がかかります。");
  try {
    if (poseLandmarker) {
      poseLandmarker.close();
      poseLandmarker = null;
    }
    const vision = await FilesetResolver.forVisionTasks(WASM_URL);
    poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: MODEL_URLS[quality],
        delegate: "GPU"
      },
      runningMode: "VIDEO",
      numPoses: 1,
      minPoseDetectionConfidence: 0.45,
      minPosePresenceConfidence: 0.45,
      minTrackingConfidence: 0.45,
      outputSegmentationMasks: false
    });
    loadedModelQuality = quality;
    drawingUtils = new DrawingUtils(ctx);
    setModelStatus("AI準備完了", "ready");
  } catch (error) {
    console.error(error);
    setModelStatus("AI読込失敗", "error");
    throw new Error("AIモデルを読み込めませんでした。インターネット接続とブラウザ設定を確認してください。");
  }
}

function handleFile(file) {
  if (!file || !file.type.startsWith("video/")) {
    setNotice("動画ファイルを選択してください。", "error");
    return;
  }
  if (sourceObjectUrl) URL.revokeObjectURL(sourceObjectUrl);
  sourceObjectUrl = URL.createObjectURL(file);
  els.sourceVideo.src = sourceObjectUrl;
  els.sourceVideo.load();
  els.dropZone.classList.add("has-file");
  els.dropZone.querySelector("strong").textContent = file.name;
  els.dropZone.querySelector("span").textContent = `${(file.size / 1024 / 1024).toFixed(1)} MB`;
  analysis = null;
  resetResults();
  setNotice("動画を読み込み中です…");
}

function onVideoLoaded() {
  const video = els.sourceVideo;
  const duration = video.duration || 0;
  els.clipStart.value = "0";
  els.clipEnd.value = duration.toFixed(2);
  els.clipStart.max = duration.toFixed(2);
  els.clipEnd.max = duration.toFixed(2);
  els.timeline.disabled = false;
  els.playPauseButton.disabled = false;
  els.prevFrameButton.disabled = false;
  els.nextFrameButton.disabled = false;
  els.playbackRate.disabled = false;
  els.analyzeButton.disabled = false;
  els.videoStage.classList.remove("empty");
  els.overlayCanvas.width = video.videoWidth || 1280;
  els.overlayCanvas.height = video.videoHeight || 720;
  updateTimeDisplay();
  setNotice(`動画を読み込みました（${formatTime(duration)}秒）。解析範囲を確認して「自動解析する」を押してください。`, "success");
  startRenderLoop();
}

function resetResults() {
  [els.elbowMetric, els.kneeMetric, els.shoulderMetric, els.trunkMetric, els.detectionMetric]
    .forEach(el => el.textContent = "—");
  els.hitTimeLabel.textContent = "打点候補：未解析";
  els.jumpHitButton.disabled = true;
  els.setHitButton.disabled = true;
  els.exportCsvButton.disabled = true;
  els.exportImageButton.disabled = true;
  els.observationText.textContent = "動画解析後、打点候補とフォームの特徴をここに表示します。";
  els.phaseButtons.innerHTML = '<span class="muted">解析後に候補時刻が表示されます。</span>';
  if (angleChart) {
    angleChart.destroy();
    angleChart = null;
  }
  els.chartEmpty.hidden = false;
  clearOverlay();
}

function clearOverlay() {
  ctx.clearRect(0, 0, els.overlayCanvas.width, els.overlayCanvas.height);
}

function startRenderLoop() {
  if (renderAnimationId) cancelAnimationFrame(renderAnimationId);
  const render = () => {
    updateTimeDisplay();
    drawCachedPoseAtTime(els.sourceVideo.currentTime);
    renderAnimationId = requestAnimationFrame(render);
  };
  render();
}

function updateTimeDisplay() {
  const video = els.sourceVideo;
  const duration = video.duration || 0;
  const current = video.currentTime || 0;
  els.timeDisplay.textContent = `${formatTime(current)} / ${formatTime(duration)} 秒`;
  if (duration && document.activeElement !== els.timeline) {
    els.timeline.value = Math.round((current / duration) * 1000);
  }
  els.playPauseButton.textContent = video.paused ? "▶" : "❚❚";
}

function nearestFrameIndex(time) {
  if (!analysis?.frames?.length) return -1;
  let low = 0;
  let high = analysis.frames.length - 1;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (analysis.frames[mid].time < time) low = mid + 1;
    else high = mid;
  }
  if (low > 0 && Math.abs(analysis.frames[low - 1].time - time) < Math.abs(analysis.frames[low].time - time)) return low - 1;
  return low;
}

function drawCachedPoseAtTime(time) {
  clearOverlay();
  if (!analysis || !els.skeletonToggle.checked) return;
  const index = nearestFrameIndex(time);
  if (index < 0) return;
  const frame = analysis.frames[index];
  if (!frame.landmarks) return;

  drawingUtils.drawConnectors(frame.landmarks, PoseLandmarker.POSE_CONNECTIONS, {
    color: "rgba(61, 214, 231, 0.92)",
    lineWidth: Math.max(2, els.overlayCanvas.width / 520)
  });
  drawingUtils.drawLandmarks(frame.landmarks, {
    color: "#f8fafc",
    fillColor: "#2563eb",
    lineWidth: 1,
    radius: Math.max(2, els.overlayCanvas.width / 260)
  });

  if (index === analysis.hitIndex) {
    drawHitMarker(frame.landmarks, analysis.handedness);
  }
}

function drawHitMarker(landmarks, handedness) {
  const wristIndex = handedness === "right" ? POSE.RIGHT_WRIST : POSE.LEFT_WRIST;
  const wrist = landmarks[wristIndex];
  if (!wrist) return;
  const x = wrist.x * els.overlayCanvas.width;
  const y = wrist.y * els.overlayCanvas.height;
  const radius = Math.max(15, els.overlayCanvas.width / 45);
  ctx.save();
  ctx.strokeStyle = "#ef4444";
  ctx.fillStyle = "rgba(239, 68, 68, .16)";
  ctx.lineWidth = Math.max(3, els.overlayCanvas.width / 300);
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.font = `700 ${Math.max(16, els.overlayCanvas.width / 55)}px sans-serif`;
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = "rgba(15, 23, 42, .9)";
  ctx.lineWidth = 5;
  ctx.strokeText("打点候補", x + radius + 8, y - 6);
  ctx.fillText("打点候補", x + radius + 8, y - 6);
  ctx.restore();
}

function seekVideo(time) {
  const video = els.sourceVideo;
  const target = clamp(time, 0, Math.max(0, (video.duration || 0) - 0.001));
  if (Math.abs(video.currentTime - target) < 0.003) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("動画のフレーム移動がタイムアウトしました。"));
    }, 5000);
    const cleanup = () => {
      clearTimeout(timeout);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
    };
    const onSeeked = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new Error("動画を読み取れませんでした。")); };
    video.addEventListener("seeked", onSeeked, { once: true });
    video.addEventListener("error", onError, { once: true });
    video.currentTime = target;
  });
}

function updateProgress(done, total, label) {
  const percent = total ? Math.round(done / total * 100) : 0;
  els.analysisProgress.value = percent;
  els.progressPercent.textContent = `${percent}%`;
  els.progressText.textContent = label;
}

async function analyzeVideo() {
  const video = els.sourceVideo;
  if (!video.src || !Number.isFinite(video.duration)) return;

  const start = clamp(Number(els.clipStart.value) || 0, 0, video.duration);
  const end = clamp(Number(els.clipEnd.value) || video.duration, start + 0.05, video.duration);
  const duration = end - start;
  let sampleCount = Math.floor(duration * SAMPLE_FPS) + 1;
  if (sampleCount > MAX_SAMPLES) sampleCount = MAX_SAMPLES;
  const actualFps = sampleCount > 1 ? (sampleCount - 1) / duration : SAMPLE_FPS;

  cancelRequested = false;
  els.analyzeButton.disabled = true;
  els.cancelButton.hidden = false;
  els.progressWrap.hidden = false;
  updateProgress(0, sampleCount, "AIを準備中…");
  video.pause();

  try {
    await initializePoseLandmarker();
    const frames = [];
    const handedness = els.handedness.value;
    const timestampBase = Math.max(performance.now(), lastInferenceTimestamp + 10);

    for (let i = 0; i < sampleCount; i++) {
      if (cancelRequested) throw new DOMException("解析を中止しました。", "AbortError");
      const time = sampleCount === 1 ? start : start + (i / (sampleCount - 1)) * duration;
      await seekVideo(time);
      const timestamp = timestampBase + i * (1000 / actualFps);
      lastInferenceTimestamp = timestamp;
      const result = poseLandmarker.detectForVideo(video, timestamp);
      const landmarks = result.landmarks?.[0]
        ? result.landmarks[0].map(point => ({ ...point }))
        : null;
      frames.push({
        time,
        landmarks,
        metrics: landmarks ? computeMetrics(landmarks, handedness) : null
      });
      updateProgress(i + 1, sampleCount, `骨格を解析中… ${i + 1} / ${sampleCount}`);
      if (i % 5 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    }

    const hitIndex = estimateHitIndex(frames, handedness);
    const phases = estimatePhases(frames, hitIndex);
    analysis = {
      frames,
      hitIndex,
      phases,
      handedness,
      viewDirection: els.viewDirection.value,
      serveType: els.serveType.value,
      clipStart: start,
      clipEnd: end,
      sampleFps: actualFps
    };

    renderResults();
    if (hitIndex >= 0) await seekVideo(frames[hitIndex].time);
    setNotice("解析が完了しました。赤い円の打点候補をスロー再生で確認し、必要なら現在位置へ修正してください。", "success");
  } catch (error) {
    console.error(error);
    if (error.name === "AbortError") {
      setNotice("解析を中止しました。", "error");
    } else {
      setNotice(error.message || "解析中にエラーが発生しました。", "error");
    }
  } finally {
    els.analyzeButton.disabled = false;
    els.cancelButton.hidden = true;
    updateProgress(1, 1, "完了");
    setTimeout(() => { els.progressWrap.hidden = true; }, 700);
  }
}

function estimateHitIndex(frames, handedness) {
  const validIndices = frames.map((frame, i) => frame.metrics && Number.isFinite(frame.metrics.elbow) ? i : -1).filter(i => i >= 0);
  if (!validIndices.length) return -1;

  const speeds = frames.map(() => 0);
  for (let i = 1; i < frames.length; i++) {
    const prev = frames[i - 1].metrics;
    const current = frames[i].metrics;
    const dt = frames[i].time - frames[i - 1].time;
    if (prev && current && dt > 0 && Number.isFinite(prev.wristX) && Number.isFinite(current.wristX)) {
      speeds[i] = Math.hypot(current.wristX - prev.wristX, current.wristY - prev.wristY) / dt;
    }
  }
  const maxSpeed = Math.max(...speeds, 0.001);
  let bestIndex = validIndices[0];
  let bestScore = -Infinity;
  const minSearch = Math.floor(frames.length * 0.12);
  const maxSearch = Math.ceil(frames.length * 0.96);

  for (const i of validIndices) {
    if (i < minSearch || i > maxSearch) continue;
    const m = frames[i].metrics;
    if (m.wristVisibility < MIN_VISIBILITY) continue;
    const heightScore = clamp((m.wristAboveShoulder + 0.1) / 1.45);
    const extensionScore = clamp((m.elbow - 100) / 80);
    const speedScore = clamp(speeds[i] / maxSpeed);
    const score = heightScore * 0.5 + extensionScore * 0.32 + speedScore * 0.18;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }
  return bestIndex;
}

function estimatePhases(frames, hitIndex) {
  if (hitIndex < 0) return [];
  const hitTime = frames[hitIndex].time;
  const beforeStart = Math.max(0, hitIndex - Math.round(1.8 * (analysis?.sampleFps || SAMPLE_FPS)));
  let takebackIndex = beforeStart;
  let minElbow = Infinity;
  for (let i = beforeStart; i < hitIndex; i++) {
    const elbow = frames[i].metrics?.elbow;
    if (Number.isFinite(elbow) && elbow < minElbow) {
      minElbow = elbow;
      takebackIndex = i;
    }
  }

  let landingIndex = Math.min(frames.length - 1, hitIndex + Math.round(0.65 * SAMPLE_FPS));
  let maxHipY = -Infinity;
  for (let i = hitIndex; i < Math.min(frames.length, hitIndex + Math.round(1.3 * SAMPLE_FPS)); i++) {
    const hipY = frames[i].metrics?.hipMidY;
    if (Number.isFinite(hipY) && hipY > maxHipY) {
      maxHipY = hipY;
      landingIndex = i;
    }
  }

  return [
    { label: "構え", index: 0 },
    { label: "テイクバック候補", index: takebackIndex },
    { label: "打点候補", index: hitIndex },
    { label: "フォロースルー", index: Math.min(frames.length - 1, hitIndex + Math.round(0.3 * SAMPLE_FPS)) },
    { label: "着地候補", index: landingIndex }
  ].filter((phase, pos, arr) => arr.findIndex(other => other.index === phase.index) === pos && Number.isFinite(hitTime));
}

function renderResults() {
  const detected = analysis.frames.filter(frame => frame.landmarks).length;
  const rate = analysis.frames.length ? detected / analysis.frames.length * 100 : 0;
  els.detectionMetric.textContent = `${rate.toFixed(0)}%`;
  els.jumpHitButton.disabled = analysis.hitIndex < 0;
  els.setHitButton.disabled = false;
  els.exportCsvButton.disabled = false;
  els.exportImageButton.disabled = false;

  if (analysis.hitIndex < 0) {
    els.hitTimeLabel.textContent = "打点候補：検出できませんでした";
    els.observationText.textContent = "骨格を十分に検出できませんでした。全身が映る動画、明るい背景、短い解析範囲で再度お試しください。";
    return;
  }

  const hitFrame = analysis.frames[analysis.hitIndex];
  const m = hitFrame.metrics || {};
  els.hitTimeLabel.textContent = `打点候補：${formatTime(hitFrame.time)} 秒`;
  els.elbowMetric.textContent = metricText(m.elbow);
  els.kneeMetric.textContent = metricText(m.knee);
  els.shoulderMetric.textContent = signedMetricText(m.shoulderTilt);
  els.trunkMetric.textContent = signedMetricText(m.trunkLean);
  renderChart();
  renderObservation(m, rate);
  renderPhases();
}

function metricText(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)}°` : "—";
}
function signedMetricText(value) {
  return Number.isFinite(value) ? `${value >= 0 ? "+" : ""}${value.toFixed(1)}°` : "—";
}

function renderObservation(metrics, detectionRate) {
  const points = [];
  if (Number.isFinite(metrics.elbow)) {
    if (metrics.elbow >= 160) points.push(`打点候補では利き腕の肘が ${metrics.elbow.toFixed(1)}° まで伸びています。`);
    else if (metrics.elbow >= 145) points.push(`打点候補の肘角度は ${metrics.elbow.toFixed(1)}° で、やや曲がりを残した状態です。`);
    else points.push(`打点候補の肘角度は ${metrics.elbow.toFixed(1)}° です。打点フレームが合っているか確認してください。`);
  }
  if (Number.isFinite(metrics.trunkLean)) {
    const absLean = Math.abs(metrics.trunkLean);
    if (absLean <= 8) points.push(`体幹の左右傾きは ${absLean.toFixed(1)}° で、後方画面上では比較的小さい値です。`);
    else if (absLean <= 15) points.push(`体幹が左右に ${absLean.toFixed(1)}° 傾いています。複数回で同じ方向へ傾くか比較すると探究に使えます。`);
    else points.push(`体幹の左右傾きが ${absLean.toFixed(1)}° と大きめです。トス位置や助走方向との関係を確認してください。`);
  }
  if (Number.isFinite(metrics.shoulderTilt)) {
    points.push(`肩のラインは水平に対して ${Math.abs(metrics.shoulderTilt).toFixed(1)}° 傾いています。`);
  }
  if (detectionRate < 70) points.push(`骨格検出率は ${detectionRate.toFixed(0)}% です。画角や明るさを改善すると数値の信頼性が上がります。`);
  points.push("この結果はフォームの良し悪しを断定する採点ではなく、動画間の変化を比較するための観察データです。");
  els.observationText.innerHTML = `<ul>${points.map(point => `<li>${point}</li>`).join("")}</ul>`;
}

function renderChart() {
  if (angleChart) angleChart.destroy();
  els.chartEmpty.hidden = true;
  const hitTime = analysis.frames[analysis.hitIndex]?.time;
  const labels = analysis.frames.map(frame => frame.time.toFixed(2));
  const datasets = [
    { label: "利き腕の肘", data: analysis.frames.map(f => finiteOrNull(f.metrics?.elbow)), borderWidth: 2, pointRadius: 0, tension: 0.25 },
    { label: "膝（左右平均）", data: analysis.frames.map(f => finiteOrNull(f.metrics?.knee)), borderWidth: 2, pointRadius: 0, tension: 0.25 },
    { label: "肩の傾き", data: analysis.frames.map(f => finiteOrNull(f.metrics?.shoulderTilt)), borderWidth: 2, pointRadius: 0, tension: 0.25 },
    { label: "体幹の左右傾き", data: analysis.frames.map(f => finiteOrNull(f.metrics?.trunkLean)), borderWidth: 2, pointRadius: 0, tension: 0.25 }
  ];

  const hitLinePlugin = {
    id: "hitLine",
    afterDatasetsDraw(chart) {
      if (!Number.isFinite(hitTime)) return;
      const xScale = chart.scales.x;
      const index = analysis.hitIndex;
      const x = xScale.getPixelForValue(index);
      const { top, bottom } = chart.chartArea;
      const c = chart.ctx;
      c.save();
      c.strokeStyle = "rgba(220, 38, 38, .85)";
      c.lineWidth = 2;
      c.setLineDash([6, 5]);
      c.beginPath();
      c.moveTo(x, top);
      c.lineTo(x, bottom);
      c.stroke();
      c.restore();
    }
  };

  angleChart = new Chart(els.angleChart, {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: { title: { display: true, text: "時刻（秒）" }, ticks: { maxTicksLimit: 9 } },
        y: { title: { display: true, text: "角度（°）" }, suggestedMin: -20, suggestedMax: 180 }
      },
      plugins: {
        legend: { position: "bottom", labels: { boxWidth: 14, usePointStyle: true } },
        tooltip: { callbacks: { title: items => `${items[0].label} 秒` } }
      }
    },
    plugins: [hitLinePlugin]
  });
}

function finiteOrNull(value) {
  return Number.isFinite(value) ? Number(value.toFixed(2)) : null;
}

function renderPhases() {
  els.phaseButtons.innerHTML = "";
  for (const phase of analysis.phases) {
    const frame = analysis.frames[phase.index];
    const button = document.createElement("button");
    button.className = "phase-button";
    button.textContent = `${phase.label} ${formatTime(frame.time)}秒`;
    button.addEventListener("click", () => seekVideo(frame.time));
    els.phaseButtons.appendChild(button);
  }
}

function setManualHit() {
  if (!analysis) return;
  const index = nearestFrameIndex(els.sourceVideo.currentTime);
  if (index < 0) return;
  analysis.hitIndex = index;
  analysis.phases = estimatePhases(analysis.frames, index);
  renderResults();
  drawCachedPoseAtTime(els.sourceVideo.currentTime);
  setNotice(`打点を ${formatTime(analysis.frames[index].time)} 秒に修正しました。`, "success");
}

function exportCsv() {
  if (!analysis) return;
  const headers = [
    "時刻_秒", "肘角度_度", "膝角度平均_度", "左膝角度_度", "右膝角度_度",
    "肩傾き_度", "骨盤傾き_度", "体幹左右傾き_度", "手首X", "手首Y", "骨格検出",
    "打点候補"
  ];
  const rows = analysis.frames.map((frame, index) => {
    const m = frame.metrics || {};
    return [
      frame.time.toFixed(3), csvNumber(m.elbow), csvNumber(m.knee), csvNumber(m.leftKnee), csvNumber(m.rightKnee),
      csvNumber(m.shoulderTilt), csvNumber(m.hipTilt), csvNumber(m.trunkLean), csvNumber(m.wristX, 5),
      csvNumber(m.wristY, 5), frame.landmarks ? 1 : 0, index === analysis.hitIndex ? 1 : 0
    ];
  });
  const csv = "\ufeff" + [headers, ...rows].map(row => row.join(",")).join("\r\n");
  downloadBlob(new Blob([csv], { type: "text/csv;charset=utf-8" }), `volley-motion-${Date.now()}.csv`);
}

function csvNumber(value, digits = 2) {
  return Number.isFinite(value) ? value.toFixed(digits) : "";
}

function exportCurrentImage() {
  const video = els.sourceVideo;
  if (!video.videoWidth) return;
  const output = document.createElement("canvas");
  output.width = video.videoWidth;
  output.height = video.videoHeight;
  const outputCtx = output.getContext("2d");
  outputCtx.drawImage(video, 0, 0, output.width, output.height);
  drawCachedPoseAtTime(video.currentTime);
  outputCtx.drawImage(els.overlayCanvas, 0, 0, output.width, output.height);
  output.toBlob(blob => blob && downloadBlob(blob, `volley-motion-frame-${formatTime(video.currentTime)}s.png`), "image/png");
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function parseYouTubeId(urlText) {
  try {
    const url = new URL(urlText.trim());
    if (url.hostname === "youtu.be") return url.pathname.split("/").filter(Boolean)[0] || null;
    if (url.hostname.includes("youtube.com")) {
      if (url.pathname === "/watch") return url.searchParams.get("v");
      const parts = url.pathname.split("/").filter(Boolean);
      const markerIndex = parts.findIndex(part => ["shorts", "embed", "live"].includes(part));
      if (markerIndex >= 0) return parts[markerIndex + 1] || null;
    }
  } catch (_) {
    return /^[A-Za-z0-9_-]{11}$/.test(urlText.trim()) ? urlText.trim() : null;
  }
  return null;
}

function loadYouTube() {
  const id = parseYouTubeId(els.youtubeUrl.value);
  if (!id) {
    setNotice("YouTube URLを確認してください。通常動画・Shorts・youtu.be形式に対応しています。", "error");
    return;
  }
  const origin = location.protocol.startsWith("http") ? `&origin=${encodeURIComponent(location.origin)}` : "";
  els.youtubeFrame.src = `https://www.youtube.com/embed/${encodeURIComponent(id)}?playsinline=1&rel=0${origin}`;
  els.youtubeFrame.hidden = false;
  els.youtubePlaceholder.hidden = true;
  els.youtubeFrameWrap.classList.remove("empty");
  setNotice("YouTube参考動画を表示しました。解析動画と並べて目視比較できます。", "success");
}

els.dropZone.addEventListener("click", () => els.videoFile.click());
els.dropZone.addEventListener("keydown", event => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    els.videoFile.click();
  }
});
els.dropZone.addEventListener("dragover", event => { event.preventDefault(); els.dropZone.classList.add("dragover"); });
els.dropZone.addEventListener("dragleave", () => els.dropZone.classList.remove("dragover"));
els.dropZone.addEventListener("drop", event => {
  event.preventDefault();
  els.dropZone.classList.remove("dragover");
  handleFile(event.dataTransfer.files?.[0]);
});
els.videoFile.addEventListener("change", () => handleFile(els.videoFile.files?.[0]));
els.sourceVideo.addEventListener("loadedmetadata", onVideoLoaded);
els.sourceVideo.addEventListener("error", () => setNotice("この動画形式をブラウザで再生できません。MP4（H.264）への変換をお試しください。", "error"));
els.analyzeButton.addEventListener("click", analyzeVideo);
els.cancelButton.addEventListener("click", () => { cancelRequested = true; });
els.playPauseButton.addEventListener("click", () => els.sourceVideo.paused ? els.sourceVideo.play() : els.sourceVideo.pause());
els.prevFrameButton.addEventListener("click", () => seekVideo(els.sourceVideo.currentTime - 1 / DISPLAY_FPS));
els.nextFrameButton.addEventListener("click", () => seekVideo(els.sourceVideo.currentTime + 1 / DISPLAY_FPS));
els.timeline.addEventListener("input", () => {
  if (els.sourceVideo.duration) els.sourceVideo.currentTime = Number(els.timeline.value) / 1000 * els.sourceVideo.duration;
});
els.playbackRate.addEventListener("change", () => { els.sourceVideo.playbackRate = Number(els.playbackRate.value); });
els.jumpHitButton.addEventListener("click", () => {
  if (analysis?.hitIndex >= 0) seekVideo(analysis.frames[analysis.hitIndex].time);
});
els.setHitButton.addEventListener("click", setManualHit);
els.skeletonToggle.addEventListener("change", () => drawCachedPoseAtTime(els.sourceVideo.currentTime));
els.loadYoutubeButton.addEventListener("click", loadYouTube);
els.youtubeUrl.addEventListener("keydown", event => { if (event.key === "Enter") loadYouTube(); });
els.exportCsvButton.addEventListener("click", exportCsv);
els.exportImageButton.addEventListener("click", exportCurrentImage);
els.modelQuality.addEventListener("change", () => {
  if (loadedModelQuality && loadedModelQuality !== els.modelQuality.value) {
    setModelStatus("再読込が必要", "idle");
  }
});

window.addEventListener("beforeunload", () => {
  if (sourceObjectUrl) URL.revokeObjectURL(sourceObjectUrl);
  if (poseLandmarker) poseLandmarker.close();
});
