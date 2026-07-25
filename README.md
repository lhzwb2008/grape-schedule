# 小葡萄日程提醒智能体（grape-schedule）

面向小朋友「小葡萄」的日程提醒 + 语音对话智能体；同时提供家长（爸爸/妈妈/奶奶）监管视角。

- GitHub：https://github.com/lhzwb2008/grape-schedule
- 线上 HTTP：http://101.201.237.149:8766/
- 家长端：http://101.201.237.149:8766/parent
- 语音 HTTPS（本项目独立域名，勿用裸 `IP.sslip.io`）：https://grape-schedule.101.201.237.149.sslip.io/

> 本 README 供后续 session 接替实现：含需求、架构、已实现范围、待办与部署约定。

---

## 1. 产品需求（摘要）

### 1.1 双端

| 端 | 入口 | 用户 | 目标 |
|---|---|---|---|
| 前台 | `/` | 小葡萄 | 可爱易用的 chatbot；默认「按住说话」；问今日安排/钢琴课/该在哪 |
| 家长端 | `/parent` | 爸爸、妈妈、奶奶 | 今日提醒看板、周程预览、编辑日程 JSON、家长对话、自迭代激活 |

### 1.2 核心能力

1. **预制日程表**作为每次 chat 的系统上下文（地点、路程缓冲、孩子/家长分别提前提醒分钟数）。
2. **语音**：百炼 ASR（`qwen3-asr-flash`）+ TTS（`cosyvoice-v2`），交互为按住说话（与 grape-doctor-family 同方案）。
3. **双模型路由**：
   - 默认：百炼 **DeepSeek V4 Flash**（`deepseek-v4-flash`）
   - 困难任务 / 自迭代：Cursor Cloud Agents **Grok 4.5**（`grok-4.5`）
4. **钢琴课等关键事项**：孩子与家长都要被提醒；家长提醒需覆盖路程时间。
5. **自迭代（深度功能）**：家长端口令激活后，才允许触发 Cursor Agent 改本仓库代码；**自动发布上线仍需后续完善**（当前为脚手架）。

### 1.3 非目标（当前阶段不做或仅占位）

- 真实推送（APNs / 微信服务号 / 短信）
- 地图导航与实时路况
- 完整可视化日程编辑器（目前家长端用 JSON 高级编辑）
- 无人值守自动部署闭环（自迭代只到「Agent 改代码」）

---

## 2. 实现设计

### 2.1 仓库结构

```
grape-schedule/
  backend/
    store.py             # 统一持久化：data/app_store.json（日程+自迭代+变更日志）
    schedule_tools.py    # 大模型 function calling → 真正写库
    ...
  data/app_store.json    # 唯一业务数据源（部署时不覆盖服务器已有文件）
```

### 2.2 统一存储与写库规则

- **唯一数据源**：`data/app_store.json`（不再使用演示用 `schedule.json`）。
- 家长在对话中告知行程时，DeepSeek 必须调用工具（`upsert_weekly_event` / `upsert_place` / `set_home` 等）落库。
- 禁止编造与「示例」地址；库空时只能说未录入，不能臆造钢琴课等。
- 账户会话仍在 `data/users/`、`data/sessions/`；与日程同属服务器本地持久化。

### 2.2 账户与角色

- `xiaoputao`（child）→ 前台
- `dad` / `mom` / `grandma`（parent）→ 家长端
- 首次登录设置密码，bcrypt 存 `data/users/`；会话存 `data/sessions/{user_id}/`

### 2.3 日程上下文注入

每次 `POST /api/sessions/{id}/chat`：

1. `build_schedule_context(member)` 生成「当前时间 / 今日行程 / 地点 / 路程缓冲 / 语气要求」
2. 写入 system prompt（孩子语气 vs 家长语气不同）
3. 附带最近约 12 轮历史，再请求模型

预制示例见 `data/schedule.json`（含周三/周六钢琴课与路程缓冲）。

### 2.4 模型路由策略

`backend/model_router.py`：

| 难度 | 触发 | Provider |
|---|---|---|
| `easy` | 默认日常问答 | DeepSeek `DEEPSEEK_MODEL`（默认 flash） |
| `hard` | 关键词：改代码/部署/重构/复杂规划等，或超长输入 | Cursor `CURSOR_MODEL_ID` |
| `self_iterate` | 家长端已激活，且用户明确「自迭代/自动改代码」或 `force_model` | Cursor + 改仓库指令 |

后续可把「是否 hard」改为小分类器或工具调用，不必死磕关键词。

### 2.5 自迭代深度激活

1. `.env` 配置 `SELF_ITERATE_ACTIVATION_CODE`
2. 家长登录 → `/api/self-iterate/activate` 校验口令 → `data/self_iterate.json` 记 `activated=true`
3. 未激活时，含「自迭代」意图的请求返回 403
4. 激活后走 Cursor Agent（`CURSOR_SANDBOX_REPO_URL` 指向本仓库）
5. **下一步（未完成）**：Agent 产出 PR / 本地 apply → `deploy.sh` 自动跑 → 健康检查回写家长端

### 2.6 语音与 HTTPS

- 浏览器麦克风要求安全上下文：部署脚本为 `grape-schedule.<ip>.sslip.io` 反代到 `8766`
- 勿与 grape-doctor（8765）的 Caddy 站点块互相覆盖；本项目 **追加** 独立 server block

### 2.7 API 一览

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查 |
| GET | `/api/members?role=child\|parent` | 成员列表 |
| POST | `/api/login` | 登录 |
| GET/PUT | `/api/schedule` | 读日程 / 家长写日程 |
| CRUD | `/api/sessions...` | 会话 |
| POST | `/api/sessions/{id}/chat` | SSE 流式对话 |
| POST | `/api/asr` `/api/tts` | 语音 |
| GET/POST | `/api/self-iterate/*` | 状态/激活/关闭 |

---

## 3. 本地启动

```bash
cd /Users/Wezhang/workspace/grape-schedule
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # 填入 DASHSCOPE_API_KEY、CURSOR_API_KEY 等
./scripts/run.sh
```

打开：http://127.0.0.1:8766/ 与 http://127.0.0.1:8766/parent

---

## 4. 部署（AItest-linux2）

- 主机：`101.201.237.149`（root）
- 目录：`/opt/grape-schedule`
- 端口：`8766`（避开 grape-doctor 的 8765）
- systemd：`grape-schedule.service`

```bash
SSHPASS="$(cat .deploy.secret 2>/dev/null || true)" ./scripts/deploy.sh
```

`.env` 会随 rsync 同步到服务器（勿把 `.deploy.secret` 提交进 git；已在 `.gitignore`）。

---

## 5. 后续 session 建议任务清单

1. **真实提醒引擎**：基于 `remind_*_minutes` + 路程，定时任务扫描，写 `data/reminders_log.json`，家长看板显示「即将提醒」。
2. **可视化日程编辑**：拖拽周视图，替代 JSON。
3. **补全真实地址**：替换 `schedule.json` 示例住址/学校/琴房，标定 `travel_buffers`。
4. **自迭代闭环**：Cursor Agent 改完 → 自动 `git push` + `deploy.sh` + 回归 `/api/health`；失败回滚。
5. **推送通道**：微信模板消息 / 家庭群机器人。
6. **儿童安全**：敏感话题拒答策略、家长审计日志。
7. **评测**：用固定问句集测 DeepSeek 默认路径与 Cursor 困难路径延迟/质量。

---

## 6. 与 grape-doctor-family 的关系

本项目从家庭医生助手迁移了：

- DashScope ASR/TTS 实现
- 登录/会话文件存储模式
- 按住说话前端交互
- Cursor Cloud Agents 客户端骨架

差异：默认模型改为百炼 DeepSeek；领域改为日程；拆分 child/parent 双入口；增加日程上下文与自迭代门禁。
