#!/usr/bin/env bash
#
# 同步 docs 主仓的 submodule 指针到各子仓 origin/main。
#
# 每次前端(web)/后端(api)的 main 有新提交后，运行本脚本即可把主仓记录的
# gitlink 更新到最新，并在有变化时生成一条提交（默认不推送）。
#
# 用法：
#   scripts/sync-submodules.sh            # 更新 + 提交（不推送）
#   scripts/sync-submodules.sh --push     # 更新 + 提交 + 推送到当前分支
#   scripts/sync-submodules.sh --dry-run  # 只显示会变什么，不改动、不提交
#
set -euo pipefail

PUSH=0
DRY=0
case "${1:-}" in
  --push)    PUSH=1 ;;
  --dry-run) DRY=1 ;;
  "")        ;;
  *) echo "未知参数：$1（可用：--push | --dry-run）"; exit 2 ;;
esac

# 切到主仓根目录（脚本无论从哪调用都成立）
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

if [ ! -f .gitmodules ]; then
  echo "当前仓库没有 .gitmodules，无 submodule 可同步。"; exit 0
fi

# 读取所有 submodule 路径（兼容 macOS 自带 bash 3.2，不用 mapfile）
PATHS=()
while IFS= read -r line; do
  PATHS+=("${line##* }")
done < <(git config --file .gitmodules --get-regexp '^submodule\..*\.path$')

if [ "${#PATHS[@]}" -eq 0 ]; then
  echo ".gitmodules 里没有配置任何 path。"; exit 0
fi

echo "▶ 同步 ${#PATHS[@]} 个 submodule 到各自 origin/main …"
CHANGED=0
for p in "${PATHS[@]}"; do
  if [ ! -e "$p/.git" ]; then
    echo "  ⚠ $p 未初始化，执行 submodule update --init"
    git submodule update --init "$p"
  fi
  before="$(git -C "$p" rev-parse --short HEAD)"
  git -C "$p" fetch origin --quiet
  target="$(git -C "$p" rev-parse --short origin/main)"
  if [ "$before" = "$target" ]; then
    echo "  = $p 已是最新 ($target)"
    continue
  fi
  CHANGED=1
  if [ "$DRY" -eq 1 ]; then
    echo "  ~ $p $before → $target（dry-run，未改动）"
  else
    git -C "$p" checkout main --quiet
    git -C "$p" merge --ff-only origin/main --quiet
    echo "  ↑ $p $before → $(git -C "$p" rev-parse --short HEAD)"
  fi
done

if [ "$DRY" -eq 1 ]; then
  [ "$CHANGED" -eq 0 ] && echo "✔ 所有指针已最新，无需同步。" || echo "ℹ dry-run 结束：以上为将要更新的指针。"
  exit 0
fi

# 暂存指针变化
git add "${PATHS[@]}"
if git diff --cached --quiet; then
  echo "✔ 指针无变化，无需提交。"
  exit 0
fi

echo "▶ 指针变化："
git diff --cached --submodule=short | grep -E '^Subproject|^-Subproject|^\+Subproject' || true

# 组装提交信息：主题 + 每个 submodule 的目标 commit
BODY=""
for p in "${PATHS[@]}"; do
  BODY="${BODY}
- ${p} -> $(git -C "$p" rev-parse --short HEAD)"
done
git commit -q -m "chore: 同步 submodule 指针到各子仓 main" -m "$BODY"
echo "✔ 已提交：$(git rev-parse --short HEAD)"

if [ "$PUSH" -eq 1 ]; then
  branch="$(git rev-parse --abbrev-ref HEAD)"
  git push -q origin "$branch"
  echo "✔ 已推送到 origin/${branch}"
else
  echo "ℹ 未推送（加 --push 可自动推送）。当前分支：$(git rev-parse --abbrev-ref HEAD)"
fi
