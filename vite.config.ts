import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defineConfig, type Plugin } from "vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * 工作台是纯前端 SPA。构建产物是一堆静态文件，Tauri 直接装进安装包。
 * 没有 SSR、没有 Node 服务端、没有数据库 —— 那些东西在桌面安装包里根本跑不起来，
 * 留着只会让开发时"能用"、装完之后不能用。
 */

/**
 * 开发专用：把本机 Host 的令牌交给开发服务器上的工作台。
 *
 * 桌面版由 Tauri 壳注入令牌；`npm run dev` 没有壳，所以从磁盘上的
 * data/host.token 读一次。**只在 vite dev 下注册**，构建产物里不存在这个接口。
 */
function hostTokenDevPlugin(): Plugin {
  return {
    name: "enclave:host-token-dev",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__enclave/host-token", (_req, res) => {
        res.setHeader("content-type", "application/json");
        try {
          const token = readFileSync(join(server.config.root, "data", "host.token"), "utf8").trim();
          res.end(JSON.stringify({ token, port: Number(process.env.ENCLAVE_HOST_PORT ?? 17891) }));
        } catch {
          res.statusCode = 404;
          res.end(JSON.stringify({ token: "", port: 0 }));
        }
      });
    },
  };
}

export default defineConfig({
  // 桌面端从 file:// 之上的自定义协议加载，必须用相对路径。
  base: "./",
  server: {
    // 开发服务器只绑回环：工作台会操作本机内核，不该在局域网里裸奔。
    host: "127.0.0.1",
    port: 8080,
    strictPort: true,
    watch: { ignored: ["**/data/**", "**/target/**", "**/logs/**"] },
  },
  preview: { host: "127.0.0.1", port: 8081, strictPort: true },
  resolve: { tsconfigPaths: true },
  plugins: [
    hostTokenDevPlugin(),
    tanstackRouter({ target: "react", autoCodeSplitting: true }),
    tailwindcss(),
    viteReact(),
  ],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
  },
});
