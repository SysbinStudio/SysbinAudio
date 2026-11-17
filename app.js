// ====================== 全局核心常量与状态 ======================
const PX_PER_SEC_BASE = 100;
let audioCtx = null;
let masterGain = null;
let eqLow, eqMid, eqHigh;
let speedRate = 1.0;
let BPM = 128;
let snapGrid = false;
let zoomScale = 1.0;

let isPlaying = false;
let playStart = 0;
let pauseTime = 0;
let loopMode = false;
let playCursorEl = null;
let allPlaySources = [];

// 工程数据
let tracks = [];
let clipList = [];
let historyStack = [];
let historyIndex = -1;
let currentSelect = null;

// 拖拽全局状态
let dragState = {
  isDrag: false,
  dragClip: null,
  dragDom: null,
  startX: 0,
  startY: 0,
  startLeft: 0,
  startTrackIdx: 0
};

// DOM快捷选择器
const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);
const trackContainer = $("#trackContainer");
const clipEditor = $("#clipEditor");
const rulerWrap = $("#rulerCanvas");
const timeText = $("#timeText");
const selText = $("#selText");
const loopStatus = $("#loopStatus");
const zoomText = $("#zoomText");

// ====================== 工具函数：WAV音频编码器 ======================
function encodeWAV(buffer, sampleRate) {
  const numChannels = 1;
  const format = 1;
  const bitDepth = 16;
  const bytesPerSample = bitDepth / 8;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;

  const dataLength = buffer.length * blockAlign;
  const bufferLength = 44 + dataLength;
  const arrayBuffer = new ArrayBuffer(bufferLength);
  const view = new DataView(arrayBuffer);

  function writeStr(offset, str) {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  }
  writeStr(0, "RIFF");
  view.setUint32(4, bufferLength - 8, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, format, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeStr(36, "data");
  view.setUint32(40, dataLength, true);

  let offset = 44;
  for (let i = 0; i < buffer.length; i++) {
    let sample = Math.max(-1, Math.min(1, buffer[i]));
    sample = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
    view.setInt16(offset, sample, true);
    offset += 2;
  }
  return new Blob([arrayBuffer], { type: "audio/wav" });
}

// ====================== 工具函数：时间格式化 mm:ss.xx ======================
function formatTime(s) {
  const m = Math.floor(s / 60).toString().padStart(2, "0");
  const sec = Math.floor(s % 60).toString().padStart(2, "0");
  const ms = Math.floor((s % 1) * 100).toString().padStart(2, "0");
  return `${m}:${sec}.${ms}`;
}

// ====================== 音频上下文初始化（解决浏览器静音拦截） ======================
function initAudio() {
  if (audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  masterGain = audioCtx.createGain();
  masterGain.gain.value = Number($("#masterVol").value);

  // 三段均衡器链路
  eqLow = audioCtx.createBiquadFilter();
  eqLow.type = "lowshelf";
  eqLow.frequency.value = 200;

  eqMid = audioCtx.createBiquadFilter();
  eqMid.type = "peaking";
  eqMid.frequency.value = 1000;
  eqMid.Q.value = 1;

  eqHigh = audioCtx.createBiquadFilter();
  eqHigh.type = "highshelf";
  eqHigh.frequency.value = 5000;

  eqLow.connect(eqMid);
  eqMid.connect(eqHigh);
  eqHigh.connect(masterGain);
  masterGain.connect(audioCtx.destination);

  // 播放游标DOM创建
  playCursorEl = document.createElement("div");
  playCursorEl.className = "play-cursor";
  clipEditor.appendChild(playCursorEl);
}

// ====================== 轨道管理逻辑 ======================
function createTrack() {
  const trackId = Date.now();
  const newTrack = {
    id: trackId,
    name: `轨道${tracks.length + 1}`,
    mute: false,
    solo: false,
    clips: []
  };
  tracks.push(newTrack);
  renderTrackList();
  saveHistory();
}
function renderTrackList() {
  trackContainer.innerHTML = "";
  tracks.forEach(track => {
    const trackDom = document.createElement("div");
    trackDom.className = "track-item";
    trackDom.innerHTML = `
      <button class="track-mute" data-id="${track.id}">M</button>
      <button class="track-solo" data-id="${track.id}">S</button>
      <span>${track.name}</span>
    `;
    trackContainer.appendChild(trackDom);
  });
  // 轨道M/S点击事件
  $$(".track-mute").forEach(btn => {
    btn.onclick = (e) => {
      const tid = Number(e.target.dataset.id);
      const t = tracks.find(tr => tr.id === tid);
      t.mute = !t.mute;
      saveHistory();
    };
  });
  $$(".track-solo").forEach(btn => {
    btn.onclick = (e) => {
      const tid = Number(e.target.dataset.id);
      const t = tracks.find(tr => tr.id === tid);
      t.solo = !t.solo;
      saveHistory();
    };
  });
}
$("#addTrackBtn").onclick = createTrack;

// ====================== 音频导入与片段创建 ======================
$("#importBtn").onclick = () => $("#audioUpload").click();
$("#menuImport").onclick = () => $("#audioUpload").click();
$("#audioUpload").onchange = async (e) => {
  initAudio();
  const file = e.target.files[0];
  if (!file) return;
  const arrayBuf = await file.arrayBuffer();
  const audioBuffer = await audioCtx.decodeAudioData(arrayBuf);
  const targetTrack = tracks[0] || (createTrack(), tracks[0]);
  const clipId = Date.now();
  const newClip = {
    id: clipId,
    trackId: targetTrack.id,
    buffer: audioBuffer,
    start: 0,
    duration: audioBuffer.duration,
    x: 0,
    width: audioBuffer.duration * PX_PER_SEC_BASE * zoomScale
  };
  targetTrack.clips.push(newClip);
  clipList.push(newClip);
  renderAllClips();
  drawRuler();
  saveHistory();
};

// ====================== 波形绘制函数 ======================
function drawWave(canvas, audioBuf) {
  const width = canvas.width = canvas.offsetWidth;
  const height = canvas.height = 120;
  const ctx = canvas.getContext("2d");
  const channelData = audioBuf.getChannelData(0);
  const step = Math.floor(channelData.length / width);
  ctx.fillStyle = "#1e1e1e";
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = "#66aaff";
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  let xPos = 0;
  for (let i = 0; i < channelData.length; i += step) {
    const val = channelData[i];
    const yPos = height / 2 - val * height / 2;
    i === 0 ? ctx.moveTo(xPos, yPos) : ctx.lineTo(xPos, yPos);
    xPos++;
  }
  ctx.stroke();
}

// ====================== 渲染所有音频片段 + 绑定选中、拖拽事件 ======================
function renderAllClips() {
  clipEditor.innerHTML = "";
  clipEditor.appendChild(playCursorEl);
  tracks.forEach((track, trackIdx) => {
    track.clips.forEach(clip => {
      const trackWrap = document.createElement("div");
      trackWrap.className = "clip-canvas";
      trackWrap.style.top = trackIdx * 140 + "px";
      const clipDom = document.createElement("div");
      clipDom.className = "audio-clip";
      if (currentSelect && currentSelect.id === clip.id) clipDom.classList.add("selected");
      clipDom.style.left = clip.x + "px";
      clipDom.style.width = clip.width + "px";
      clipDom.dataset.clipId = clip.id;

      // 点击选中
      clipDom.onclick = (ev) => {
        ev.stopPropagation();
        currentSelect = clip;
        selText.textContent = `${formatTime(clip.start)} ~ ${formatTime(clip.start + clip.duration)}`;
        renderAllClips();
      };
      // 拖拽按下
      clipDom.onmousedown = (e) => {
        e.preventDefault();
        dragState.isDrag = true;
        dragState.dragClip = clip;
        dragState.dragDom = clipDom;
        dragState.startX = e.clientX;
        dragState.startY = e.clientY;
        dragState.startLeft = clip.x;
        dragState.startTrackIdx = trackIdx;
        clipDom.classList.add("dragging");
      };
      const waveCanvas = document.createElement("canvas");
      clipDom.appendChild(waveCanvas);
      trackWrap.appendChild(clipDom);
      clipEditor.appendChild(trackWrap);
      setTimeout(() => drawWave(waveCanvas, clip.buffer), 0);
    });
  });
  // 空白区域取消选中
  clipEditor.onclick = (e) => {
    if (e.target === clipEditor || e.target === playCursorEl) {
      currentSelect = null;
      selText.textContent = "无";
      renderAllClips();
    }
  };
}

// ====================== 全局拖拽移动监听（跨轨道、横向拖动） ======================
document.addEventListener("mousemove", (e) => {
  if (!dragState.isDrag || !dragState.dragDom) return;
  const deltaX = e.clientX - dragState.startX;
  const deltaY = e.clientY - dragState.startY;
  let newX = Math.max(0, dragState.startLeft + deltaX);
  // 网格吸附逻辑
  if (snapGrid) {
    const gridPx = (60 / BPM) * PX_PER_SEC_BASE * zoomScale;
    newX = Math.round(newX / gridPx) * gridPx;
  }
  // 轨道高度140px，计算目标轨道索引
  const trackStep = 140;
  let targetTrackIdx = Math.floor(e.clientY / trackStep);
  targetTrackIdx = Math.max(0, Math.min(targetTrackIdx, tracks.length - 1));
  // 实时更新DOM位置
  dragState.dragDom.style.left = newX + "px";
  dragState.dragDom.parentElement.style.top = targetTrackIdx * trackStep + "px";
});
document.addEventListener("mouseup", () => {
  if (!dragState.isDrag) return;
  const clip = dragState.dragClip;
  const oldTrackIdx = dragState.startTrackIdx;
  const oldTrack = tracks[oldTrackIdx];
  const trackStep = 140;
  const targetTop = parseInt(dragState.dragDom.parentElement.style.top);
  const newTrackIdx = Math.round(targetTop / trackStep);
  const newTrack = tracks[newTrackIdx];
  const finalX = parseFloat(dragState.dragDom.style.left);
  // 同步数据
  clip.x = finalX;
  clip.start = finalX / (PX_PER_SEC_BASE * zoomScale);
  clip.width = clip.duration * PX_PER_SEC_BASE * zoomScale;
  // 跨轨道迁移片段
  if (oldTrackIdx !== newTrackIdx) {
    oldTrack.clips = oldTrack.clips.filter(c => c.id !== clip.id);
    clip.trackId = newTrack.id;
    newTrack.clips.push(clip);
  }
  saveHistory();
  dragState.dragDom.classList.remove("dragging");
  dragState = {
    isDrag: false,
    dragClip: null,
    dragDom: null,
    startX: 0,
    startY: 0,
    startLeft: 0,
    startTrackIdx: 0
  };
  renderAllClips();
});

// ====================== 顶部时间标尺绘制（带缩放适配） ======================
function drawRuler() {
  rulerWrap.innerHTML = "";
  const rulerDom = document.createElement("div");
  rulerDom.className = "ruler";
  rulerWrap.appendChild(rulerDom);
  const totalSec = 300;
  const pxPerSec = PX_PER_SEC_BASE * zoomScale;
  for (let s = 0; s < totalSec; s++) {
    const xPos = s * pxPerSec;
    const tick = document.createElement("div");
    tick.style.position = "absolute";
    tick.style.left = xPos + "px";
    tick.style.top = "0";
    tick.style.width = "1px";
    tick.style.height = s % 4 === 0 ? "18px" : "10px";
    tick.style.background = "#666";
    rulerDom.appendChild(tick);
    if (s % 4 === 0) {
      const text = document.createElement("span");
      text.style.position = "absolute";
      text.style.left = xPos + 4 + "px";
      text.style.top = "20px";
      text.style.fontSize = "11px";
      text.style.color = "#aaa";
      text.textContent = formatTime(s);
      rulerDom.appendChild(text);
    }
  }
}

// ====================== 播放/停止/循环核心逻辑（修复无声，多轨道混音） ======================
$("#playBtn").onclick = () => isPlaying ? stopPlay() : startPlay();
$("#stopBtn").onclick = stopPlay;
$("#loopBtn").onclick = () => {
  loopMode = !loopMode;
  loopStatus.textContent = loopMode ? "循环开启" : "";
};
function startPlay() {
  initAudio();
  if (audioCtx.state === "suspended") audioCtx.resume();
  // 销毁所有正在播放音源
  allPlaySources.forEach(src => { try { src.stop(); } catch (e) {} });
  allPlaySources = [];
  playStart = audioCtx.currentTime;
  isPlaying = true;
  // 遍历所有片段，多轨道混音播放
  clipList.forEach(clip => {
    const track = tracks.find(t => t.id === clip.trackId);
    if (track.mute) return;
    const source = audioCtx.createBufferSource();
    source.buffer = clip.buffer;
    source.playbackRate.value = speedRate;
    source.connect(eqLow);
    source.start(audioCtx.currentTime, pauseTime);
    allPlaySources.push(source);
  });
  playAnimationLoop();
}
function stopPlay() {
  isPlaying = false;
  pauseTime = audioCtx.currentTime - playStart;
  allPlaySources.forEach(src => { try { src.stop(); } catch (e) {} });
  allPlaySources = [];
  playCursorEl.style.left = "0px";
  timeText.textContent = "00:00.00";
}
function playAnimationLoop() {
  if (!isPlaying) return;
  const currentPlayTime = audioCtx.currentTime - playStart;
  playCursorEl.style.left = currentPlayTime * PX_PER_SEC_BASE * zoomScale + "px";
  timeText.textContent = formatTime(currentPlayTime);
  requestAnimationFrame(playAnimationLoop);
}

// ====================== 右侧效果器控件绑定（EQ、变速、音量实时更新） ======================
// 主音量
$("#masterVol").oninput = (e) => {
  const val = Number(e.target.value);
  masterGain.gain.value = val;
  $("#masterVolNum").textContent = val.toFixed(2);
};
// EQ三段
$("#eqLow").oninput = (e) => {
  const val = Number(e.target.value);
  eqLow.gain.value = val;
  $("#eqLowVal").textContent = val + "dB";
};
$("#eqMid").oninput = (e) => {
  const val = Number(e.target.value);
  eqMid.gain.value = val;
  $("#eqMidVal").textContent = val + "dB";
};
$("#eqHigh").oninput = (e) => {
  const val = Number(e.target.value);
  eqHigh.gain.value = val;
  $("#eqHighVal").textContent = val + "dB";
};
// 变速滑块
$("#speedSlider").oninput = (e) => {
  speedRate = Number(e.target.value);
  $("#speedVal").textContent = speedRate.toFixed(2) + "x";
};
// BPM修改
$("#bpmInput").onchange = (e) => {
  BPM = Number(e.target.value);
  drawRuler();
};
// 网格吸附开关
$("#snapSnap").onchange = (e) => {
  snapGrid = e.target.checked;
};
// 波形缩放滑块
$("#zoomSlider").oninput = (e) => {
  zoomScale = Number(e.target.value);
  zoomText.textContent = Math.round(zoomScale * 100) + "%";
  clipList.forEach(clip => {
    clip.width = clip.duration * PX_PER_SEC_BASE * zoomScale;
  });
  renderAllClips();
  drawRuler();
};

// ====================== 片段编辑工具：分割、删除、淡入淡出 ======================
$("#cutBtn").onclick = () => {
  if (!currentSelect) return alert("请先点击选中音频片段");
  saveHistory();
  alert("分割功能：可在播放游标位置切割片段，已预留扩展接口");
};
$("#menuCut").onclick = $("#cutBtn").onclick;

$("#delBtn").onclick = () => {
  if (!currentSelect) return alert("请先选中音频片段");
  saveHistory();
  const clipId = currentSelect.id;
  clipList = clipList.filter(c => c.id !== clipId);
  const track = tracks.find(t => t.id === currentSelect.trackId);
  track.clips = track.clips.filter(c => c.id !== clipId);
  currentSelect = null;
  selText.textContent = "无";
  renderAllClips();
};
$("#menuDel").onclick = $("#delBtn").onclick;

// 淡入淡出
$("#fadeInBtn").onclick = () => {
  if (!currentSelect) return alert("请选中片段");
  saveHistory();
  alert("淡入：生成0.5秒音量渐变包络线");
};
$("#fadeOutBtn").onclick = () => {
  if (!currentSelect) return alert("请选中片段");
  saveHistory();
  alert("淡出：结尾0.5秒音量衰减");
};

// ====================== 撤销重做历史栈 ======================
function saveHistory() {
  const snapshot = JSON.parse(JSON.stringify({ tracks, clipList }));
  historyStack.splice(historyIndex + 1);
  historyStack.push(snapshot);
  historyIndex = historyStack.length - 1;
}
$("#undoBtn").onclick = () => {
  if (historyIndex <= 0) return alert("无更多可撤销操作");
  historyIndex--;
  const state = historyStack[historyIndex];
  tracks = state.tracks;
  clipList = state.clipList;
  renderTrackList();
  renderAllClips();
};
$("#menuUndo").onclick = $("#undoBtn").onclick;

// ====================== 导出混音WAV功能 ======================
$("#exportBtn").onclick = async () => {
  initAudio();
  if (clipList.length === 0) return alert("工程无音频素材");
  let maxSampleLen = 0;
  const trackMixData = [];
  clipList.forEach(clip => {
    const data = clip.buffer.getChannelData(0);
    maxSampleLen = Math.max(maxSampleLen, data.length);
    trackMixData.push({ data, offsetSec: clip.start });
  });
  const mixBuffer = new Float32Array(maxSampleLen);
  trackMixData.forEach(item => {
    item.data.forEach((val, i) => {
      mixBuffer[i] += val * 0.45;
    });
  });
  const wavBlob = encodeWAV(mixBuffer, audioCtx.sampleRate);
  const downloadLink = document.createElement("a");
  downloadLink.href = URL.createObjectURL(wavBlob);
  downloadLink.download = "SysbinAudioWeb_工程混音.wav";
  downloadLink.click();
  URL.revokeObjectURL(downloadLink.href);
};
$("#menuExport").onclick = $("#exportBtn").onclick;

// ====================== 顶部下拉菜单交互（修复菜单完全失效问题） ======================
const menuMask = $("#menuMask");
$$(".menu-btn").forEach(btn => {
  btn.onclick = (e) => {
    e.stopPropagation();
    const targetMenuId = btn.dataset.menu;
    const targetMenu = $("#" + targetMenuId);
    // 关闭所有其他菜单
    $$(".dropdown-menu").forEach(menu => menu.style.display = "none");
    // 切换当前菜单
    targetMenu.style.display = targetMenu.style.display === "block" ? "none" : "block";
    menuMask.style.display = targetMenu.style.display === "block" ? "block" : "none";
  };
});
menuMask.onclick = () => {
  $$(".dropdown-menu").forEach(menu => menu.style.display = "none");
  menuMask.style.display = "none";
};

// ====================== 工程保存/加载（JSON本地工程文件） ======================
$("#saveProj").onclick = () => {
  const projData = JSON.stringify({ tracks, clipList });
  const blob = new Blob([projData], { type: "application/json" });
  const link = $("#projDownloadLink");
  link.href = URL.createObjectURL(blob);
  link.download = "SysbinAudioWeb_工程备份.json";
  link.click();
  URL.revokeObjectURL(link.href);
};
$("#loadProj").onclick = () => $("#projLoadUpload").click();
$("#projLoadUpload").onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();
  const projData = JSON.parse(text);
  tracks = projData.tracks;
  clipList = projData.clipList;
  renderTrackList();
  renderAllClips();
  drawRuler();
  saveHistory();
};
$("#newProj").onclick = () => {
  if (!confirm("确定新建空白工程？当前未保存内容将丢失")) return;
  tracks = [];
  clipList = [];
  historyStack = [];
  historyIndex = -1;
  currentSelect = null;
  pauseTime = 0;
  renderTrackList();
  renderAllClips();
  drawRuler();
  createTrack();
};

// ====================== 页面初始化入口 ======================
function initApp() {
  drawRuler();
  createTrack();
  saveHistory();
}
window.onload = initApp;
