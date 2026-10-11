// Shared helpers for the serverless functions. Files starting with "_" are not
// exposed as endpoints by Vercel.
// Storage: Upstash Redis (env KV_REST_API_URL / KV_REST_API_TOKEN).

import { createHash } from "node:crypto";

export const storeReady = () => !!(storeUrl() && storeToken());
const storeUrl = () => process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const storeToken = () => process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

export async function redis(cmds) {
  const r = await fetch(storeUrl() + "/pipeline", {
    method: "POST",
    headers: { Authorization: "Bearer " + storeToken(), "content-type": "application/json" },
    body: JSON.stringify(cmds),
  });
  const data = await r.json();
  if (!r.ok || !Array.isArray(data)) throw new Error("storage error " + r.status);
  return data.map(x => x.result);
}

export const s = (v, n) => String(v == null ? "" : v).replace(/[\u0000-\u001F]+/g, " ").trim().slice(0, n);
export const hash = t => createHash("sha256").update(String(t)).digest("hex");
export const parse = x => { try { return JSON.parse(x); } catch (e) { return null; } };

export function clientIp(req) {
  return s((req.headers["x-forwarded-for"] || "").split(",")[0] || req.socket?.remoteAddress || "x", 64);
}

// True when this caller went over `max` hits in the last hour for this bucket.
export async function limited(bucket, who, max) {
  const key = "gc:rl:" + bucket + ":" + hash(who).slice(0, 16);
  const [n] = await redis([["INCR", key], ["EXPIRE", key, 3600, "NX"]]);
  return n > max;
}
