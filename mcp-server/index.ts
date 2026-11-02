// MCP stdio 入口：读 env DB_PATH、MCP_SHARED_SECRET；stdout 仅用于协议，日志只写 stderr。
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createOrdersMcpServer } from "./server";
import { createSqliteOrderReadRepository } from "./repo";

const dbPath = process.env.DB_PATH;
const secret = process.env.MCP_SHARED_SECRET;
if (!dbPath || !secret) {
  process.stderr.write("DB_PATH 与 MCP_SHARED_SECRET 必填\n");
  process.exit(1);
}

const repo = createSqliteOrderReadRepository(dbPath);
serveStdio(() => createOrdersMcpServer({ repo, secret }));
process.stderr.write(`[orders-mcp] started pid=${process.pid}\n`);
