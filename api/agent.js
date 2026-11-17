// Vercel serverless handler: POST /api/agent
// (also reachable as POST /agent via the rewrite in vercel.json).
// Reads the RAW body and verifies the HMAC BEFORE parsing JSON.
// The store lives in /tmp on serverless (per-instance, ephemeral across
// cold starts) — see lib/store.mjs for the durability note and the
// Vercel Blob upgrade path. A module-level handler instance is reused
// across warm invocations, so the in-memory mirrors survive between
// requests on the same instance.
import { createHandler } from "../lib/handler.mjs";
import { Store } from "../lib/store.mjs";

const store = new Store();

const { handleAgent } = createHandler({
  secret: process.env.AGENT_GAMES_HMAC_SECRET || "",
  hmacFormat: process.env.AGENT_GAMES_HMAC_FORMAT || "hex",
  taskIdMode: process.env.GATEKEEPER_TASK_ID_MODE || "keccak",
  store,
  softBudgetMs: Number(process.env.SOFT_BUDGET_MS || 8000),
  maxFutureSkewMs: Number(process.env.MAX_FUTURE_SKEW_MS || 300000),
});

export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("allow", "POST");
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const rawBody = Buffer.concat(chunks);
  const result = await handleAgent(rawBody, req.headers || {});
  res.status(result.status);
  for (const [key, value] of Object.entries(result.headers)) res.setHeader(key, value);
  res.send(result.body);
}
