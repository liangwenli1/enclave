#!/usr/bin/env bash
# 真机冒烟：用清单里真实的内核走一遍 登录 → 准入 → 启动 → 调试端口握手 → 停止 → 删除内核。
# 没有对应系统的机器时，CI 的 runner 就是那台机器；这一步不过就不出包。
#
# 工作台要登录后才能用、启动前要问服务器，所以这里起一个替身服务器（scripts/smoke-cloud.py）。
# 传进来的 enclave-host 必须是指向它编译的：
#   ENCLAVE_CLOUD_URL=http://127.0.0.1:17956 cargo build --release -p enclave-host
# 这一份只用来冒烟，不进安装包。
#
# 用法：scripts/smoke-host.sh <enclave-host 可执行文件>
set -euo pipefail
host_bin="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
port=17955
cloud_port=17956
token="$(printf 'smoke%.0s' 1 2 3 4 5 6 7 8)"
base="http://127.0.0.1:$port"

cp "$root/kernels.manifest.json" "$work/"
cd "$work"
# 已经下载过内核包的话（本机反复跑的时候），放进 SMOKE_KERNEL_CACHE 指的目录就不用再下一遍；哈希照样要核。
if [ -n "${SMOKE_KERNEL_CACHE:-}" ]; then
  mkdir -p data/kernels/downloads
  for f in "$SMOKE_KERNEL_CACHE"/*; do ln -s "$f" "data/kernels/downloads/$(basename "$f")"; done
fi
python3 "$root/scripts/smoke-cloud.py" "$cloud_port" > "$work/cloud.log" &
cloud_pid=$!
# 调试版的 Host 认这个环境变量；发布版不认，只认编译时写进去的地址。两种都传，脚本就不用关心拿到的是哪种。
ENCLAVE_CLOUD_URL="http://127.0.0.1:$cloud_port" ENCLAVE_HOST_TOKEN="$token" ENCLAVE_HOST_PORT="$port" ENCLAVE_HEADLESS=1 "$host_bin" &
host_pid=$!
trap 'kill "$host_pid" "$cloud_pid" 2>/dev/null || true; rm -rf "$work"' EXIT

call() { curl -sS --noproxy '*' -H "Authorization: Bearer $token" -H "content-type: application/json" "$@"; }
field() { python3 -c "import sys,json; d=json.load(sys.stdin); print(eval(sys.argv[1], {'d': d}))" "$1"; }

for _ in $(seq 1 40); do curl -s --noproxy '*' "$base/v1/health" >/dev/null && break; sleep 0.5; done

site="$(call "$base/v1/session" | field '(d["configured"], d["signedIn"])')"
[ "$site" = "(True, False)" ] || { echo "这个 enclave-host 不是指向冒烟替身服务器编译的：$site"; exit 1; }

echo "== 登录（设备令牌进系统钥匙串）"
call -X POST -d '{}' "$base/v1/session/login" >/dev/null
signed="$(call -X POST -d '{"code":"smoke-code-smoke-code-smoke-code"}' "$base/v1/session/complete")"
[ "$(echo "$signed" | field '(d["signedIn"], d["plan"]["plan"])')" = "(True, 'pro')" ] || { echo "登录失败：$signed"; exit 1; }

# 冒烟跑的是 Chromium 类（包小、每个平台都有稳定或预览版）。
version="$(call "$base/v1/kernel" | field 'd["defaultVersions"]["chromium"]')"
status_of() { call "$base/v1/kernel" | field '[k["status"] for k in d["kernels"] if k["record"]["version"] == "'"$version"'"][0].get("'"$1"'")'; }

echo "== 准入内核 $version（会下载，约 140–190 MB）"
call -X POST -d '{"version":"'"$version"'","allowPreviewChannel":true}' "$base/v1/kernel/admit" >/dev/null
for i in $(seq 1 450); do
  state="$(status_of state)"
  [ $((i % 10)) -eq 0 ] && echo "   $state $(status_of bytesReceived)"
  case "$state" in
    admitted) break ;;
    error|hash_mismatch) echo "准入失败：$(status_of error)"; exit 1 ;;
  esac
  sleep 2
done
[ "$state" = "admitted" ] || { echo "准入超时，停在 $state"; exit 1; }
exe="$(status_of executable)"
echo "   可执行文件：$exe"
if [ "$(uname)" = "Darwin" ]; then
  echo "   架构：$(lipo -archs "$exe")"
  codesign -dv "$exe" 2>&1 | sed 's/^/   /' || echo "   （没有签名）"
fi

echo "== 启动"
no_sandbox=false; [ "$(id -u)" = "0" ] && no_sandbox=true
spec='{"envId":"env_smoke","kernelVersion":"'"$version"'","allowNoSandbox":'"$no_sandbox"',"allowPreviewChannel":true,"extraFlags":[],"profile":{"seed":"424242","platform":"windows","platformVersion":"19.0.0","brand":"Chrome","brandVersion":"148.0.7778.215","hardwareConcurrency":8,"locale":"en-US","languages":["en-US","en"],"timezone":"America/Los_Angeles","window":{"width":1280,"height":800},"webrtc":{"mode":"replace"}}}'
started="$(call -X POST -d "$spec" "$base/v1/environments/start")"
[ "$(echo "$started" | field 'd["ok"]')" = "True" ] || { echo "启动失败：$started"; exit 1; }
cdp="$(echo "$started" | field 'd["port"]')"
pid="$(echo "$started" | field 'd["pid"]')"
grep -q "POST /api/v1/profiles/env_smoke/start" "$work/cloud.log" || { echo "启动前没有问服务器"; exit 1; }
echo "   pid $pid · 调试端口 $cdp · $(curl -s --noproxy '*' "http://127.0.0.1:$cdp/json/version" | field 'd["Browser"]')"

echo "== 正在用的内核不许删"
busy="$(call -X POST -d '{"version":"'"$version"'"}' "$base/v1/kernel/remove" | field 'd.get("code")')"
[ "$busy" = "KERNEL_IN_USE" ] || { echo "运行中居然删掉了内核：$busy"; exit 1; }

echo "== 停止"
call -X POST -d '{"envId":"env_smoke"}' "$base/v1/environments/stop" >/dev/null
sleep 2
left="$(call "$base/v1/kernel" | field 'len(d["runtimes"])')"
[ "$left" = "0" ] || { echo "停止后运行态还剩 $left 行"; exit 1; }
if kill -0 "$pid" 2>/dev/null; then echo "停止后进程 $pid 还活着"; exit 1; fi
grep -q "POST /api/v1/profiles/env_smoke/stop" "$work/cloud.log" || { echo "停止后没有把运行名额还给服务器"; exit 1; }

echo "== 删除内核"
removed="$(call -X POST -d '{"version":"'"$version"'"}' "$base/v1/kernel/remove" | field 'd["ok"]')"
[ "$removed" = "True" ] || { echo "删除失败"; exit 1; }
[ "$(status_of state)" = "absent" ] || { echo "删除后状态不是 absent：$(status_of state)"; exit 1; }
[ ! -e "$exe" ] || { echo "删除后可执行文件还在"; exit 1; }
echo "== 退出登录（令牌从系统钥匙串里删掉）"
call -X POST -d '{}' "$base/v1/session/logout" >/dev/null
[ "$(call "$base/v1/session" | field 'd["signedIn"]')" = "False" ] || { echo "退出后还是登录状态"; exit 1; }
echo "== 通过"
