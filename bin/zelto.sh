#!/usr/bin/env bash
# zelto — AI Programming Cockpit
# https://github.com/NimRTC/zelto

set -e

# dist/ 与 bin/ 平级（dist/cli/index.js），所以要从 bin/ 往上退一级。
# 这个脚本从落地那天起就找不到入口：当时把 dist/ 拼在 bin/ 底下，
# 而实际布局是两者平级 —— 只因为没人真的调用过它，才一直没被发现。
#
# 路径要解析成绝对路径：$0 可能是相对路径，而 zelto 以 cwd 当项目根，
# 换目录会改变它看到的东西。
#
# 路径形态要对上 node：Windows 上的 node 不认 /mnt/d/... 这种 POSIX 绝对路径
# （会当成 D:\mnt\d\...），WSL 里用 wslpath 转成 Windows 路径再交给它。
script_dir() {
  cd "$(dirname "$1")" || return 1
  if pwd -W >/dev/null 2>&1; then
    pwd -W            # Git Bash / MSYS
  elif command -v wslpath >/dev/null 2>&1; then
    wslpath -w "$(pwd)"   # WSL
  else
    pwd               # 原生 POSIX shell
  fi
}

here="$(script_dir "$0")"
node "$here/../dist/cli/index.js" "$@"
