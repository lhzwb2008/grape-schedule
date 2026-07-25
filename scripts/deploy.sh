#!/usr/bin/env bash
# 部署小葡萄日程智能体到 AItest-linux2
# 用法: SSHPASS='xxx' ./scripts/deploy.sh
set -euo pipefail

HOST="${DEPLOY_HOST:-101.201.237.149}"
USER="${DEPLOY_USER:-root}"
REMOTE_DIR="${DEPLOY_DIR:-/opt/grape-schedule}"
PORT="${DEPLOY_PORT:-8766}"
# 与 grape-doctor 共用同一 IP 的 Caddy 时，用独立子域避免冲突
HTTPS_HOST="${DEPLOY_HTTPS_HOST:-grape-schedule.${HOST}.sslip.io}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [[ -z "${SSHPASS:-}" ]]; then
  echo "请设置环境变量 SSHPASS=服务器密码"
  exit 1
fi

RSYNC=(sshpass -e rsync -avz -e "ssh -o StrictHostKeyChecking=accept-new")
SSH=(sshpass -e ssh -o StrictHostKeyChecking=accept-new)

echo "==> 停止远程服务（如已运行）…"
"${SSH[@]}" "${USER}@${HOST}" "systemctl stop grape-schedule 2>/dev/null || true"

echo "==> 同步代码到 ${REMOTE_DIR}…"
"${RSYNC[@]}" --delete \
  --exclude '.venv' \
  --exclude '__pycache__' \
  --exclude 'data/users/' \
  --exclude 'data/sessions/' \
  --exclude 'data/app_store.json' \
  --exclude '.git' \
  --exclude '*.pyc' \
  --exclude '.DS_Store' \
  --exclude '.cursor' \
  --exclude '.deploy.secret' \
  "${ROOT}/" "${USER}@${HOST}:${REMOTE_DIR}/"

echo "==> 远程安装并启动 systemd + HTTPS…"
"${SSH[@]}" "${USER}@${HOST}" "bash -s" <<EOF
set -e
cd ${REMOTE_DIR}
python3 -m venv .venv
. .venv/bin/activate
pip install -q -r requirements.txt
mkdir -p data/users data/sessions
# 统一存储：若不存在则写入空真实结构（无演示数据）；已有文件不覆盖
if [[ ! -f data/app_store.json ]]; then
  cat > data/app_store.json <<'STORE'
{
  "version": 1,
  "updated_at": null,
  "schedule": {
    "child_name": "小葡萄",
    "timezone": "Asia/Shanghai",
    "home": {"name": "家", "address": "", "lat": null, "lng": null},
    "places": [],
    "travel_buffers": [],
    "weekly": [],
    "one_off": [],
    "reminder_rules": {
      "child_tone": "亲切、简短、鼓励",
      "parent_tone": "清晰、可执行，包含地点、出发时间、接送建议",
      "default_advance_minutes": 30
    }
  },
  "change_log": []
}
STORE
fi
# 清理遗留 mock / 自迭代文件
rm -f data/schedule.json data/self_iterate.json
python3 - <<'PY'
import json
from pathlib import Path
p = Path("data/app_store.json")
if p.exists():
    data = json.loads(p.read_text(encoding="utf-8"))
    changed = False
    if "self_iterate" in data:
        data.pop("self_iterate", None)
        changed = True
    sch = data.get("schedule") if isinstance(data.get("schedule"), dict) else None
    if sch is not None:
        home = sch.get("home") if isinstance(sch.get("home"), dict) else {}
        home_name = (home.get("name") or "家").strip() or "家"
        places = []
        for item in sch.get("places") or []:
            if not isinstance(item, dict):
                continue
            if item.get("id") == "home":
                changed = True
                continue
            if (item.get("name") or "").strip() in (home_name, "家", "家里"):
                changed = True
                continue
            places.append(item)
        if places != (sch.get("places") or []):
            sch["places"] = places
            changed = True
    if changed:
        p.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print("已清理 app_store.json（自迭代字段 / 重复的家）")
PY

cat > /etc/systemd/system/grape-schedule.service <<UNIT
[Unit]
Description=Grape Schedule Agent (Xiaoputao)
After=network.target

[Service]
Type=simple
WorkingDirectory=${REMOTE_DIR}
EnvironmentFile=${REMOTE_DIR}/.env
ExecStart=${REMOTE_DIR}/.venv/bin/python -m uvicorn backend.main:app --host 0.0.0.0 --port ${PORT}
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT

if ! command -v caddy >/dev/null 2>&1; then
  echo "安装 Caddy…"
  curl -fsSL "https://caddyserver.com/api/download?os=linux&arch=amd64" -o /usr/local/bin/caddy
  chmod +x /usr/local/bin/caddy
fi
mkdir -p /etc/caddy /var/lib/caddy /var/log/caddy

# 合并进现有 Caddyfile：追加 grape-schedule 站点块（若不存在）
if [[ -f /etc/caddy/Caddyfile ]] && grep -q "grape-schedule" /etc/caddy/Caddyfile; then
  echo "Caddy 已包含 grape-schedule 站点，跳过写入站点块"
else
  cat >> /etc/caddy/Caddyfile <<CADDY

${HTTPS_HOST} {
  encode gzip
  reverse_proxy 127.0.0.1:${PORT}
}
CADDY
fi

# 若尚无 caddy.service，创建基础服务
if [[ ! -f /etc/systemd/system/caddy.service ]]; then
cat > /etc/systemd/system/caddy.service <<UNIT
[Unit]
Description=Caddy HTTPS reverse proxy
After=network.target

[Service]
Type=simple
User=root
Environment=HOME=/var/lib/caddy
Environment=XDG_CONFIG_HOME=/var/lib/caddy/config
Environment=XDG_DATA_HOME=/var/lib/caddy/data
WorkingDirectory=/var/lib/caddy
ExecStart=/usr/local/bin/caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
ExecReload=/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
Restart=always
RestartSec=3
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
UNIT
fi

systemctl daemon-reload
systemctl enable grape-schedule caddy >/dev/null
systemctl restart grape-schedule
sleep 1
systemctl reload caddy 2>/dev/null || systemctl restart caddy
sleep 4
systemctl --no-pager --full status grape-schedule | head -14
curl -sf http://127.0.0.1:${PORT}/api/health
echo
curl -sf --max-time 20 https://${HTTPS_HOST}/api/health || echo "(HTTPS 若失败，请确认 80/443 已放行)"
echo
echo "前台(小葡萄): http://${HOST}:${PORT}/"
echo "家长端:       http://${HOST}:${PORT}/parent"
echo "语音建议 HTTPS: https://${HTTPS_HOST}/"
EOF
