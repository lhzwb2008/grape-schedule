const state = {
  token: localStorage.getItem("gs_token") || "",
  member: JSON.parse(localStorage.getItem("gs_member") || "null"),
  members: [],
  selected: null,
  sessions: [],
  currentId: null,
  sending: false,
  recording: false,
  asrBusy: false,
  voiceMode: false, // 默认打字；语音为可选
  cancelRecord: false,
  autoTts: localStorage.getItem("gs_auto_tts") === "1",
  attachments: [],
};

const MAX_ATTACH = 5;
const MAX_FILE_SIZE = 12 * 1024 * 1024;

const $ = (sel) => document.querySelector(sel);
const loginView = $("#login-view");
const chatView = $("#chat-view");
const memberGrid = $("#member-grid");
const loginError = $("#login-error");
const sessionList = $("#session-list");
const messagesEl = $("#messages");
const welcomeEl = $("#welcome");
const inputEl = $("#input");
const sendBtn = $("#send-btn");
const stopBtn = $("#stop-btn");
const chatTitle = $("#chat-title");
const deleteBtn = $("#delete-session-btn");
const autoTtsBtn = $("#auto-tts-btn");
const sidebar = $("#sidebar");
const sidebarMask = $("#sidebar-mask");
const menuBtn = $("#menu-btn");
const sidebarClose = $("#sidebar-close");
const modeBtn = $("#mode-btn");
const holdBtn = $("#hold-btn");
const voiceHint = $("#voice-hint");
const voiceOverlay = $("#voice-overlay");
const secureHint = $("#secure-hint");
const todayStrip = $("#today-strip");
const fileInput = $("#file-input");
const attachPreview = $("#attach-preview");
const attachBtn = $("#attach-btn");

let mediaRecorder = null;
let mediaStream = null;
let recordChunks = [];
let currentAudio = null;
let sharedAudio = null;
let audioUnlocked = false;
let ttsPlayToken = 0;
let chatAbort = null;
let recordMode = "none";
let audioCtx = null;
let audioProcessor = null;
let audioSource = null;
let wavBuffers = [];
let wavSampleRate = 16000;
let holdStartY = 0;
let holding = false;
let recSession = 0;

if (window.marked) marked.setOptions({ breaks: true, gfm: true });

function openSidebar() {
  sidebar?.classList.add("open");
  sidebarMask?.classList.add("show");
  if (sidebarMask) sidebarMask.hidden = false;
}
function closeSidebar() {
  sidebar?.classList.remove("open");
  sidebarMask?.classList.remove("show");
  if (sidebarMask) sidebarMask.hidden = true;
}
menuBtn?.addEventListener("click", openSidebar);
sidebarClose?.addEventListener("click", closeSidebar);
sidebarMask?.addEventListener("click", closeSidebar);

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderMarkdown(text) {
  const raw = String(text || "");
  if (!window.marked || !window.DOMPurify) return escapeHtml(raw).replaceAll("\n", "<br>");
  return DOMPurify.sanitize(marked.parse(raw), { USE_PROFILES: { html: true } });
}

function setBubbleContent(el, text, { markdown = false, streaming = false } = {}) {
  el.dataset.rawText = text || "";
  if (markdown && el.classList.contains("assistant")) {
    el.innerHTML = `<div class="md">${renderMarkdown(text)}</div>`;
  } else {
    el.textContent = text;
  }
  el.classList.toggle("streaming", !!streaming);
  // 不再挂单条语音按钮；仅顶部总开关自动播报
  if (el.classList.contains("assistant") && !streaming && text && state.autoTts) {
    prefetchFirstTts(el);
  }
}

function stopCurrentAudio() {
  ttsPlayToken += 1;
  if (currentAudio) {
    try { currentAudio.pause(); currentAudio.currentTime = 0; } catch {}
    currentAudio = null;
  }
}

function abortAll() {
  try { chatAbort?.abort(); } catch {}
  stopCurrentAudio();
  state.sending = false;
  state.asrBusy = false;
  try { setRecordingUi(false); } catch {}
  voiceOverlay?.classList.add("hidden");
  if (holdBtn) holdBtn.textContent = "按住 说话";
  updateSendState();
}

async function unlockAudioPlayback() {
  try {
    if (!sharedAudio) sharedAudio = new Audio();
    sharedAudio.src = "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA";
    sharedAudio.volume = 0.01;
    await sharedAudio.play();
    sharedAudio.pause();
    sharedAudio.currentTime = 0;
    audioUnlocked = true;
  } catch { audioUnlocked = false; }
}

function stripTextForSpeech(text) {
  return String(text || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]+`/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/[*_]{1,3}/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function splitSpeechSegments(text, maxChars = 72) {
  const clean = stripTextForSpeech(text).replace(/(\d)\.(\d)/g, "$1点$2");
  if (!clean) return [];
  const parts = [];
  let buf = "";
  for (let i = 0; i < clean.length; i++) {
    buf += clean[i];
    const atBreak = "。！？；!?\n".includes(clean[i]);
    if ((atBreak || buf.length >= maxChars) && buf.trim()) {
      parts.push(buf.trim());
      buf = "";
    }
  }
  if (buf.trim()) parts.push(buf.trim());
  return parts;
}

async function fetchTtsBlob(text) {
  const res = await fetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${state.token}` },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `语音合成失败 ${res.status}`);
  }
  return res.blob();
}

function playBlob(blob) {
  return new Promise((resolve, reject) => {
    if (!sharedAudio) sharedAudio = new Audio();
    const audio = sharedAudio;
    const url = URL.createObjectURL(blob);
    const finish = (err) => {
      audio.onended = null;
      audio.onerror = null;
      if (currentAudio === audio) currentAudio = null;
      URL.revokeObjectURL(url);
      err ? reject(err) : resolve();
    };
    audio.pause();
    audio.src = url;
    currentAudio = audio;
    audio.onended = () => finish();
    audio.onerror = () => finish(new Error("播放失败"));
    audio.play().then(() => { audioUnlocked = true; }).catch(finish);
  });
}

function prefetchFirstTts(bubble) {
  if (!state.autoTts || !bubble) return;
  const segs = splitSpeechSegments(bubble.dataset.rawText || "");
  const first = segs[0];
  if (!first) return;
  if (bubble.dataset.ttsPrefetch === first) return;
  bubble.dataset.ttsPrefetch = first;
  const p = fetchTtsBlob(first)
    .then((blob) => {
      bubble._ttsPrefetch = { text: first, blob };
      return bubble._ttsPrefetch;
    })
    .catch(() => {
      bubble._ttsPrefetch = null;
      return null;
    });
  bubble._ttsPrefetchPromise = p;
}

async function playTts(bubble, { auto = false } = {}) {
  const text = (bubble.dataset.rawText || "").trim();
  if (!text || text.startsWith("抱歉") || text.startsWith("（已停止）")) return;
  stopCurrentAudio();
  const token = ttsPlayToken;
  try {
    if (auto && !audioUnlocked) await unlockAudioPlayback();
    const segments = splitSpeechSegments(text);
    let nextFetch = null;
    for (let i = 0; i < segments.length; i++) {
      if (token !== ttsPlayToken) return;
      const seg = segments[i];
      let blob;
      const pref = bubble._ttsPrefetch;
      if (i === 0 && pref?.text === seg && pref.blob) {
        blob = pref.blob;
        bubble._ttsPrefetch = null;
      } else if (i === 0 && bubble._ttsPrefetchPromise && bubble.dataset.ttsPrefetch === seg) {
        const r = await bubble._ttsPrefetchPromise;
        blob = r?.blob;
        bubble._ttsPrefetch = null;
      } else if (nextFetch) {
        blob = await nextFetch;
        nextFetch = null;
      } else {
        blob = await fetchTtsBlob(seg);
      }
      if (i + 1 < segments.length) {
        const nxt = segments[i + 1];
        nextFetch = fetchTtsBlob(nxt);
      }
      if (token !== ttsPlayToken) return;
      if (blob) await playBlob(blob);
    }
  } catch (err) {
    if (!auto) console.warn(err);
  } finally {
    updateSendState();
  }
}

function maybeAutoPlayTts(bubble) {
  if (!state.autoTts || !bubble) return;
  playTts(bubble, { auto: true });
}

function syncAutoTtsButton() {
  if (!autoTtsBtn) return;
  autoTtsBtn.classList.toggle("on", state.autoTts);
  autoTtsBtn.textContent = state.autoTts ? "🔊" : "🔇";
}
autoTtsBtn?.addEventListener("click", async () => {
  state.autoTts = !state.autoTts;
  localStorage.setItem("gs_auto_tts", state.autoTts ? "1" : "0");
  syncAutoTtsButton();
  if (state.autoTts) await unlockAudioPlayback();
  else stopCurrentAudio();
});
syncAutoTtsButton();

function isSecureForMic() {
  if (window.isSecureContext) return true;
  const host = location.hostname;
  return host === "localhost" || host === "127.0.0.1";
}
// 本项目专用 HTTPS 域名（与 grape-doctor 的 <ip>.sslip.io 分离）
let publicHttpsUrl = "https://grape-schedule.101.201.237.149.sslip.io/";

function httpsEntryUrl() {
  const host = location.hostname;
  // 已在本项目 HTTPS 域名上
  if (host.includes("grape-schedule") && (host.endsWith("sslip.io") || host.endsWith("nip.io"))) {
    return `https://${host}/`;
  }
  // 裸 IP 或其它入口：不要跳到 <ip>.sslip.io（那是家庭医生项目）
  return publicHttpsUrl;
}
function refreshSecureHint() {
  if (!secureHint) return;
  if (!isSecureForMic()) {
    const url = httpsEntryUrl();
    secureHint.innerHTML = `语音需本项目 HTTPS：<a href="${url}">${url}</a>（勿打开裸 IP 的 sslip.io）`;
    secureHint.classList.remove("hidden");
  } else secureHint.classList.add("hidden");
}

async function loadPublicHttps() {
  try {
    const data = await fetch("/api/health").then((r) => r.json());
    if (data?.https_url) publicHttpsUrl = data.https_url;
    else if (data?.https_host) publicHttpsUrl = `https://${data.https_host}/`;
  } catch {
    /* keep default */
  }
  refreshSecureHint();
}

function pickRecorderMime() {
  if (!window.MediaRecorder) return "";
  for (const m of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]) {
    try { if (MediaRecorder.isTypeSupported(m)) return m; } catch {}
  }
  return "";
}

function encodeWav(floatChunks, sampleRate) {
  let len = 0;
  for (const c of floatChunks) len += c.length;
  const samples = new Float32Array(len);
  let offset = 0;
  for (const c of floatChunks) { samples.set(c, offset); offset += c.length; }
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, "WAVE"); writeStr(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  writeStr(36, "data"); view.setUint32(40, samples.length * 2, true);
  let p = 44;
  for (let i = 0; i < samples.length; i++, p += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(p, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

function setVoiceMode(on) {
  state.voiceMode = !!on;
  // 统一用 .hidden class（勿只改 element.hidden，否则会与 HTML class="hidden" 打架）
  if (inputEl) {
    inputEl.hidden = false;
    inputEl.classList.toggle("hidden", state.voiceMode);
  }
  if (holdBtn) {
    holdBtn.hidden = false;
    holdBtn.classList.toggle("hidden", !state.voiceMode);
  }
  if (sendBtn) sendBtn.classList.toggle("hidden", state.voiceMode || state.sending);
  if (modeBtn) {
    modeBtn.textContent = state.voiceMode ? "⌨️" : "🎤";
    modeBtn.title = state.voiceMode ? "切换文字输入" : "切换语音输入（可选）";
    modeBtn.setAttribute("aria-label", state.voiceMode ? "切换文字输入" : "切换语音输入");
  }
  document.querySelector(".composer")?.classList.toggle("voice-mode", state.voiceMode);
  updateSendState();
}

function setRecordingUi(on, { canceling = false, recognizing = false } = {}) {
  state.recording = !!on && !recognizing;
  holdBtn?.classList.toggle("recording", on && !canceling && !recognizing);
  holdBtn?.classList.toggle("canceling", on && canceling);
  holdBtn?.classList.toggle("busy", recognizing);
  voiceOverlay?.classList.toggle("hidden", !on && !recognizing);
  voiceOverlay?.classList.toggle("canceling", canceling);
  if (voiceHint) {
    if (recognizing) voiceHint.textContent = "正在识别…";
    else if (canceling) voiceHint.textContent = "松开取消";
    else voiceHint.textContent = "松开发送，上滑取消";
  }
  if (holdBtn) {
    if (recognizing) holdBtn.textContent = "识别中…";
    else if (!on) holdBtn.textContent = "按住 说话";
    else holdBtn.textContent = canceling ? "松开 取消" : "松开 结束";
  }
}

function cleanupMic({ keepBuffers = false } = {}) {
  try { audioProcessor?.disconnect(); } catch {}
  try { audioSource?.disconnect(); } catch {}
  if (audioCtx) audioCtx.close().catch(() => {});
  audioProcessor = null;
  audioSource = null;
  audioCtx = null;
  try {
    if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
  } catch {}
  mediaStream?.getTracks().forEach((t) => t.stop());
  mediaStream = null;
  mediaRecorder = null;
  recordMode = "none";
  if (!keepBuffers) {
    recordChunks = [];
    wavBuffers = [];
  }
}

async function acquireMicStream() {
  if (!isSecureForMic()) throw new Error("请用 HTTPS 打开后再录音（本项目域名见上方提示）");
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("当前浏览器不支持麦克风");
  return navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
  });
}

/** 始终走 WAV：DashScope ASR 对 webm/opus 易误识别成「嗯」 */
async function beginCapture(session) {
  mediaStream = await acquireMicStream();
  if (session !== recSession) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
    return false;
  }

  recordChunks = [];
  wavBuffers = [];
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) {
    cleanupMic();
    throw new Error("当前浏览器无法录音，请换 Chrome / Safari 或升级微信");
  }
  audioCtx = new AC();
  if (audioCtx.state === "suspended") await audioCtx.resume();
  if (session !== recSession) {
    cleanupMic();
    return false;
  }
  audioSource = audioCtx.createMediaStreamSource(mediaStream);
  audioProcessor = audioCtx.createScriptProcessor(4096, 1, 1);
  wavSampleRate = audioCtx.sampleRate;
  audioProcessor.onaudioprocess = (e) => {
    wavBuffers.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  };
  const mute = audioCtx.createGain();
  mute.gain.value = 0;
  audioSource.connect(audioProcessor);
  audioProcessor.connect(mute);
  mute.connect(audioCtx.destination);
  recordMode = "wav";
  setRecordingUi(true);

  // 若用户在准备阶段已松手：录够最短时长后再结束，或取消
  if (pendingEnd) {
    const cancel = pendingEnd.cancel;
    pendingEnd = null;
    holding = false;
    if (cancel) {
      cleanupMic();
      setRecordingUi(false);
      return false;
    }
    await new Promise((r) => setTimeout(r, 700));
    await finishCapture({ cancel: false });
    return false;
  }
  return true;
}

function downsampleWav(floatChunks, fromRate, toRate = 16000) {
  let len = 0;
  for (const c of floatChunks) len += c.length;
  const merged = new Float32Array(len);
  let offset = 0;
  for (const c of floatChunks) {
    merged.set(c, offset);
    offset += c.length;
  }
  if (fromRate === toRate) return { samples: merged, sampleRate: toRate };
  const ratio = fromRate / toRate;
  const newLen = Math.max(1, Math.floor(merged.length / ratio));
  const out = new Float32Array(newLen);
  for (let i = 0; i < newLen; i++) out[i] = merged[Math.floor(i * ratio)] || 0;
  return { samples: out, sampleRate: toRate };
}

function encodeWavSamples(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr = (o, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, samples.length * 2, true);
  let p = 44;
  for (let i = 0; i < samples.length; i++, p += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(p, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

function audioRms(samples) {
  if (!samples.length) return 0;
  let sum = 0;
  const step = Math.max(1, Math.floor(samples.length / 4000));
  let n = 0;
  for (let i = 0; i < samples.length; i += step) {
    const v = samples[i];
    sum += v * v;
    n++;
  }
  return Math.sqrt(sum / Math.max(1, n));
}

async function finishCapture({ cancel = false } = {}) {
  const shouldCancel = cancel || state.cancelRecord;
  const mode = recordMode;
  const wav = wavBuffers.slice();
  const sr = wavSampleRate;

  // 先断开采集，保留 buffer
  try { audioProcessor?.disconnect(); } catch {}
  try { audioSource?.disconnect(); } catch {}
  mediaStream?.getTracks().forEach((t) => t.stop());
  mediaStream = null;
  if (audioCtx) {
    try { await audioCtx.close(); } catch {}
  }
  audioProcessor = null;
  audioSource = null;
  audioCtx = null;
  recordMode = "none";
  setRecordingUi(false);

  if (shouldCancel || mode !== "wav") {
    wavBuffers = [];
    return;
  }
  if (!wav.length) {
    alert("没有录到声音，请按住多说一会儿再松开");
    return;
  }

  const { samples, sampleRate } = downsampleWav(wav, sr, 16000);
  wavBuffers = [];
  const durationSec = samples.length / sampleRate;
  const rms = audioRms(samples);
  if (durationSec < 0.55) {
    alert("说得太短了，请按住按钮把话说完再松开");
    return;
  }
  if (rms < 0.008) {
    alert("几乎没听到声音，请靠近麦克风再说一次");
    return;
  }

  state.asrBusy = true;
  updateSendState();
  setRecordingUi(false, { recognizing: true });
  voiceOverlay?.classList.remove("hidden");
  if (voiceHint) voiceHint.textContent = "正在识别…";
  if (holdBtn) holdBtn.textContent = "识别中…";
  try {
    // 按住说话走 /api/asr；识别完立刻结束「识别中」，再发对话（勿把 chat 耗时算进识别）
    const blob = encodeWavSamples(samples, sampleRate);
    const dataUrl = await blobToBase64(blob);
    const t0 = performance.now();
    const data = await api("/api/asr", {
      method: "POST",
      body: JSON.stringify({ audio: dataUrl, mime: "audio/wav" }),
    });
    console.debug("[asr] client_ms", Math.round(performance.now() - t0), "text", data.text);
    const text = (data.text || "").trim();
    if (!text || isWeakAsrText(text)) {
      alert(text ? `只听清了「${text}」，请靠近麦克风、说完整再试` : "没有听清，请再说一次");
      return;
    }
    inputEl.value = text;
    // 识别阶段结束
    state.asrBusy = false;
    setRecordingUi(false);
    voiceOverlay?.classList.add("hidden");
    if (holdBtn) holdBtn.textContent = "按住 说话";
    updateSendState();
    await sendMessage();
  } catch (err) {
    alert(err.message || "语音识别失败");
  } finally {
    state.asrBusy = false;
    setRecordingUi(false);
    voiceOverlay?.classList.add("hidden");
    if (holdBtn) holdBtn.textContent = "按住 说话";
    updateSendState();
  }
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("音频读取失败"));
    reader.readAsDataURL(blob);
  });
}

function isWeakAsrText(text) {
  const t = String(text || "").replace(/[。．\.！!？?\s]/g, "").trim();
  return !t || /^(嗯|恩|啊|哦|呃|唔|额|嗯嗯|啊啊)$/.test(t);
}


function voiceWsUrl() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/api/voice/ws?token=${encodeURIComponent(state.token)}`;
}

function b64FromBytes(bytes) {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function downsampleTo16k(float32, fromRate) {
  if (fromRate === 16000) return float32;
  const ratio = fromRate / 16000;
  const newLen = Math.floor(float32.length / ratio);
  const result = new Float32Array(newLen);
  for (let i = 0; i < newLen; i++) result[i] = float32[Math.floor(i * ratio)] || 0;
  return result;
}

function floatTo16BitPCM(float32) {
  const buf = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    buf[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return buf;
}

/** Omni 实时转写：边说边传，松手后更快出字；失败则回退 /api/asr */
async function transcribeWithOmni(floatChunks, sampleRate) {
  return new Promise(async (resolve, reject) => {
    let ws;
    let settled = false;
    const done = (err, text) => {
      if (settled) return;
      settled = true;
      try { ws?.close(); } catch {}
      err ? reject(err) : resolve(text || "");
    };
    const timer = setTimeout(() => done(new Error("Omni 转写超时")), 12000);
    try {
      ws = new WebSocket(voiceWsUrl());
      ws.onerror = () => {
        clearTimeout(timer);
        done(new Error("Omni 连接失败"));
      };
      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        const t = msg?.type;
        if (t === "client.error") {
          clearTimeout(timer);
          done(new Error(msg.message || "Omni 错误"));
          return;
        }
        if (t === "client.status" && msg.status === "ready") {
          // 推送已缓存的 PCM
          for (const chunk of floatChunks) {
            const down = downsampleTo16k(chunk, sampleRate);
            const pcm = floatTo16BitPCM(down);
            ws.send(JSON.stringify({
              type: "input_audio_buffer.append",
              audio: b64FromBytes(new Uint8Array(pcm.buffer)),
            }));
          }
          ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
          ws.send(JSON.stringify({ type: "response.create" }));
          return;
        }
        // 转写完成事件（兼容多种字段）
        if (
          t === "conversation.item.input_audio_transcription.completed" ||
          t === "response.audio_transcript.done"
        ) {
          const text = (msg.transcript || msg.text || "").trim();
          clearTimeout(timer);
          done(null, text);
          return;
        }
        if (t === "response.done" || t === "response.completed") {
          const text =
            msg.response?.output_text ||
            msg.transcript ||
            "";
          if (text) {
            clearTimeout(timer);
            done(null, String(text).trim());
          }
        }
      };
    } catch (e) {
      clearTimeout(timer);
      done(e);
    }
  });
}

async function transcribeAudio(blob, mimeType) {
  state.asrBusy = true;
  updateSendState();
  setRecordingUi(false, { recognizing: true });
  voiceOverlay?.classList.remove("hidden");
  if (voiceHint) voiceHint.textContent = "正在识别…";
  if (holdBtn) holdBtn.textContent = "识别中…";
  try {
    const dataUrl = await blobToBase64(blob);
    const data = await api("/api/asr", {
      method: "POST",
      body: JSON.stringify({
        audio: dataUrl,
        mime: (mimeType || "audio/wav").split(";")[0],
      }),
    });
    const text = (data.text || "").trim();
    if (!text || isWeakAsrText(text)) {
      alert(text ? `只听清了「${text}」，请靠近麦克风、说完整再试` : "没有听清，请再说一次");
      return;
    }
    inputEl.value = text;
    updateSendState();
    await sendMessage();
  } catch (err) {
    alert(err.message || "语音识别失败");
  } finally {
    state.asrBusy = false;
    setRecordingUi(false);
    voiceOverlay?.classList.add("hidden");
    if (holdBtn) holdBtn.textContent = "按住 说话";
    updateSendState();
  }
}

let pendingEnd = null; // { cancel: boolean } 松手发生在麦克风尚未就绪时

async function onHoldStart(e) {
  if (state.sending || state.asrBusy || holding) return;
  e.preventDefault();
  try {
    holdBtn?.setPointerCapture?.(e.pointerId);
  } catch {}
  // 按住说话时先停掉 TTS，避免把播报录进麦克风
  stopCurrentAudio();
  holding = true;
  pendingEnd = null;
  holdStartY = e.clientY ?? 0;
  state.cancelRecord = false;
  const session = ++recSession;
  if (holdBtn) holdBtn.textContent = "准备中…";
  holdBtn?.classList.add("recording");
  try {
    const ok = await beginCapture(session);
    if (!ok && session === recSession && !pendingEnd) {
      setRecordingUi(false);
      holding = false;
    }
  } catch (err) {
    if (session === recSession) {
      cleanupMic();
      setRecordingUi(false);
      holding = false;
      pendingEnd = null;
      alert(err.message || "无法开始录音");
    }
  }
}

function onHoldMove(e) {
  if (!holding) return;
  if (!state.recording && recordMode === "none") return;
  const canceling = holdStartY - (e.clientY ?? holdStartY) > 60;
  state.cancelRecord = canceling;
  if (state.recording) setRecordingUi(true, { canceling });
}

async function onHoldEnd(e) {
  e?.preventDefault?.();
  if (!holding && !pendingEnd) return;
  const cancel = state.cancelRecord;

  // 还在「准备中」：标记结束后由 beginCapture 收尾，不要直接作废会话导致空录音
  if (holding && !state.recording && recordMode === "none") {
    pendingEnd = { cancel };
    holding = false;
    return;
  }

  holding = false;
  if (!state.recording && recordMode === "none") {
    cleanupMic();
    setRecordingUi(false);
    return;
  }
  recSession += 1;
  await finishCapture({ cancel });
}

modeBtn?.addEventListener("click", () => {
  if (state.sending || state.asrBusy || holding) return;
  if (!state.voiceMode && !isSecureForMic()) {
    alert(`语音需要 HTTPS：${httpsEntryUrl()}`);
    refreshSecureHint();
    return;
  }
  setVoiceMode(!state.voiceMode);
});
if (holdBtn) {
  holdBtn.addEventListener("pointerdown", onHoldStart);
  holdBtn.addEventListener("pointermove", onHoldMove);
  holdBtn.addEventListener("pointerup", onHoldEnd);
  holdBtn.addEventListener("pointercancel", onHoldEnd);
  holdBtn.addEventListener("lostpointercapture", onHoldEnd);
  holdBtn.addEventListener("contextmenu", (e) => e.preventDefault());
}
stopBtn?.addEventListener("click", () => abortAll());
refreshSecureHint();
setVoiceMode(false);

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !(options.body instanceof FormData)) headers["Content-Type"] = "application/json";
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const res = await fetch(path, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    let msg = data.detail || data.message || `请求失败 ${res.status}`;
    if (Array.isArray(msg)) msg = msg.map((x) => x.msg || JSON.stringify(x)).join("；");
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
  }
  return data;
}

function showLogin() { loginView.classList.remove("hidden"); chatView.classList.add("hidden"); }
function showChat() {
  loginView.classList.add("hidden");
  chatView.classList.remove("hidden");
  $("#side-user").textContent = `${state.member.emoji} ${state.member.name}`;
}

function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

async function enterAs(member) {
  const data = await api("/api/login", {
    method: "POST",
    body: JSON.stringify({ user_id: member.id }),
  });
  state.token = data.token;
  state.member = data.member;
  localStorage.setItem("gs_token", state.token);
  localStorage.setItem("gs_member", JSON.stringify(state.member));
  showChat();
  await bootChat();
}

async function loadMembers() {
  const data = await api("/api/members?role=child");
  state.members = data.members;
  memberGrid.innerHTML = "";
  for (const m of state.members) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "member-card";
    btn.style.setProperty("--member-color", m.color);
    btn.innerHTML = `<div class="member-emoji">${m.emoji}</div><div class="member-name">${m.name}</div>
      <div class="member-status go">点我进入</div>`;
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        await enterAs(m);
      } catch (err) {
        if (loginError) {
          loginError.textContent = err.message;
          loginError.classList.remove("hidden");
        }
        btn.disabled = false;
      }
    });
    memberGrid.appendChild(btn);
  }
}

$("#logout-btn").addEventListener("click", () => {
  state.token = ""; state.member = null; state.currentId = null;
  localStorage.removeItem("gs_token"); localStorage.removeItem("gs_member");
  showLogin(); loadMembers();
});

async function loadTodayStrip() {
  if (!todayStrip) return;
  try {
    const data = await api("/api/schedule");
    const items = data.today || [];
    todayStrip.innerHTML = items.length
      ? items.map((ev) => `<div class="today-chip"><strong>${ev.start}</strong> ${ev.title} · ${ev.place_name}</div>`).join("")
      : `<div class="today-chip">今天暂无安排</div>`;
  } catch {
    todayStrip.innerHTML = "";
  }
}

async function bootChat() {
  await loadTodayStrip();
  await refreshSessions();
  if (!state.sessions.length) await createSession();
  else await openSession(state.sessions[0].id);
}

async function refreshSessions() {
  const data = await api("/api/sessions");
  state.sessions = data.sessions;
  renderSessions();
}

function renderSessions() {
  sessionList.innerHTML = "";
  for (const s of state.sessions) {
    const row = document.createElement("div");
    row.className = "session-item" + (s.id === state.currentId ? " active" : "");
    row.innerHTML = `<div class="meta"><div class="title">${escapeHtml(s.title || "新对话")}</div>
      <div class="time">${fmtTime(s.updated_at)}</div></div>
      <button class="del" type="button">✕</button>`;
    row.querySelector(".meta").addEventListener("click", () => { openSession(s.id); closeSidebar(); });
    row.querySelector(".del").addEventListener("click", (e) => { e.stopPropagation(); deleteSession(s.id); });
    sessionList.appendChild(row);
  }
}

async function createSession() {
  const data = await api("/api/sessions", { method: "POST", body: JSON.stringify({ title: "新对话" }) });
  await refreshSessions();
  await openSession(data.session.id);
}

async function openSession(id) {
  const data = await api(`/api/sessions/${id}`);
  state.currentId = id;
  chatTitle.textContent = data.session.title || "新对话";
  deleteBtn.classList.remove("hidden");
  clearAttachments();
  renderSessions();
  renderMessages(data.session.messages || []);
}

async function deleteSession(id) {
  if (!confirm("删除这个对话？")) return;
  await api(`/api/sessions/${id}`, { method: "DELETE" });
  if (state.currentId === id) state.currentId = null;
  await refreshSessions();
  if (state.sessions.length) await openSession(state.sessions[0].id);
  else await createSession();
}

$("#new-session-btn").addEventListener("click", () => { createSession(); closeSidebar(); });
deleteBtn.addEventListener("click", () => { if (state.currentId) deleteSession(state.currentId); });

function renderMessages(messages) {
  messagesEl.innerHTML = "";
  if (!messages.length) {
    messagesEl.appendChild(welcomeEl.cloneNode(true));
    bindSuggests(messagesEl.querySelector(".welcome"));
    return;
  }
  for (const m of messages) appendBubble(m.role, m.content, { markdown: m.role === "assistant" });
  scrollBottom();
}

function bindSuggests(root) {
  root?.querySelectorAll("[data-q]").forEach((btn) => {
    btn.addEventListener("click", () => {
      inputEl.value = btn.dataset.q;
      updateSendState();
      sendMessage();
    });
  });
}

function appendBubble(role, content, { markdown = false, streaming = false, previews = [] } = {}) {
  const el = document.createElement("div");
  el.className = `bubble ${role}` + (streaming ? " streaming" : "");
  if (role === "assistant") setBubbleContent(el, content, { markdown: true, streaming });
  else {
    el.dataset.rawText = content || "";
    el.textContent = content;
  }
  if (role === "user" && previews.length) {
    const box = document.createElement("div");
    box.className = "user-attach";
    for (const p of previews) {
      if (p.previewUrl) {
        const img = document.createElement("img");
        img.src = p.previewUrl;
        img.alt = p.name || "截图";
        box.appendChild(img);
      }
    }
    el.appendChild(box);
  }
  messagesEl.appendChild(el);
  scrollBottom();
  return el;
}

function scrollBottom() {
  requestAnimationFrame(() => {
    if (!messagesEl) return;
    messagesEl.scrollTop = messagesEl.scrollHeight;
    const last = messagesEl.lastElementChild;
    if (last?.scrollIntoView) {
      try {
        last.scrollIntoView({ block: "end", behavior: "auto" });
      } catch {}
    }
  });
}

function updateSendState() {
  const hasText = !!inputEl.value.trim();
  const hasFile = state.attachments.length > 0;
  const canSend =
    !state.sending &&
    !state.asrBusy &&
    !holding &&
    !!state.currentId &&
    (hasText || hasFile) &&
    !state.voiceMode;
  sendBtn.disabled = !canSend;
  sendBtn.classList.toggle("hidden", state.sending || state.voiceMode);
  stopBtn?.classList.toggle("hidden", !(state.sending || state.asrBusy));
  if (stopBtn) stopBtn.disabled = !(state.sending || state.asrBusy);
  if (holdBtn) holdBtn.disabled = state.sending || state.asrBusy;
  if (modeBtn) modeBtn.disabled = state.sending || holding || state.asrBusy;
  if (attachBtn) attachBtn.disabled = state.sending || holding || state.recording || state.asrBusy;
  if (inputEl) inputEl.readOnly = state.sending;
}

function clearAttachments() {
  for (const a of state.attachments) {
    if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
  }
  state.attachments = [];
  renderAttachPreview();
  updateSendState();
}

function renderAttachPreview() {
  if (!attachPreview) return;
  attachPreview.innerHTML = "";
  if (!state.attachments.length) {
    attachPreview.classList.add("hidden");
    return;
  }
  attachPreview.classList.remove("hidden");
  for (const a of state.attachments) {
    const chip = document.createElement("div");
    chip.className = "attach-chip";
    chip.innerHTML = a.previewUrl
      ? `<img src="${a.previewUrl}" alt="" />`
      : `<div>${escapeHtml(a.name)}</div>`;
    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "rm";
    rm.textContent = "×";
    rm.addEventListener("click", () => {
      state.attachments = state.attachments.filter((x) => x.id !== a.id);
      if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
      renderAttachPreview();
      updateSendState();
    });
    chip.appendChild(rm);
    attachPreview.appendChild(chip);
  }
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error(`读取失败：${file.name}`));
    reader.readAsDataURL(file);
  });
}

async function addFiles(fileList) {
  const files = [...(fileList || [])];
  for (const file of files) {
    if (state.attachments.length >= MAX_ATTACH) {
      alert(`一次最多 ${MAX_ATTACH} 张图`);
      break;
    }
    if (file.size > MAX_FILE_SIZE) {
      alert(`${file.name || "文件"} 超过 12MB`);
      continue;
    }
    const mime = file.type || "image/jpeg";
    if (!mime.startsWith("image/")) {
      alert("目前只支持图片截图");
      continue;
    }
    try {
      const dataUrl = await readFileAsBase64(file);
      state.attachments.push({
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        name: file.name || `screenshot-${Date.now()}.png`,
        mime,
        data: dataUrl,
        previewUrl: URL.createObjectURL(file),
      });
    } catch (err) {
      alert(err.message);
    }
  }
  renderAttachPreview();
  updateSendState();
}

attachBtn?.addEventListener("click", () => fileInput?.click());
fileInput?.addEventListener("change", async () => {
  await addFiles(fileInput.files);
  fileInput.value = "";
});

inputEl.addEventListener("input", () => {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + "px";
  updateSendState();
});
inputEl.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  if (e.isComposing || e.keyCode === 229) return;
  if (e.altKey || e.metaKey) {
    e.preventDefault();
    if (!sendBtn.disabled) sendMessage();
  }
});
inputEl.addEventListener("paste", async (e) => {
  if (state.sending) return;
  const items = [...(e.clipboardData?.items || [])].filter((i) => i.kind === "file");
  const files = items.map((i) => i.getAsFile()).filter(Boolean);
  if (!files.length) return;
  e.preventDefault();
  await addFiles(files);
});

$("#composer").addEventListener("submit", (e) => {
  e.preventDefault();
  sendMessage();
});

async function sendMessage() {
  const text = inputEl.value.trim();
  const pending = [...state.attachments];
  if ((!text && !pending.length) || state.sending || !state.currentId) return;
  messagesEl.querySelector(".welcome")?.remove();
  state.sending = true;
  chatAbort = new AbortController();
  if (state.autoTts) unlockAudioPlayback();
  updateSendState();
  inputEl.value = "";
  inputEl.style.height = "auto";
  state.attachments = [];
  renderAttachPreview();

  const previews = pending.map((a) => ({ name: a.name, previewUrl: a.previewUrl }));
  appendBubble("user", text || "（截图）", { previews });
  const bubble = appendBubble("assistant", "正在想…", { markdown: true, streaming: true });
  let finalText = "";
  let gotDelta = false;
  try {
    const res = await fetch(`/api/sessions/${state.currentId}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${state.token}` },
      body: JSON.stringify({
        message: text,
        attachments: pending.map((a) => ({ name: a.name, mime: a.mime, data: a.data })),
      }),
      signal: chatAbort.signal,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || `发送失败 ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() || "";
      for (const part of parts) {
        const line = part.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        let payload;
        try {
          payload = JSON.parse(line.slice(6));
        } catch {
          continue;
        }
        if (payload.type === "status" && payload.message && !gotDelta) {
          setBubbleContent(bubble, payload.message, { streaming: true });
          scrollBottom();
        } else if (payload.type === "delta" && payload.text) {
          if (!gotDelta) {
            gotDelta = true;
            finalText = "";
          }
          if (payload.text.startsWith(finalText) && payload.text.length >= finalText.length) {
            finalText = payload.text;
          } else finalText += payload.text;
          setBubbleContent(bubble, finalText, { markdown: true, streaming: true });
          if (state.autoTts) prefetchFirstTts(bubble);
          scrollBottom();
        } else if (payload.type === "done") {
          finalText = payload.text || finalText;
          setBubbleContent(bubble, finalText, { markdown: true, streaming: false });
          scrollBottom();
        } else if (payload.type === "error") {
          setBubbleContent(bubble, `抱歉：${payload.message}`, { streaming: false });
          scrollBottom();
        }
      }
    }
    if (finalText) {
      setBubbleContent(bubble, finalText, { markdown: true, streaming: false });
      scrollBottom();
      maybeAutoPlayTts(bubble);
    }
    await refreshSessions();
    await loadTodayStrip();
  } catch (err) {
    if (err?.name === "AbortError") setBubbleContent(bubble, "（已停止）", { streaming: false });
    else setBubbleContent(bubble, `抱歉：${err.message}`, { streaming: false });
    scrollBottom();
  } finally {
    for (const a of pending) {
      if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
    }
    chatAbort = null;
    state.sending = false;
    updateSendState();
    if (!state.voiceMode) inputEl.focus();
  }
}

async function init() {
  await loadPublicHttps();
  await loadMembers();
  if (state.token && state.member) {
    try {
      await api("/api/me");
      showChat();
      await bootChat();
      return;
    } catch {
      localStorage.removeItem("gs_token");
      localStorage.removeItem("gs_member");
      state.token = "";
      state.member = null;
    }
  }
  // 前台只有小葡萄：直接进入，免点选
  if (state.members.length === 1) {
    try {
      await enterAs(state.members[0]);
      return;
    } catch (err) {
      if (loginError) {
        loginError.textContent = err.message;
        loginError.classList.remove("hidden");
      }
    }
  }
  showLogin();
}
init();
