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

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODELS[tier] || MODELS.default, max_tokens: 2500, messages }),
    });
    const data = await r.json();
    if (!r.ok) {
      const code = r.status === 429 ? "rate_limited" : "upstream_error";
      return res.status(r.status === 429 ? 429 : 502).json({ error: (data.error && data.error.message) || "Claude error", code });
    }
    const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
    return res.status(200).json({ text, truncated: data.stop_reason === "max_tokens" });
  } catch (e) {
    return res.status(502).json({ error: String(e), code: "upstream_error" });
  }
}
