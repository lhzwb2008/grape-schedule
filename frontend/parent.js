const state = {
  token: localStorage.getItem("gs_parent_token") || "",
  member: JSON.parse(localStorage.getItem("gs_parent_member") || "null"),
  members: [],
  selected: null,
  currentId: null,
  sending: false,
  recording: false,
  asrBusy: false,
  voiceMode: false,
  cancelRecord: false,
  autoTts: localStorage.getItem("gs_parent_auto_tts") === "1",
};

const $ = (sel) => document.querySelector(sel);
const loginView = $("#login-view");
const appView = $("#app-view");
const memberGrid = $("#member-grid");
const loginError = $("#login-error");
const messagesEl = $("#messages");
const inputEl = $("#input");
const sendBtn = $("#send-btn");
const stopBtn = $("#stop-btn");
const holdBtn = $("#hold-btn");
const modeBtn = $("#mode-btn");
const autoTtsBtn = $("#auto-tts-btn");
const voiceOverlay = $("#voice-overlay");
const voiceHint = $("#voice-hint");
const secureHint = $("#secure-hint");

let chatAbort = null;
let ttsPlayToken = 0;
let currentAudio = null;
let sharedAudio = null;
let audioUnlocked = false;
let holdStartY = 0;
let holding = false;
let recSession = 0;
let recordMode = "none";
let wavBuffers = [];
let wavSampleRate = 16000;
let mediaStream = null;
let audioCtx = null;
let audioSource = null;
let audioProcessor = null;
let pendingEnd = null;
let publicHttpsUrl = "https://grape-schedule.101.201.237.149.sslip.io/";

if (window.marked) marked.setOptions({ breaks: true, gfm: true });

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

function showLogin() {
  loginView.classList.remove("hidden");
  appView.classList.add("hidden");
}
function showApp() {
  loginView.classList.add("hidden");
  appView.classList.remove("hidden");
  $("#side-user").textContent = `${state.member.emoji} ${state.member.name}`;
}

async function enterAs(member) {
  const data = await api("/api/login", {
    method: "POST",
    body: JSON.stringify({ user_id: member.id }),
  });
  if (data.member.role !== "parent") throw new Error("请使用家长身份进入家长端");
  state.token = data.token;
  state.member = data.member;
  localStorage.setItem("gs_parent_token", state.token);
  localStorage.setItem("gs_parent_member", JSON.stringify(state.member));
  showApp();
  await boot();
}

async function loadMembers() {
  const data = await api("/api/members?role=parent");
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
  state.token = "";
  state.member = null;
  localStorage.removeItem("gs_parent_token");
  localStorage.removeItem("gs_parent_member");
  showLogin();
  loadMembers();
});

function setBubbleContent(el, text, { markdown = false, streaming = false } = {}) {
  el.dataset.rawText = text || "";
  if (markdown && el.classList.contains("assistant")) el.innerHTML = `<div class="md">${renderMarkdown(text)}</div>`;
  else el.textContent = text;
  el.classList.toggle("streaming", !!streaming);
}

function appendBubble(role, content) {
  const el = document.createElement("div");
  el.className = `bubble ${role}`;
  if (role === "assistant") {
    el.dataset.rawText = content || "";
    el.innerHTML = `<div class="md">${renderMarkdown(content)}</div>`;
  } else el.textContent = content;
  messagesEl.appendChild(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return el;
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
  return String(text || "").replace(/```[\s\S]*?```/g, " ").replace(/`[^`]+`/g, " ").replace(/[*_]{1,3}/g, "").replace(/\s+/g, " ").trim();
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

function splitSpeechSegments(text, maxChars = 72) {
  const clean = stripTextForSpeech(text).replace(/(\d)\.(\d)/g, "$1点$2");
  if (!clean) return [];
  const parts = [];
  let buf = "";
  for (let i = 0; i < clean.length; i++) {
    buf += clean[i];
    const atBreak = "。！？；!?\n".includes(clean[i]);
    const tooLong = buf.length >= maxChars;
    if ((atBreak || tooLong) && buf.trim()) {
      parts.push(buf.trim());
      buf = "";
    }
  }
  if (buf.trim()) parts.push(buf.trim());
  const merged = [];
  for (const seg of parts) {
    const prev = merged[merged.length - 1];
    if (prev && prev.length < 12 && !"。！？!?.;".includes(prev.slice(-1))) {
      merged[merged.length - 1] += seg;
    } else {
      merged.push(seg);
    }
  }
  return merged;
}

/** 流式阶段：只取已成句的片段（丢掉末尾未完成半句） */
function completeSpeechSegments(text) {
  const segs = splitSpeechSegments(text);
  if (!segs.length) return [];
  const last = segs[segs.length - 1];
  if (/[。！？!?；.]$/.test(last) || last.length >= 72) return segs;
  return segs.slice(0, -1);
}

function resetStreamingTts(bubble) {
  if (!bubble) return;
  bubble._ttsStream = {
    queued: 0,
    queue: [],
    fetchMap: new Map(),
    pumping: false,
    token: ttsPlayToken,
  };
}

function feedStreamingTts(bubble, fullText, { finalize = false } = {}) {
  if (!state.autoTts || !bubble) return;
  if (!bubble._ttsStream || bubble._ttsStream.token !== ttsPlayToken) {
    resetStreamingTts(bubble);
  }
  const st = bubble._ttsStream;
  const segs = finalize ? splitSpeechSegments(fullText) : completeSpeechSegments(fullText);
  while (st.queued < segs.length) {
    const seg = segs[st.queued++];
    st.queue.push(seg);
    if (!st.fetchMap.has(seg)) {
      st.fetchMap.set(
        seg,
        fetchTtsBlob(seg)
          .then((blob) => blob)
          .catch(() => null)
      );
    }
  }
  pumpStreamingTts(bubble);
}

async function pumpStreamingTts(bubble) {
  const st = bubble._ttsStream;
  if (!st || st.pumping) return;
  st.pumping = true;
  const token = st.token;
  try {
    if (!audioUnlocked) await unlockAudioPlayback();
    while (st.queue.length) {
      if (token !== ttsPlayToken) return;
      const seg = st.queue.shift();
      let blob = null;
      const pending = st.fetchMap.get(seg);
      if (pending) blob = await pending;
      if (!blob && token === ttsPlayToken) blob = await fetchTtsBlob(seg);
      // 播放本句时预取队列下一句
      if (st.queue[0] && !st.fetchMap.has(st.queue[0])) {
        const nxt = st.queue[0];
        st.fetchMap.set(
          nxt,
          fetchTtsBlob(nxt)
            .then((b) => b)
            .catch(() => null)
        );
      }
      if (token !== ttsPlayToken) return;
      if (blob) await playBlob(blob);
    }
  } catch (err) {
    console.warn("[tts] stream", err);
  } finally {
    st.pumping = false;
    if (st.queue.length && token === ttsPlayToken) pumpStreamingTts(bubble);
  }
}


function prefetchFirstTts(bubble) {
  if (!bubble) return;
  feedStreamingTts(bubble, bubble.dataset.rawText || "");
}
async function playTts(bubble, { auto = false } = {}) {
  if (!bubble) return;
  feedStreamingTts(bubble, bubble.dataset.rawText || "", { finalize: true });
}
function maybeAutoPlayTts(bubble) {
  if (!state.autoTts || !bubble) return;
  feedStreamingTts(bubble, bubble.dataset.rawText || "", { finalize: true });
}

function syncAutoTtsButton() {
  if (!autoTtsBtn) return;
  autoTtsBtn.classList.toggle("on", state.autoTts);
  autoTtsBtn.textContent = state.autoTts ? "🔊" : "🔇";
}
autoTtsBtn?.addEventListener("click", async () => {
  state.autoTts = !state.autoTts;
  localStorage.setItem("gs_parent_auto_tts", state.autoTts ? "1" : "0");
  syncAutoTtsButton();
  if (state.autoTts) await unlockAudioPlayback(); else stopCurrentAudio();
});
syncAutoTtsButton();

function isSecureForMic() {
  if (window.isSecureContext) return true;
  const h = location.hostname;
  return h === "localhost" || h === "127.0.0.1";
}
function httpsEntryUrl() {
  const host = location.hostname;
  if (host.includes("grape-schedule") && (host.endsWith("sslip.io") || host.endsWith("nip.io"))) return `https://${host}/parent`;
  return publicHttpsUrl.replace(/\/?$/, "/parent");
}
function refreshSecureHint() {
  if (!secureHint) return;
  if (!isSecureForMic()) {
    const url = httpsEntryUrl();
    secureHint.innerHTML = `语音需本项目 HTTPS：<a href="${url}">${url}</a>`;
    secureHint.classList.remove("hidden");
  } else secureHint.classList.add("hidden");
}
async function loadPublicHttps() {
  try {
    const data = await fetch("/api/health").then((r) => r.json());
    if (data?.https_url) publicHttpsUrl = data.https_url;
    else if (data?.https_host) publicHttpsUrl = `https://${data.https_host}/`;
  } catch {}
  refreshSecureHint();
}

function setVoiceMode(on) {
  state.voiceMode = !!on;
  if (inputEl) { inputEl.hidden = false; inputEl.classList.toggle("hidden", state.voiceMode); }
  if (holdBtn) { holdBtn.hidden = false; holdBtn.classList.toggle("hidden", !state.voiceMode); }
  if (sendBtn) sendBtn.classList.toggle("hidden", state.voiceMode || state.sending);
  if (modeBtn) {
    modeBtn.textContent = state.voiceMode ? "⌨️" : "🎤";
    modeBtn.title = state.voiceMode ? "切换文字输入" : "切换语音输入";
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
function updateSendState() {
  const canSend = !state.sending && !state.asrBusy && !holding && !!state.currentId && !!inputEl?.value.trim() && !state.voiceMode;
  if (sendBtn) { sendBtn.disabled = !canSend; sendBtn.classList.toggle("hidden", state.sending || state.voiceMode); }
  stopBtn?.classList.toggle("hidden", !(state.sending || state.asrBusy));
  if (stopBtn) stopBtn.disabled = !(state.sending || state.asrBusy);
  if (holdBtn) holdBtn.disabled = state.sending || state.asrBusy;
  if (modeBtn) modeBtn.disabled = state.sending || holding || state.asrBusy;
  if (inputEl) inputEl.readOnly = state.sending;
}
function cleanupMic() {
  try { audioProcessor?.disconnect(); } catch {}
  try { audioSource?.disconnect(); } catch {}
  mediaStream?.getTracks().forEach((t) => t.stop());
  mediaStream = null;
  if (audioCtx) { try { audioCtx.close(); } catch {} }
  audioProcessor = null; audioSource = null; audioCtx = null; recordMode = "none";
}
function downsampleWav(floatChunks, fromRate, toRate = 16000) {
  let len = 0; for (const c of floatChunks) len += c.length;
  const merged = new Float32Array(len); let o = 0;
  for (const c of floatChunks) { merged.set(c, o); o += c.length; }
  if (fromRate === toRate) return { samples: merged, sampleRate: toRate };
  const ratio = fromRate / toRate;
  const outLen = Math.floor(merged.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) out[i] = merged[Math.floor(i * ratio)] || 0;
  return { samples: out, sampleRate: toRate };
}
function encodeWavSamples(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  writeStr(0, "RIFF"); view.setUint32(4, 36 + samples.length * 2, true);
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
function audioRms(samples) {
  if (!samples.length) return 0;
  let sum = 0, n = 0;
  const step = Math.max(1, Math.floor(samples.length / 4000));
  for (let i = 0; i < samples.length; i += step) { sum += samples[i] * samples[i]; n++; }
  return Math.sqrt(sum / Math.max(1, n));
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
async function beginCapture(session) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  });
  if (session !== recSession || !holding) { stream.getTracks().forEach((t) => t.stop()); return false; }
  mediaStream = stream;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") await audioCtx.resume();
  wavSampleRate = audioCtx.sampleRate; wavBuffers = [];
  audioSource = audioCtx.createMediaStreamSource(stream);
  audioProcessor = audioCtx.createScriptProcessor(4096, 1, 1);
  audioProcessor.onaudioprocess = (e) => {
    if (session !== recSession || !holding) return;
    wavBuffers.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  };
  const mute = audioCtx.createGain(); mute.gain.value = 0;
  audioSource.connect(audioProcessor); audioProcessor.connect(mute); mute.connect(audioCtx.destination);
  recordMode = "wav"; setRecordingUi(true);
  if (pendingEnd) {
    const pe = pendingEnd; pendingEnd = null; holding = false;
    await finishCapture(pe); return false;
  }
  return true;
}
async function finishCapture({ cancel = false } = {}) {
  const shouldCancel = cancel || state.cancelRecord;
  const wav = wavBuffers.slice(); const sr = wavSampleRate;
  cleanupMic(); setRecordingUi(false);
  if (shouldCancel) { wavBuffers = []; return; }
  if (!wav.length) { alert("没有录到声音，请按住多说一会儿再松开"); return; }
  const { samples, sampleRate } = downsampleWav(wav, sr, 16000);
  wavBuffers = [];
  const durationSec = samples.length / sampleRate;
  const rms = audioRms(samples);
  if (durationSec < 0.55) { alert("说得太短了，请按住按钮把话说完再松开"); return; }
  if (rms < 0.008) { alert("几乎没听到声音，请靠近麦克风再说一次"); return; }
  state.asrBusy = true; updateSendState();
  setRecordingUi(false, { recognizing: true });
  voiceOverlay?.classList.remove("hidden");
  if (voiceHint) voiceHint.textContent = "正在识别…";
  if (holdBtn) holdBtn.textContent = "识别中…";
  try {
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
async function onHoldStart(e) {
  if (state.sending || state.asrBusy || holding) return;
  e.preventDefault();
  try { holdBtn?.setPointerCapture?.(e.pointerId); } catch {}
  stopCurrentAudio(); holding = true; pendingEnd = null;
  holdStartY = e.clientY ?? 0; state.cancelRecord = false;
  const session = ++recSession;
  if (holdBtn) holdBtn.textContent = "准备中…";
  holdBtn?.classList.add("recording");
  try {
    const ok = await beginCapture(session);
    if (!ok && session === recSession && !pendingEnd) { setRecordingUi(false); holding = false; }
  } catch (err) {
    if (session === recSession) {
      cleanupMic(); setRecordingUi(false); holding = false; pendingEnd = null;
      alert(err.message || "无法开始录音");
    }
  }
}
function onHoldMove(e) {
  if (!holding) return;
  const canceling = holdStartY - (e.clientY ?? holdStartY) > 60;
  state.cancelRecord = canceling; setRecordingUi(true, { canceling });
}
async function onHoldEnd(e) {
  if (!holding && !pendingEnd) return;
  const cancel = state.cancelRecord || (holdStartY - (e?.clientY ?? holdStartY) > 60);
  if (holding && recordMode === "none") { pendingEnd = { cancel }; holding = false; return; }
  holding = false;
  if (recordMode === "none") { cleanupMic(); setRecordingUi(false); return; }
  recSession += 1; await finishCapture({ cancel });
}
modeBtn?.addEventListener("click", () => {
  if (state.sending || state.asrBusy || holding) return;
  if (!state.voiceMode && !isSecureForMic()) {
    alert(`语音需要 HTTPS：${httpsEntryUrl()}`);
    refreshSecureHint(); return;
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
setVoiceMode(false);

async function ensureSession() {
  const list = await api("/api/sessions");
  if (list.sessions?.length) {
    state.currentId = list.sessions[0].id;
    const detail = await api(`/api/sessions/${state.currentId}`);
    messagesEl.innerHTML = "";
    for (const m of detail.session.messages || []) appendBubble(m.role, m.content);
    return;
  }
  const created = await api("/api/sessions", {
    method: "POST",
    body: JSON.stringify({ title: "家长管家" }),
  });
  state.currentId = created.session.id;
  messagesEl.innerHTML = "";
  appendBubble("assistant", "你好，我是小葡萄家庭日程管家。直接告诉我真实行程即可；也可点 🎤 语音说。上方 🔊 可开自动播报。");
}


const DAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const MEMBER_COLORS = {
  xiaoputao: "#6B3FA0",
  dad: "#1F7AEC",
  mom: "#E85D75",
  grandma: "#D97706",
};

function memberName(members, id) {
  return (members || []).find((m) => m.id === id)?.name || id || "?";
}

function formatReminders(reminders, members) {
  if (!reminders?.length) return "（未 @ 任何人）";
  return reminders
    .map((r) => `@${memberName(members, r.member_id)}（提前${r.minutes_before}分）`)
    .join(" ");
}

function eventAccent(ev) {
  const mid = ev.reminders?.[0]?.member_id;
  return MEMBER_COLORS[mid] || "#2f8f5b";
}

function thisWeekDates(isoNow) {
  const now = isoNow ? new Date(isoNow) : new Date();
  // Monday-based week in local time
  const day = (now.getDay() + 6) % 7; // 0=Mon
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day);
  return DAYS.map((label, i) => {
    const d = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return {
      label,
      date: `${yyyy}-${mm}-${dd}`,
      short: `${d.getMonth() + 1}/${d.getDate()}`,
      isToday: label === DAYS[(now.getDay() + 6) % 7],
    };
  });
}

function eventsForDay(schedule, dayLabel, dateStr) {
  const weekly = (schedule?.weekly || []).filter((ev) => (ev.days || []).includes(dayLabel));
  const oneOff = (schedule?.one_off || []).filter((ev) => ev.date === dateStr);
  return [...weekly, ...oneOff].sort((a, b) => String(a.start || "").localeCompare(String(b.start || "")));
}

function renderWeekLegend(members) {
  const el = $("#week-legend");
  if (!el) return;
  el.innerHTML = (members || [])
    .map(
      (m) =>
        `<span class="leg-item"><i style="background:${MEMBER_COLORS[m.id] || "#888"}"></i>${escapeHtml(m.name)}</span>`
    )
    .join("");
}

function renderWeekCalendar(data) {
  const schedule = data.schedule || {};
  const members = data.members || [];
  const cols = thisWeekDates(data.now);
  const cal = $("#week-calendar");
  let total = 0;
  cal.innerHTML = cols
    .map((col) => {
      const events = eventsForDay(schedule, col.label, col.date);
      total += events.length;
      const body = events.length
        ? events
            .map((ev) => {
              const at = formatReminders(ev.reminders, members);
              const place =
                (schedule.places || []).find((p) => p.id === ev.place_id)?.name ||
                ev.place_id ||
                "";
              return `<article class="cal-ev" style="--ev-accent:${eventAccent(ev)}" role="listitem">
            <div class="cal-ev-time">${escapeHtml(ev.start || "")}<span>${escapeHtml(ev.end || "")}</span></div>
            <div class="cal-ev-title">${escapeHtml(ev.title || "未命名")}</div>
            <div class="cal-ev-meta">${escapeHtml(place)}</div>
            <div class="cal-ev-at">${escapeHtml(at)}</div>
          </article>`;
            })
            .join("")
        : `<div class="cal-empty">暂无</div>`;
      return `<div class="cal-day ${col.isToday ? "today" : ""}" role="list">
        <div class="cal-day-head">
          <strong>${col.label}</strong>
          <span>${col.short}</span>
        </div>
        <div class="cal-day-body">${body}</div>
      </div>`;
    })
    .join("");
  $("#week-meta").textContent = total
    ? `本周 ${total} 条行程 · 色条对应首位提醒对象`
    : "本周暂无行程——在下方对话里说一声就会显示在这里";
}

function renderPlaces(schedule) {
  const el = $("#places-board");
  const home = schedule?.home;
  const places = (schedule?.places || []).filter((p) => {
    if (!p || p.id === "home") return false;
    if ((p.name || "") === "家" || (p.name || "") === (home?.name || "家")) return false;
    return true;
  });
  const travels = schedule?.travel_buffers || [];
  const placeName = (id) => {
    if (id === "home") return home?.name || "家";
    return places.find((p) => p.id === id)?.name || (schedule?.places || []).find((p) => p.id === id)?.name || id;
  };
  const bits = [];
  if (home?.address) {
    bits.push(`<div class="place-row"><strong>${escapeHtml(home.name || "家")}</strong><span>${escapeHtml(home.address)}</span></div>`);
  } else {
    bits.push(`<div class="place-row muted">家地址尚未录入</div>`);
  }
  if (places.length) {
    for (const p of places) {
      bits.push(
        `<div class="place-row"><strong>${escapeHtml(p.name || p.id)}</strong><span>${escapeHtml(p.address || "地址未录")}</span></div>`
      );
    }
  } else {
    bits.push(`<div class="place-row muted">尚无其它地点</div>`);
  }
  if (travels.length) {
    bits.push(`<div class="travel-title">路程</div>`);
    for (const t of travels) {
      bits.push(
        `<div class="place-row travel"><strong>${escapeHtml(placeName(t.from))} → ${escapeHtml(placeName(t.to))}</strong><span>约 ${t.minutes} 分 · ${escapeHtml(t.mode || "出行")}</span></div>`
      );
    }
  }
  el.innerHTML = bits.join("");
}

async function refreshBoard() {
  const data = await api("/api/schedule");
  $("#board-meta").textContent = `${data.weekday || ""} · ${new Date(data.now).toLocaleString("zh-CN")}`;
  renderWeekLegend(data.members);
  renderWeekCalendar(data);
  renderPlaces(data.schedule || {});

  const board = $("#reminder-board");
  // 一条行程一条卡片；多角色写在同卡 at 行（勿按人拆条）
  const items = data.reminders || data.today || [];
  board.innerHTML = items.length
    ? items
        .map((r) => {
          const targets = r.targets || r.reminders || [];
          const accent =
            MEMBER_COLORS[r.member_id || targets[0]?.member_id] || eventAccent(r) || "#2f8f5b";
          const at =
            r.at_text ||
            formatReminders(
              targets.map((t) => ({
                member_id: t.member_id,
                minutes_before: t.advance_minutes ?? t.minutes_before,
              })),
              data.members
            );
          return `<div class="reminder-card ${r.passed ? "passed" : ""}" style="--ev-accent:${accent}">
        <div class="title">${escapeHtml(r.title)} · ${escapeHtml(r.start || "")}</div>
        <div class="meta">${escapeHtml(r.place_name || "")} ${escapeHtml(r.place_address || "")}</div>
        <div class="meta at">${escapeHtml(at)}</div>
        <div class="meta">${escapeHtml(r.notes || "")}</div>
      </div>`;
        })
        .join("")
    : `<div class="empty-soft">今日暂无提醒<br/><span>对话里说行程后，会自动出现在这里</span></div>`;
}

async function sendMessage() {
  const text = inputEl.value.trim();
  if (!text || state.sending || !state.currentId) return;
  state.sending = true;
  chatAbort = new AbortController();
  if (state.autoTts) unlockAudioPlayback();
  updateSendState();
  inputEl.value = "";
  appendBubble("user", text);
  const bubble = appendBubble("assistant", "思考中…");
  setBubbleContent(bubble, "思考中…", { streaming: true });
  if (state.autoTts) resetStreamingTts(bubble);
  let finalText = "";
  let gotDelta = false;
  try {
    const res = await fetch(`/api/sessions/${state.currentId}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${state.token}` },
      body: JSON.stringify({ message: text }),
      signal: chatAbort.signal,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || `失败 ${res.status}`);
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
        try { payload = JSON.parse(line.slice(6)); } catch { continue; }
        if (payload.type === "status" && !gotDelta) setBubbleContent(bubble, payload.message, { streaming: true });
        else if (payload.type === "delta" && payload.text) {
          if (!gotDelta) { gotDelta = true; finalText = ""; }
          if (payload.text.startsWith(finalText) && payload.text.length >= finalText.length) finalText = payload.text;
          else finalText += payload.text;
          setBubbleContent(bubble, finalText, { markdown: true, streaming: true });
          if (state.autoTts) feedStreamingTts(bubble, finalText);
        } else if (payload.type === "done") {
          finalText = payload.text || finalText;
          setBubbleContent(bubble, finalText, { markdown: true, streaming: false });
          if (state.autoTts) feedStreamingTts(bubble, finalText, { finalize: true });
          await refreshBoard();
        } else if (payload.type === "error") {
          setBubbleContent(bubble, `抱歉：${payload.message}`, { streaming: false });
        }
      }
    }
    if (finalText) {
      setBubbleContent(bubble, finalText, { markdown: true, streaming: false });
      if (state.autoTts) feedStreamingTts(bubble, finalText, { finalize: true });
      await refreshBoard();
    }
  } catch (err) {
    if (err?.name === "AbortError") setBubbleContent(bubble, "（已停止）", { streaming: false });
    else setBubbleContent(bubble, `抱歉：${err.message}`, { streaming: false });
  } finally {
    chatAbort = null;
    state.sending = false;
    updateSendState();
  }
}

$("#composer").addEventListener("submit", (e) => {
  e.preventDefault();
  sendMessage();
});
inputEl?.addEventListener("input", () => updateSendState());

async function boot() {
  await loadPublicHttps();
  await refreshBoard();
  await ensureSession();
  updateSendState();
}

async function init() {
  await loadPublicHttps();
  await loadMembers();
  if (state.token && state.member) {
    try {
      const me = await api("/api/me");
      if (me.member?.role !== "parent") throw new Error("not parent");
      showApp();
      await boot();
      return;
    } catch {
      localStorage.removeItem("gs_parent_token");
      localStorage.removeItem("gs_parent_member");
      state.token = "";
      state.member = null;
    }
  }
  showLogin();
}
init();
