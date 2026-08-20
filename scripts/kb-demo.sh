#!/usr/bin/env bash
# One-shot knowledge-base demo for the dsh-kb opt-in plugin family.
#
# Boots a real headless session with kb-core mounted (personal library at
# <ws>/kb/cards, optional team git library), lets the model drive the kb_*
# tools against the live DeepSeek API, and prints the closed loop it just
# ran. Requires DEEPSEEK_API_KEY (read from the repo root .env when not
# exported). The session workspace defaults to /tmp/dsh-kb-demo-ws and the
# team repo to /tmp/dsh-kb-demo-team; both are created with a demo card when
# absent.
#
# Environment notes (macOS host): the CLI runs under the shell `node`
# (Node 22) with the absolute tsx loader, because the pnpm-managed Node 24
# cannot load node-addon-require-builtin (HMR boot fails). Source-mode only:
# no build artifacts are needed for the headless path.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ws="${DSH_KB_WS:-/tmp/dsh-kb-demo-ws}"
team="${DSH_KB_TEAM:-/tmp/dsh-kb-demo-team}"
overlay="${DSH_KB_OVERLAY:-/tmp/dsh-kb-overlay.yml}"
task="${DSH_KB_TASK:-用 kb_search 查询“告警”并读取命中的团队卡片，然后汇报每步结果}"

# --- API key ---------------------------------------------------------------
if [[ -z "${DEEPSEEK_API_KEY:-}" && -f "$repo_root/.env" ]]; then
  export DEEPSEEK_API_KEY="$(awk -F= '/^DEEPSEEK_API_KEY=/{print $2}' "$repo_root/.env")"
fi
if [[ -z "${DEEPSEEK_API_KEY:-}" ]]; then
  echo "kb-demo: DEEPSEEK_API_KEY is not exported and not present in $repo_root/.env" >&2
  exit 1
fi

# --- Demo data -------------------------------------------------------------
if [[ ! -f "$ws/kb/cards/P2/rule-demo-001.md" ]]; then
  mkdir -p "$ws/kb/cards/P2"
  cat > "$ws/kb/cards/P2/rule-demo-001.md" <<'CARD'
---
id: rule-demo-001
type: rule
title: 告警处置标准
库: personal
状态: draft
适用条件: 收到告警时
责任人: 演示员
有效期: 2099-01-01
标签:
  - 告警
---
## 核心结论
告警处置要先确认影响面，再决定处置动作。
## 应做
- 收集告警上下文
## 不应做
- 直接重启
CARD
  echo "kb-demo: seeded $ws/kb/cards/P2/rule-demo-001.md"
fi
if [[ ! -d "$team/.git" ]]; then
  mkdir -p "$team/cards"
  git -C "$team" init -q
  cat > "$team/cards/rule-team-009.md" <<'CARD'
---
id: rule-team-009
type: rule
title: 团队告警升级流程
库: team
状态: ready
适用条件: 团队值班收到告警
责任人: 团队
有效期: 2099-01-01
标签:
  - 告警
---
## 核心结论
按团队流程先确认影响面，超时未解决升级值班长。
CARD
  git -C "$team" add -A && git -C "$team" commit -qm "team demo card"
  echo "kb-demo: seeded team repo $team"
fi

# --- Overlay ---------------------------------------------------------------
cat > "$overlay" <<YAML
- insert:
    - id: kb-core
      name: '@deepseek-ai/dsh-kb-core'
      config:
        teamRepoPath: $team
        packs: []
YAML

# --- Launch ----------------------------------------------------------------
tsx_loader="$(node -e "console.log(require.resolve('tsx/esm'))")"
echo "kb-demo: workspace=$ws team=$team"
echo "kb-demo: task: $task"
cd "$ws"
TSX_TSCONFIG_PATH="$repo_root/tsconfig.json" \
  node --import "$tsx_loader" "$repo_root/apps/cli/src/bin.ts" \
    --profile headless --patch "$overlay" "$task"
