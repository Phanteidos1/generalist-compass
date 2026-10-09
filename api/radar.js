// Hidden Jobs Radar: searches recent news for companies that are about to need someone like this person.
// Uses Claude with web search. Needs ANTHROPIC_API_KEY, and web search allowed in your Anthropic Console.

export const config = { maxDuration: 60 };

function cleanJson(text) {
  let t = String(text || "").trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const a = t.search(/[\[{]/);
  const b = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
  if (a < 0 || b <= a) return null;
  const block = t.slice(a, b + 1);
  for (const c of [block, block.replace(/[\u0000-\u001F]+/g, " ")]) {
    try { return JSON.parse(c); } catch (e) {}
  }
  return null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: "Server is missing ANTHROPIC_API_KEY" });

  const { person, focus } = req.body || {};
  const p = JSON.stringify(person || {}).slice(0, 5000);
  const f = String(focus || "").slice(0, 200);
  const today = new Date().toISOString().slice(0, 10);
  const way = String((person && person.chosen_way_in) || "").slice(0, 300);

  const prompt = `Today is ${today}. You are a headhunter who finds jobs before they are posted.

Use web search to find 5 real companies that, in the last 60 days, raised funding, announced expansion into a new country or market, launched a new product line, or opened a new office, AND that would plausibly need someone like the person below in the next few months. Prefer young or mid-sized companies (under about 500 people), where one person can make a difference.
${f ? "Focus on: " + f + "\n" : ""}${way ? `
The person chose ONE way in: "${way}".
Prefer companies where THIS way in is most likely to work. If you cannot find 5 like that, fill the list with the next best companies that fit the person. Always return 5. For example:
- a project or trial: companies with a concrete, time-bound need right now (a launch date, a new market opening, an event).
- pitching a problem: companies whose news creates a visible new problem (entering a country, a new product line, fast hiring).
- going through people: founder-led companies small enough that a warm intro reaches the decision maker.
- anything else: reason about what makes that way in land, and pick for it.
The message must USE that way in (for example, propose the specific project, or name the problem and a first step).
` : ""}
The person (JSON):
${p}

Reply with ONLY a JSON array, no prose, like:
[{"company":"...","event":"...","date":"...","source":"https://...","why":"...","who":"...","message":"...","intro":"..."}]

Rules:
- Return exactly 5 companies, best first.
- Only companies you actually found in search results. Never invent a company, a person or a fact.
- source = the URL of the article or page where you found the news.
- event: what happened, max 20 words. date: when, as specific as the source allows.
- why: max 22 words on why this moment creates a need this person fits.
- who: the role to contact, plus the person's name only if the source names them.
- message: max 60 words, first person, to that contact, leading with their news and the problem they now have. No cliches.
- intro: max 45 words, first person, to a friend of the person, asking if they know anyone at the company, saying in plain words what the company just did and how the person could help. Use [name] for the friend.
- Write the text values in the language of the person's story.`;

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-5-5",
        max_tokens: 6000,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 6 }],
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const data = await r.json();
    if (!r.ok) {
      console.log("Radar Claude error", r.status, JSON.stringify(data).slice(0, 600));
      return res.status(502).json({ error: (data.error && data.error.message) || "Claude error" });
    }
    const blocks = data.content || [];
    const lastText = blocks.filter(b => b.type === "text").map(b => b.text).join("");
    const list = cleanJson(lastText);
    if (!Array.isArray(list)) {
      console.log("Radar: no JSON. stop:", data.stop_reason, "text:", lastText.slice(0, 400));
      return res.status(502).json({ error: "The search came back without results. Try again." });
    }
    const clean = list.filter(x => x && x.company && /^https?:\/\//.test(String(x.source || ""))).slice(0, 3);
    console.log("Radar: model returned", list.length, "kept", clean.length);
    return res.status(200).json({ companies: clean });
  } catch (e) {
    console.log("Radar failure", String(e));
    return res.status(502).json({ error: String(e) });
  }
}
