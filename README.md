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
| 前台 | `/` | 小葡萄 | 可爱易用的 chatbot；默认打字（可选语音）；问今日安排/钢琴课/该在哪 |
| 家长端 | `/parent` | 爸爸、妈妈、奶奶 | 今日提醒看板、周程预览、编辑日程 JSON、家长对话 |

### 1.2 核心能力

1. **预制日程表**作为每次 chat 的系统上下文（地点、路程缓冲、按成员 @ 的提前提醒）。
2. **语音**：百炼 ASR（`qwen3-asr-flash`）+ TTS（`cosyvoice-v2`）；截图经视觉模型转写后再进对话。
3. **双模型路由**：
   - 默认：百炼 **DeepSeek V4 Flash**（`deepseek-v4-flash`）+ 日程 function calling
   - 困难任务：Cursor Cloud Agents **Grok 4.5**（`grok-4.5`）
4. **提醒对象自动选定**：用户只需说行程；管家按角色决定提醒谁（孩子/接送家长等）并写入 `reminders`。用户不必在对话里写 `@`。

### 1.3 非目标（当前阶段不做）

- 真实推送（APNs / 微信服务号 / 短信）
- 地图导航与实时路况
- 完整可视化日程编辑器（目前家长端用 JSON 高级编辑）
- 自迭代自动改代码 / 无人值守部署闭环（已移除，先把基础功能做好）

---

## 2. 实现设计

### 2.1 仓库结构

```
grape-schedule/
  backend/
    store.py             # 统一持久化：data/app_store.json（日程 + 变更日志）
    schedule_tools.py    # 大模型 function calling → 真正写库；reminders 必填
    schedule_context.py  # 按 @成员 展开今日提醒
    ...
  data/app_store.json    # 唯一业务数据源（部署时不覆盖服务器已有文件）
```

### 2.2 提醒数据模型

```json
"reminders": [
  {"member_id": "xiaoputao", "minutes_before": 20},
  {"member_id": "mom", "minutes_before": 55}
]
```

成员别名：小葡萄/葡萄→`xiaoputao`，爸爸→`dad`，妈妈→`mom`，奶奶→`grandma`。写入时若缺少 reminders 会报错。

### 2.3 统一存储与写库规则

- **唯一数据源**：服务器本地文件 `data/app_store.json`（不接外部数据库/云存储）。
- 家长在对话中告知行程时，DeepSeek 必须调用工具落库。
- 禁止编造与「示例」地址；库空时只能说未录入。
- 会话在 `data/sessions/`。

### 2.4 账户与角色

- `xiaoputao`（child）→ 前台
- `dad` / `mom` / `grandma`（parent）→ 家长端
- 无密码：点选身份即可进入；会话存 `data/sessions/{user_id}/`

### 2.5 模型路由策略

| 难度 | 触发 | Provider |
|---|---|---|
| `easy` | 默认日常问答 | DeepSeek `DEEPSEEK_MODEL` |
| `hard` | 关键词：复杂规划/架构设计等，或超长输入 | Cursor `CURSOR_MODEL_ID` |

### 2.6 语音与 HTTPS

- 浏览器麦克风要求安全上下文：部署脚本为 `grape-schedule.<ip>.sslip.io` 反代到 `8766`
- 勿与 grape-doctor（8765）的 Caddy 站点块互相覆盖

### 2.7 API 一览

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查 |
| GET | `/api/members?role=child\|parent` | 成员列表 |
| POST | `/api/login` | 选身份进入（无需密码，body: `{user_id}`） |
| GET/PUT | `/api/schedule` | 读日程 / 家长写日程（含 `reminders` / `reminders_by_member`） |
| CRUD | `/api/sessions...` | 会话 |
| POST | `/api/sessions/{id}/chat` | SSE 流式对话 |
| POST | `/api/asr` `/api/tts` | 语音 |

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

## 5. 后续建议任务清单

1. **真实提醒引擎**：扫描 `reminders`，定时任务写日志，看板显示「即将提醒」。
2. **可视化日程编辑**：拖拽周视图，替代 JSON。
3. **补全真实地址与路程**：对话告知真实住址/学校/琴房与分钟数。
4. **推送通道**：微信模板消息 / 家庭群机器人。
5. **儿童安全**：敏感话题拒答、家长审计日志。

---

## 6. 与 grape-doctor-family 的关系

本项目迁移了 DashScope ASR/TTS、登录/会话存储、Cursor Agents 客户端骨架；领域改为日程，拆分 child/parent 双入口，提醒按成员 @ 落库。
