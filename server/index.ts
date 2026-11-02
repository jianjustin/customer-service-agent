// 后端启动入口（SPEC §L）：dotenv → loadConfig → buildContainer → 恢复 → listen；SIGINT/SIGTERM 优雅关闭。
import "dotenv/config";
import { createApp } from "./app";
import { loadConfig, warnIfDefaultSecret } from "./config";
import { buildContainer } from "./container";

async function main(): Promise<void> {
  const config = loadConfig();
  warnIfDefaultSecret(config);
  const c = await buildContainer({
    dbPath: config.dbPath,
    checkpointPath: config.checkpointPath,
    startMcp: true,
    startOutboxWorker: true,
    mockDelayMs: config.mockDelayMs,
  });

  // 启动恢复：中断的 AI run、未完成的退款流程
  await c.services.conversation.recoverRuns();
  const report = await c.refundRunner.recoverRefundFlows();
  if (report.length > 0) console.error("[recovery] 退款流程恢复报告：", JSON.stringify(report));

  const app = createApp(c);
  const server = app.listen(config.port, () => {
    console.error(`[server] 已启动 http://localhost:${config.port}（模型模式：${c.modelInfo.mode}）`);
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[server] 收到 ${signal}，正在关闭…`);
    server.close(() => {
      c.close()
        .catch((e) => console.error("[server] 关闭容器失败：", e))
        .finally(() => process.exit(0));
    });
    server.closeAllConnections?.();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((e) => {
  console.error("[server] 启动失败：", e);
  process.exit(1);
});
