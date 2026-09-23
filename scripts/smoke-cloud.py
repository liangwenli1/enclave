#!/usr/bin/env python3
"""真机冒烟用的替身服务器。

工作台要登录、启动前要问服务器——冒烟测试跑在没有服务器的 CI 机器上，所以这里给一个只会说"行"的替身。
它只听回环地址，只在 scripts/smoke-host.sh 里用；enclave-host 的发布版只认打包时写进去的服务器地址，
冒烟用的那一份是专门指向这里编译出来的，不会进安装包（打包脚本会核对）。

用法：smoke-cloud.py <端口>
"""
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

PLAN = {"plan": "pro", "label": "Pro", "envLimit": 200, "concurrent": 8, "deviceLimit": 2, "api": "full"}
running = set()


class Handler(BaseHTTPRequestHandler):
    def reply(self, status, body):
        raw = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def handle_any(self):
        length = int(self.headers.get("content-length") or 0)
        if length:
            self.rfile.read(length)
        path = self.path.split("?")[0]
        print(f"{self.command} {path}", flush=True)
        if path == "/api/v1/device/exchange":
            return self.reply(200, {"ok": True, "token": "smoke-device-token", "deviceId": "smoke", "email": "smoke@example.test"})
        if self.headers.get("authorization") != "Bearer smoke-device-token":
            return self.reply(401, {"ok": False, "code": "UNAUTHENTICATED", "message": "no token"})
        if path == "/api/v1/entitlement":
            return self.reply(200, {"ok": True, "email": "smoke@example.test", "plan": PLAN, "expiresAt": None, "profiles": 1, "running": len(running)})
        parts = path.strip("/").split("/")  # api v1 profiles <id> [action]
        if parts[:3] == ["api", "v1", "profiles"] and len(parts) >= 4:
            env_id, action = parts[3], (parts[4] if len(parts) > 4 else self.command)
            if action in ("start", "heartbeat"):
                running.add(env_id)
                return self.reply(200, {"ok": True, "held": True, "leaseSeconds": 60})
            if action in ("stop", "DELETE"):
                running.discard(env_id)
            return self.reply(200, {"ok": True, "profiles": 1})
        if path == "/api/v1/device/logout":
            return self.reply(200, {"ok": True})
        self.reply(404, {"ok": False, "code": "NOT_FOUND", "message": path})

    do_GET = do_POST = do_PUT = do_DELETE = handle_any

    def log_message(self, *args):
        pass


HTTPServer(("127.0.0.1", int(sys.argv[1])), Handler).serve_forever()
