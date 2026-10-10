// Recruiter board: anonymous generalist profiles, recruiter briefs, intro requests.
// Storage: Upstash Redis, added to the Vercel project from the Marketplace.
// It sets KV_REST_API_URL and KV_REST_API_TOKEN automatically.

import { createHash, randomBytes } from "node:crypto";

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

const TYPES = ["The Opener","The Connector","The Translator","The Fixer","The Operator","The Explorer","The Storyteller","The Strategist"];
const WORK = ["Remote","On-site or hybrid","Project or freelance"];

// Shown until enough real people are on the board. Clearly flagged as examples.
const EXAMPLE_PROFILES = [
  {id:"example-1",type:"The Connector",second:"The Translator",thread:"Ten years putting buyers and sellers together across Latin America and Southern Europe.",edge:"Trusted in three languages: closes deals other people can't get a meeting for.",thrive:["Small teams entering new countries","Partnership-led growth","A founder who lets them run"],region:"Lisbon",remote:true,example:true},
  {id:"example-2",type:"The Opener",second:"The Operator",thread:"Launched three products from zero, then handed each over once it ran.",edge:"Zero-to-one builder: product, first customers and first hires.",thrive:["Pre-launch or just-launched","Messy first year","Clear ownership"],region:"Berlin",remote:true,example:true},
  {id:"example-3",type:"The Fixer",second:"The Operator",thread:"Walked into three struggling operations and turned each around within a year.",edge:"Calm in chaos: finds the real bottleneck fast.",thrive:["Turnarounds","Operations under pressure","Hands-on roles"],region:"Tel Aviv",remote:false,example:true},
  {id:"example-4",type:"The Storyteller",second:"The Connector",thread:"Built three communities from nothing, from a festival to an online brand.",edge:"Turns a product into a community people talk about.",thrive:["Consumer brands","Community-led growth","Creative freedom"],region:"Barcelona",remote:true,example:true},
  {id:"example-5",type:"The Strategist",second:"The Explorer",thread:"Moved from finance to retail to tech, each time spotting where the market was going first.",edge:"Pattern recognition across industries.",thrive:["Leadership teams deciding direction","New markets","Ambiguous problems"],region:"Amsterdam",remote:true,example:true},
  {id:"example-6",type:"The Translator",second:"The Fixer",thread:"Bridged engineers, sales and clients in four countries.",edge:"Explains the complex simply, in five languages.",thrive:["International teams","Customer-facing technical work","Remote-first"],region:"Bangkok",remote:true,example:true}
];
const EXAMPLE_NEEDS = [
  {id:"example-n1",title:"Open our Spanish market from zero",problem:"We launch in Spain in spring. We need one person to land the first partners, sign the first clients and hire a small local team.",type:"The Opener",company:"Example travel startup",work:["Remote","Project or freelance"],at:1,example:true},
  {id:"example-n2",title:"Turn our partner network into deals",problem:"We have 200 partner contacts and no one owning them. We need someone who can rebuild trust and close the first ten deals.",type:"The Connector",company:"Example B2B platform",work:["Remote"],at:2,example:true},
  {id:"example-n3",title:"Build our community before launch",problem:"Pre-launch wellness app. We need someone to build a first community of 1,000 engaged users and the rituals that keep them.",type:"The Storyteller",company:"Example wellness app",work:["Remote","Project or freelance"],at:3,example:true}
];

async function redis(cmds) {
  const r = await fetch(URL_ + "/pipeline", {
    method: "POST",
    headers: { Authorization: "Bearer " + TOKEN, "content-type": "application/json" },
    body: JSON.stringify(cmds),
  });
  const data = await r.json();
  if (!r.ok || !Array.isArray(data)) throw new Error("storage error " + r.status);
  return data.map(x => x.result);
}

const s = (v, n) => String(v == null ? "" : v).replace(/[\u0000-\u001F]+/g, " ").trim().slice(0, n);
const list = (v, n, each) => (Array.isArray(v) ? v : []).map(x => s(x, each)).filter(Boolean).slice(0, n);
const hash = t => createHash("sha256").update(String(t)).digest("hex");
const idOf = t => "p" + hash("id:" + t).slice(0, 16);
const okToken = t => typeof t === "string" && /^[A-Za-z0-9_-]{24,80}$/.test(t);
const parse = x => { try { return JSON.parse(x); } catch (e) { return null; } };

async function limited(req, bucket, max) {
  const ip = s((req.headers["x-forwarded-for"] || "").split(",")[0] || req.socket?.remoteAddress || "x", 64);
  const key = "gc:rl:" + bucket + ":" + hash(ip).slice(0, 16);
  const [n] = await redis([["INCR", key], ["EXPIRE", key, 3600, "NX"]]);
  return n > max;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });
  if (!URL_ || !TOKEN) return res.status(503).json({ error: "The board isn't connected to its database yet." });
  const b = req.body || {};
  try {
    switch (b.action) {
      case "pool": {
        const [all] = await redis([["HVALS", "gc:profiles"]]);
        const real = (all || []).map(parse).filter(Boolean).sort((a, z) => (z.at || 0) - (a.at || 0)).slice(0, 200);
        const profiles = real.length >= 6 ? real : real.concat(EXAMPLE_PROFILES);
        return res.status(200).json({ profiles });
      }
      case "needs": {
        const [all] = await redis([["LRANGE", "gc:needs", 0, 59]]);
        const real = (all || []).map(parse).filter(n => n && !n.hidden).map(({ contact, token, ...pub }) => pub);
        const needs = real.length >= 3 ? real : real.concat(EXAMPLE_NEEDS);
        return res.status(200).json({ needs });
      }
      case "profile.save": {
        if (!okToken(b.token)) return res.status(400).json({ error: "Bad token" });
        if (await limited(req, "profile", 30)) return res.status(429).json({ error: "Too many changes. Try again later." });
        const p = b.profile || {};
        if (!TYPES.includes(p.type)) return res.status(400).json({ error: "Get your reading first." });
        const id = idOf(b.token);
        const prof = {
          id, type: p.type, second: TYPES.includes(p.second) ? p.second : "",
          thread: s(p.thread, 240), say: s(p.say, 200), edge: s(p.edge, 240),
          thrive: list(p.thrive, 3, 80), region: s(p.region, 60), remote: !!p.remote,
          at: Date.now(), example: false,
        };
        await redis([["HSET", "gc:profiles", id, JSON.stringify(prof)]]);
        return res.status(200).json({ profile: prof });
      }
      case "profile.delete": {
        if (!okToken(b.token)) return res.status(400).json({ error: "Bad token" });
        const id = idOf(b.token);
        await redis([["HDEL", "gc:profiles", id], ["DEL", "gc:intros:" + id]]);
        return res.status(200).json({ ok: true });
      }
      case "need.post": {
        if (await limited(req, "need", 8)) return res.status(429).json({ error: "You've posted a lot today. Try again later." });
        const n = b.need || {};
        const title = s(n.title, 120), problem = s(n.problem, 400);
        if (title.length < 4 || problem.length < 10) return res.status(400).json({ error: "The brief is too short." });
        const need = {
          id: "n" + randomBytes(8).toString("hex"), title, problem,
          type: TYPES.includes(n.type) ? n.type : "", company: s(n.company, 80),
          work: list(n.work, 3, 30).filter(w => WORK.includes(w)), contact: s(n.contact, 120),
          at: Date.now(), example: false,
        };
        await redis([["LPUSH", "gc:needs", JSON.stringify(need)], ["LTRIM", "gc:needs", 0, 199]]);
        return res.status(200).json({ id: need.id });
      }
      case "intro.request": {
        if (await limited(req, "intro", 20)) return res.status(429).json({ error: "Too many requests. Try again later." });
        const pid = s(b.profileId, 40);
        if (!/^p[0-9a-f]{16}$/.test(pid)) return res.status(400).json({ error: "That profile can't receive requests." });
        const [exists] = await redis([["HEXISTS", "gc:profiles", pid]]);
        if (!exists) return res.status(404).json({ error: "That profile is no longer on the board." });
        const contact = s(b.contact, 120);
        if (contact.length < 5) return res.status(400).json({ error: "Add how candidates can reach you." });
        const intro = { need: s(b.needId, 40), title: s(b.title, 120), company: s(b.company, 80), contact, at: Date.now() };
        await redis([["LPUSH", "gc:intros:" + pid, JSON.stringify(intro)], ["LTRIM", "gc:intros:" + pid, 0, 49]]);
        return res.status(200).json({ ok: true });
      }
      case "mine": {
        if (!okToken(b.token)) return res.status(400).json({ error: "Bad token" });
        const id = idOf(b.token);
        const [p, intros] = await redis([["HGET", "gc:profiles", id], ["LRANGE", "gc:intros:" + id, 0, 49]]);
        return res.status(200).json({ profile: parse(p), intros: (intros || []).map(parse).filter(Boolean) });
      }
      default:
        return res.status(400).json({ error: "Unknown action" });
    }
  } catch (e) {
    console.log("Board error", String(e));
    return res.status(502).json({ error: "The board is having trouble right now. Try again in a minute." });
  }
}
