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
  appendBubble("assistant", "你好，我是小葡萄家庭日程管家。请直接告诉我真实行程（时间、地点、路程），并说明提醒谁，例如 @小葡萄 和 @妈妈；我会写入统一存储。当前若为空，不会使用任何演示数据。");
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
    ? `本周 ${total} 条行程 · 色条表示首位被 @ 的人`
    : "本周暂无行程——在下方对话录入后会显示在这里";
}

function renderPlaces(schedule) {
  const el = $("#places-board");
  const places = schedule?.places || [];
  const home = schedule?.home;
  const travels = schedule?.travel_buffers || [];
  const placeName = (id) => places.find((p) => p.id === id)?.name || id;
  const bits = [];
  if (home?.address) {
    bits.push(`<div class="place-row"><strong>家</strong><span>${escapeHtml(home.address)}</span></div>`);
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
  const items = data.reminders || [];
  board.innerHTML = items.length
    ? items
        .map((r) => {
          const accent = MEMBER_COLORS[r.member_id] || "#2f8f5b";
          return `<div class="reminder-card ${r.passed ? "passed" : ""}" style="--ev-accent:${accent}">
        <div class="title">${escapeHtml(r.title)} · ${escapeHtml(r.start || "")}</div>
        <div class="meta">${escapeHtml(r.place_name || "")} ${escapeHtml(r.place_address || "")}</div>
        <div class="meta at">${escapeHtml(r.at_text || "@" + (r.member_name || ""))} · 提前 ${r.advance_minutes} 分钟</div>
        <div class="meta">${escapeHtml(r.notes || "")}</div>
      </div>`;
        })
        .join("")
    : `<div class="empty-soft">今日暂无提醒<br/><span>对话里说明 @谁 后会显示在这里</span></div>`;

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
          await refreshBoard();
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
