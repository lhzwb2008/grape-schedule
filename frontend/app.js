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
  voiceMode: true,
  cancelRecord: false,
  autoTts: localStorage.getItem("gs_auto_tts") !== "0",
};

const $ = (sel) => document.querySelector(sel);
const loginView = $("#login-view");
const chatView = $("#chat-view");
const memberGrid = $("#member-grid");
const loginForm = $("#login-form");
const passwordInput = $("#password-input");
const passwordLabel = $("#password-label");
const loginHint = $("#login-hint");
const loginError = $("#login-error");
const selectedChip = $("#selected-chip");
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
  if (el.classList.contains("assistant") && !streaming && text) attachTtsButton(el);
}

function attachTtsButton(bubble) {
  if (!bubble || bubble.querySelector(".btn-tts")) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn-tts tap";
  btn.textContent = "🔊";
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    playTts(bubble, btn);
  });
  bubble.appendChild(btn);
}

function stopCurrentAudio() {
  ttsPlayToken += 1;
  if (currentAudio) {
    try { currentAudio.pause(); currentAudio.currentTime = 0; } catch {}
    currentAudio = null;
  }
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

async function playTts(bubble, btn, { auto = false } = {}) {
  const text = (bubble.dataset.rawText || "").trim();
  if (!text || text.startsWith("抱歉")) return;
  stopCurrentAudio();
  const token = ttsPlayToken;
  btn.classList.add("playing");
  try {
    if (auto && !audioUnlocked) await unlockAudioPlayback();
    const segments = splitSpeechSegments(text);
    for (const seg of segments) {
      if (token !== ttsPlayToken) return;
      const blob = await fetchTtsBlob(seg);
      if (token !== ttsPlayToken) return;
      await playBlob(blob);
    }
  } catch (err) {
    if (!auto) alert(err.message || "语音失败");
  } finally {
    btn.classList.remove("playing");
  }
}

function maybeAutoPlayTts(bubble) {
  if (!state.autoTts || !bubble) return;
  const btn = bubble.querySelector(".btn-tts") || (attachTtsButton(bubble), bubble.querySelector(".btn-tts"));
  if (btn) playTts(bubble, btn, { auto: true });
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
  if (inputEl) inputEl.hidden = state.voiceMode;
  if (holdBtn) holdBtn.hidden = !state.voiceMode;
  if (modeBtn) modeBtn.textContent = state.voiceMode ? "⌨️" : "🎤";
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

function cleanupMic() {
  try { audioProcessor?.disconnect(); } catch {}
  try { audioSource?.disconnect(); } catch {}
  if (audioCtx) audioCtx.close().catch(() => {});
  audioProcessor = null; audioSource = null; audioCtx = null;
  try { if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop(); } catch {}
  mediaStream?.getTracks().forEach((t) => t.stop());
  mediaStream = null; mediaRecorder = null; recordMode = "none";
  recordChunks = []; wavBuffers = [];
}

async function acquireMicStream() {
  if (!isSecureForMic()) throw new Error("请用 HTTPS 打开后再录音");
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("当前浏览器不支持麦克风");
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
  });
}

async function beginCapture(session) {
  mediaStream = await acquireMicStream();
  if (session !== recSession || !holding) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
    return false;
  }
  recordChunks = []; wavBuffers = [];
  const mime = pickRecorderMime();
  if (window.MediaRecorder) {
    try {
      mediaRecorder = mime ? new MediaRecorder(mediaStream, { mimeType: mime }) : new MediaRecorder(mediaStream);
      recordMode = "mediarecorder";
      mediaRecorder.ondataavailable = (e) => { if (e.data?.size) recordChunks.push(e.data); };
      mediaRecorder.start(200);
      setRecordingUi(true);
      return true;
    } catch { mediaRecorder = null; }
  }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) { cleanupMic(); throw new Error("无法录音"); }
  audioCtx = new AC();
  if (audioCtx.state === "suspended") await audioCtx.resume();
  audioSource = audioCtx.createMediaStreamSource(mediaStream);
  audioProcessor = audioCtx.createScriptProcessor(4096, 1, 1);
  wavSampleRate = audioCtx.sampleRate;
  audioProcessor.onaudioprocess = (e) => wavBuffers.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  const mute = audioCtx.createGain(); mute.gain.value = 0;
  audioSource.connect(audioProcessor); audioProcessor.connect(mute); mute.connect(audioCtx.destination);
  recordMode = "wav";
  setRecordingUi(true);
  return true;
}

async function finishCapture({ cancel = false } = {}) {
  const shouldCancel = cancel || state.cancelRecord;
  const mode = recordMode;
  const chunks = recordChunks;
  const wav = wavBuffers;
  const sr = wavSampleRate;
  const mimeType = (mediaRecorder && mediaRecorder.mimeType) || pickRecorderMime() || "audio/webm";
  if (mode === "mediarecorder" && mediaRecorder && mediaRecorder.state !== "inactive") {
    await new Promise((resolve) => {
      mediaRecorder.onstop = resolve;
      try { mediaRecorder.stop(); } catch { resolve(); }
      setTimeout(resolve, 800);
    });
  }
  cleanupMic();
  setRecordingUi(false);
  if (shouldCancel) return;
  let blob = null;
  let mime = mimeType;
  if (mode === "mediarecorder") {
    if (!chunks.length) return;
    blob = new Blob(chunks, { type: mimeType });
  } else if (mode === "wav") {
    if (!wav.length) return;
    blob = encodeWav(wav, sr);
    mime = "audio/wav";
  } else return;
  if (blob.size < 800) return;
  await transcribeAudio(blob, mime);
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("音频读取失败"));
    reader.readAsDataURL(blob);
  });
}

async function transcribeAudio(blob, mimeType) {
  state.asrBusy = true;
  updateSendState();
  setRecordingUi(false, { recognizing: true });
  try {
    const dataUrl = await blobToBase64(blob);
    const data = await api("/api/asr", {
      method: "POST",
      body: JSON.stringify({ audio: dataUrl, mime: (mimeType || "audio/webm").split(";")[0] }),
    });
    const text = (data.text || "").trim();
    if (!text) { alert("没有听清，请再说一次"); return; }
    inputEl.value = text;
    updateSendState();
    await sendMessage();
  } catch (err) {
    alert(err.message || "语音识别失败");
  } finally {
    state.asrBusy = false;
    setRecordingUi(false);
    updateSendState();
  }
}

async function onHoldStart(e) {
  if (state.sending || state.asrBusy || holding) return;
  e.preventDefault();
  try { holdBtn?.setPointerCapture?.(e.pointerId); } catch {}
  holding = true;
  holdStartY = e.clientY ?? 0;
  state.cancelRecord = false;
  const session = ++recSession;
  if (holdBtn) holdBtn.textContent = "准备中…";
  try {
    const ok = await beginCapture(session);
    if (!ok && session === recSession) { setRecordingUi(false); holding = false; }
  } catch (err) {
    if (session === recSession) {
      cleanupMic(); setRecordingUi(false); holding = false;
      alert(err.message || "无法开始录音");
    }
  }
}
function onHoldMove(e) {
  if (!holding || !state.recording) return;
  const canceling = holdStartY - (e.clientY ?? holdStartY) > 60;
  state.cancelRecord = canceling;
  setRecordingUi(true, { canceling });
}
async function onHoldEnd(e) {
  e?.preventDefault?.();
  if (!holding) return;
  const cancel = state.cancelRecord;
  holding = false;
  recSession += 1;
  if (!state.recording && recordMode === "none") { cleanupMic(); setRecordingUi(false); return; }
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
  holdBtn.addEventListener("contextmenu", (e) => e.preventDefault());
}
stopBtn?.addEventListener("click", () => chatAbort?.abort());
refreshSecureHint();
setVoiceMode(true);

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
      <div class="member-status ${m.has_password ? "set" : "new"}">${m.has_password ? "已设密码" : "首次设置"}</div>`;
    btn.addEventListener("click", () => selectMember(m));
    memberGrid.appendChild(btn);
  }
}

function selectMember(m) {
  state.selected = m;
  [...memberGrid.children].forEach((el) => el.classList.remove("active"));
  const idx = state.members.findIndex((x) => x.id === m.id);
  if (memberGrid.children[idx]) memberGrid.children[idx].classList.add("active");
  loginForm.classList.remove("hidden");
  selectedChip.style.setProperty("--member-color", m.color);
  selectedChip.textContent = `${m.emoji} ${m.name}`;
  passwordLabel.textContent = m.has_password ? "输入密码" : "设置密码";
  loginHint.textContent = m.has_password ? "输入密码进入" : "第一次来先设密码";
  loginError.classList.add("hidden");
  passwordInput.value = "";
  passwordInput.focus();
}

$("#back-btn").addEventListener("click", () => {
  state.selected = null;
  loginForm.classList.add("hidden");
  [...memberGrid.children].forEach((el) => el.classList.remove("active"));
});

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!state.selected) return;
  const btn = $("#login-btn");
  btn.disabled = true;
  try {
    const data = await api("/api/login", {
      method: "POST",
      body: JSON.stringify({ user_id: state.selected.id, password: passwordInput.value }),
    });
    state.token = data.token;
    state.member = data.member;
    localStorage.setItem("gs_token", state.token);
    localStorage.setItem("gs_member", JSON.stringify(state.member));
    showChat();
    await bootChat();
  } catch (err) {
    loginError.textContent = err.message;
    loginError.classList.remove("hidden");
  } finally {
    btn.disabled = false;
  }
});

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

function appendBubble(role, content, { markdown = false, streaming = false } = {}) {
  const el = document.createElement("div");
  el.className = `bubble ${role}` + (streaming ? " streaming" : "");
  if (role === "assistant") setBubbleContent(el, content, { markdown: true, streaming });
  else { el.dataset.rawText = content || ""; el.textContent = content; }
  messagesEl.appendChild(el);
  scrollBottom();
  return el;
}

function scrollBottom() { messagesEl.scrollTop = messagesEl.scrollHeight; }

function updateSendState() {
  const canSend = !state.sending && !state.asrBusy && !holding && !!state.currentId && !!inputEl.value.trim() && !state.voiceMode;
  sendBtn.disabled = !canSend;
  sendBtn.classList.toggle("hidden", state.sending || state.voiceMode);
  stopBtn?.classList.toggle("hidden", !state.sending);
  if (holdBtn) holdBtn.disabled = state.sending || state.asrBusy;
  if (modeBtn) modeBtn.disabled = state.sending || holding || state.asrBusy;
}

inputEl.addEventListener("input", updateSendState);
$("#composer").addEventListener("submit", (e) => { e.preventDefault(); sendMessage(); });

async function sendMessage() {
  const text = inputEl.value.trim();
  if (!text || state.sending || !state.currentId) return;
  messagesEl.querySelector(".welcome")?.remove();
  state.sending = true;
  chatAbort = new AbortController();
  if (state.autoTts) unlockAudioPlayback();
  updateSendState();
  inputEl.value = "";
  appendBubble("user", text);
  const bubble = appendBubble("assistant", "正在想…", { markdown: true, streaming: true });
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
        try { payload = JSON.parse(line.slice(6)); } catch { continue; }
        if (payload.type === "status" && payload.message && !gotDelta) {
          setBubbleContent(bubble, payload.message, { streaming: true });
        } else if (payload.type === "delta" && payload.text) {
          if (!gotDelta) { gotDelta = true; finalText = ""; }
          if (payload.text.startsWith(finalText) && payload.text.length >= finalText.length) finalText = payload.text;
          else finalText += payload.text;
          setBubbleContent(bubble, finalText, { markdown: true, streaming: true });
        } else if (payload.type === "done") {
          finalText = payload.text || finalText;
          setBubbleContent(bubble, finalText, { markdown: true, streaming: false });
        } else if (payload.type === "error") {
          setBubbleContent(bubble, `抱歉：${payload.message}`, { streaming: false });
        }
      }
    }
    if (finalText) {
      setBubbleContent(bubble, finalText, { markdown: true, streaming: false });
      maybeAutoPlayTts(bubble);
    }
    await refreshSessions();
  } catch (err) {
    if (err?.name === "AbortError") setBubbleContent(bubble, "（已停止）", { streaming: false });
    else setBubbleContent(bubble, `抱歉：${err.message}`, { streaming: false });
  } finally {
    chatAbort = null;
    state.sending = false;
    updateSendState();
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
  showLogin();
}
init();
