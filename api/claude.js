// Server-side bridge to Claude. Your API key stays here, never in the browser.
// Set ANTHROPIC_API_KEY in Vercel: Project > Settings > Environment Variables.

const MODELS = {
  quick: "claude-haiku-5-5",
  default: "claude-sonnet-5-5",
  complex: "claude-sonnet-5-5",
};
const MAX_INPUT = 60000; // characters

// AI readings can take 20 to 60 seconds; give the function room.
export const config = { maxDuration: 60 };

// If the answer is meant to be JSON, hand back clean, valid JSON.
function cleanJson(text) {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const a = t.search(/[\[{]/);
  const b = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
  if (a < 0 || b <= a) return null;
  if (a > 200) return null; // looks like prose, not JSON
  const block = t.slice(a, b + 1);
  for (const candidate of [block, block.replace(/[\u0000-\u001F]+/g, " ")]) {
    try { return JSON.stringify(JSON.parse(candidate)); } catch (e) {}
  }
  return null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: "Server is missing ANTHROPIC_API_KEY", code: "upstream_error" });

  const { input, tier } = req.body || {};
  let messages;
  if (typeof input === "string") messages = [{ role: "user", content: input }];
  else if (Array.isArray(input)) messages = input.filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim());
  if (!messages || !messages.length) return res.status(400).json({ error: "Empty input", code: "invalid_request" });
  const size = messages.reduce((n, m) => n + m.content.length, 0);
  if (size > MAX_INPUT) return res.status(413).json({ error: "Input too long", code: "prompt_too_large" });
  const wantsJson = /reply with only a json/i.test(messages[messages.length - 1].content);

  try {
    const body = { model: MODELS[tier] || MODELS.default, max_tokens: 4000, messages };
    if (wantsJson) body.system = "Reply with one valid JSON value only. No prose before or after, no code fences. Escape line breaks inside strings as \\n.";
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) {
      console.log("Claude error", r.status, JSON.stringify(data).slice(0, 500));
      const code = r.status === 429 ? "rate_limited" : "upstream_error";
      return res.status(r.status === 429 ? 429 : 502).json({ error: (data.error && data.error.message) || "Claude error", code });
    }
    let text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
    if (wantsJson) {
      const clean = cleanJson(text);
      if (clean) text = clean;
      else console.log("JSON not parseable. stop_reason:", data.stop_reason, "start:", text.slice(0, 300), "end:", text.slice(-300));
    }
    return res.status(200).json({ text, truncated: data.stop_reason === "max_tokens" });
  } catch (e) {
    console.log("Bridge failure", String(e));
    return res.status(502).json({ error: String(e), code: "upstream_error" });
  }
}
