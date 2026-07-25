const state = {
  token: localStorage.getItem("gs_parent_token") || "",
  member: JSON.parse(localStorage.getItem("gs_parent_member") || "null"),
  members: [],
  selected: null,
  currentId: null,
  sending: false,
};

const $ = (sel) => document.querySelector(sel);
const loginView = $("#login-view");
const appView = $("#app-view");
const memberGrid = $("#member-grid");
const loginForm = $("#login-form");
const passwordInput = $("#password-input");
const passwordLabel = $("#password-label");
const loginHint = $("#login-hint");
const loginError = $("#login-error");
const selectedChip = $("#selected-chip");
const messagesEl = $("#messages");
const inputEl = $("#input");
const sendBtn = $("#send-btn");

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
  loginHint.textContent = m.has_password ? "输入密码进入家长端" : "首次进入请设置密码";
  loginError.classList.add("hidden");
  passwordInput.value = "";
  passwordInput.focus();
}

$("#back-btn").addEventListener("click", () => {
  state.selected = null;
  loginForm.classList.add("hidden");
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
    if (data.member.role !== "parent") throw new Error("请使用家长账户登录家长端");
    state.token = data.token;
    state.member = data.member;
    localStorage.setItem("gs_parent_token", state.token);
    localStorage.setItem("gs_parent_member", JSON.stringify(state.member));
    showApp();
    await boot();
  } catch (err) {
    loginError.textContent = err.message;
    loginError.classList.remove("hidden");
  } finally {
    btn.disabled = false;
  }
});

$("#logout-btn").addEventListener("click", () => {
  state.token = "";
  state.member = null;
  localStorage.removeItem("gs_parent_token");
  localStorage.removeItem("gs_parent_member");
  showLogin();
  loadMembers();
});

function appendBubble(role, content) {
  const el = document.createElement("div");
  el.className = `bubble ${role}`;
  if (role === "assistant") el.innerHTML = `<div class="md">${renderMarkdown(content)}</div>`;
  else el.textContent = content;
  messagesEl.appendChild(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return el;
}

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
  appendBubble("assistant", "你好，我是小葡萄家庭日程管家。可以问今日接送、钢琴课出发时间，或让我帮你核对路程缓冲。");
}

async function refreshBoard() {
  const data = await api("/api/schedule");
  $("#board-meta").textContent = `${data.weekday || ""} · ${new Date(data.now).toLocaleString("zh-CN")}`;
  const board = $("#reminder-board");
  const items = data.reminders_parent || [];
  board.innerHTML = items.length
    ? items
        .map(
          (r) => `<div class="reminder-card ${r.passed ? "passed" : ""}">
        <div class="title">${escapeHtml(r.title)} · ${escapeHtml(r.start || "")}</div>
        <div class="meta">${escapeHtml(r.place_name || "")} ${escapeHtml(r.place_address || "")}</div>
        <div class="meta">家长提前 ${r.advance_minutes} 分钟提醒 · ${escapeHtml(r.notes || "")}</div>
      </div>`
        )
        .join("")
    : `<div class="muted">今日暂无家长提醒项</div>`;

  const week = $("#week-list");
  const weekly = data.schedule?.weekly || [];
  week.innerHTML = weekly
    .map(
      (ev) => `<div class="week-item">
      <strong>${escapeHtml(ev.title)}</strong>
      <div class="meta">${(ev.days || []).join("、")} ${ev.start}-${ev.end} @ ${escapeHtml(ev.place_id || "")}</div>
      <div class="meta">孩子提前${ev.remind_child_minutes}分 / 家长提前${ev.remind_parent_minutes}分</div>
      <div class="meta">${escapeHtml(ev.notes || "")}</div>
    </div>`
    )
    .join("");

  $("#schedule-json").value = JSON.stringify(data.schedule, null, 2);
}

$("#save-schedule-btn").addEventListener("click", async () => {
  const msg = $("#schedule-msg");
  try {
    const schedule = JSON.parse($("#schedule-json").value);
    await api("/api/schedule", { method: "PUT", body: JSON.stringify({ schedule }) });
    msg.textContent = "已保存";
    await refreshBoard();
  } catch (err) {
    msg.textContent = err.message || "保存失败";
  }
});

async function refreshIterate() {
  const st = await api("/api/self-iterate/status");
  const el = $("#iterate-status");
  el.className = "iterate-status " + (st.activated ? "on" : "off");
  el.textContent = st.activated
    ? `已激活（${st.activated_at || ""}）· 历史 ${st.history_count} 条`
    : st.configured
      ? "未激活（需口令）"
      : "服务端未配置激活口令";
}

$("#activate-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("#iterate-msg");
  try {
    await api("/api/self-iterate/activate", {
      method: "POST",
      body: JSON.stringify({ code: $("#activate-code").value }),
    });
    msg.textContent = "激活成功";
    $("#activate-code").value = "";
    await refreshIterate();
  } catch (err) {
    msg.textContent = err.message;
  }
});

$("#deactivate-btn").addEventListener("click", async () => {
  const msg = $("#iterate-msg");
  try {
    await api("/api/self-iterate/deactivate", { method: "POST", body: "{}" });
    msg.textContent = "已关闭自迭代";
    await refreshIterate();
  } catch (err) {
    msg.textContent = err.message;
  }
});

$("#composer").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = inputEl.value.trim();
  if (!text || state.sending || !state.currentId) return;
  state.sending = true;
  sendBtn.disabled = true;
  inputEl.value = "";
  appendBubble("user", text);
  const bubble = appendBubble("assistant", "思考中…");
  try {
    const res = await fetch(`/api/sessions/${state.currentId}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${state.token}`,
      },
      body: JSON.stringify({ message: text }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || `失败 ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finalText = "";
    let gotDelta = false;
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
        if (payload.type === "status" && !gotDelta) bubble.textContent = payload.message;
        else if (payload.type === "delta" && payload.text) {
          if (!gotDelta) {
            gotDelta = true;
            finalText = "";
          }
          if (payload.text.startsWith(finalText) && payload.text.length >= finalText.length) {
            finalText = payload.text;
          } else finalText += payload.text;
          bubble.innerHTML = `<div class="md">${renderMarkdown(finalText)}</div>`;
        } else if (payload.type === "done") {
          finalText = payload.text || finalText;
          bubble.innerHTML = `<div class="md">${renderMarkdown(finalText)}</div>`;
        } else if (payload.type === "error") {
          bubble.textContent = `抱歉：${payload.message}`;
        }
      }
    }
  } catch (err) {
    bubble.textContent = `抱歉：${err.message}`;
  } finally {
    state.sending = false;
    sendBtn.disabled = false;
  }
});

async function boot() {
  await refreshBoard();
  await refreshIterate();
  await ensureSession();
}

async function init() {
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
