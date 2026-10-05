// REHEARSAL STAND-IN paging receiver (Phase 3 P4): listens on 127.0.0.1 only and logs every page the watcher sends
// through PAGE_LOCAL_WEBHOOK_URL (Discord-shaped JSON {"content"}), so a fork rehearsal can prove "alert fired and
// received" without the team's real Discord/Telegram channel (not configured: PHASE3_LOOP human inputs).
// Usage: PORT=8799 OUT=/path/pages.log pnpm page-receiver   →   PAGE_LOCAL_WEBHOOK_URL=http://127.0.0.1:8799/page
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

const port = Number(process.env.PORT ?? "8799");
const out = process.env.OUT;
createServer((req, res) => {
  if (req.method !== "POST") {
    res.writeHead(405).end();
    return;
  }
  let body = "";
  req.on("data", (c: Buffer) => {
    body += c.toString("utf8");
    if (body.length > 10_000) req.destroy();
  });
  req.on("end", () => {
    let content = body;
    try {
      content = String((JSON.parse(body) as { content?: unknown }).content ?? body);
    } catch {
      // keep the raw body
    }
    const line = `${new Date().toISOString()} RECEIVED PAGE ${JSON.stringify(content)}`;
    console.log(line);
    if (out) appendFileSync(out, `${line}\n`);
    res.writeHead(204).end();
  });
}).listen(port, "127.0.0.1", () => console.log(`page-receiver (REHEARSAL STAND-IN) on http://127.0.0.1:${port}`));
