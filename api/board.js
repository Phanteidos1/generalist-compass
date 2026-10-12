// Recruiter board: anonymous generalist profiles, recruiter briefs, intro requests.
// Storage: Upstash Redis, added to the Vercel project from the Marketplace.
// It sets KV_REST_API_URL and KV_REST_API_TOKEN automatically.
//
// Who owns what:
//   - Signed out: a profile belongs to a random key kept in that browser ("token").
//   - Signed in (email link, see auth.js): a profile belongs to the account ("session"),
//     so it follows the person to every device. "claim" moves a browser's profile and its
//     intro requests into the account the first time someone signs in there.
//   - Briefs posted while signed in remember their owner (never shown publicly), so the
//     recruiter can see and remove them later.
//
// Recruiter trust (work-email verification):
//   Signing in by email link proves the recruiter owns that address. If it is a company
//   address (not gmail, outlook and the like), briefs and intro requests carry that
//   company domain as "verified", and seekers see it.
//   Once email sign-in is switched on (RESEND_API_KEY set), posting a brief or asking for
//   an intro REQUIRES a verified work email: no anonymous recruiters. Before that, the
//   board stays open so the preview keeps working.

import { createHash, randomBytes } from "node:crypto";
import { userFromSession, workDomain } from "./auth.js";

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

const TYPES = ["The Opener","The Connector","The Translator","The Fixer","The Operator","The Explorer","The Storyteller","The Strategist"];
const WORK = ["Remote","On-site or hybrid","Project or freelance"];

// Shown until enough real people are on the board. Clearly flagged as examples.
const EXAMPLE_PROFILES = [
  {id:"example-1",type:"The Connector",second:"The Translator",thread:"Ten years putting buyers and sellers together across Latin America and Southern Europe.",edge:"Trusted in three languages: closes deals other people can't get a meeting for.",thrive:["Small teams entering new countries","Partnership-led growth","A founder who lets them run"],problems:[{title:"Got a stalled distributor deal signed in Brazil",result:"Signed in eight weeks after a year of silence."},{title:"Rebuilt a partner network after a bad launch",result:"Twelve of twenty partners active again within six months."}],region:"Lisbon",remote:true,example:true},
  {id:"example-2",type:"The Opener",second:"The Operator",thread:"Launched three products from zero, then handed each over once it ran.",edge:"Zero-to-one builder: product, first customers and first hires.",thrive:["Pre-launch or just-launched","Messy first year","Clear ownership"],problems:[{title:"Took a booking app from idea to first paying users",result:"First 1,000 paying users in five months."},{title:"Hired and handed over a first team of five",result:"The product ran without me after a year."}],region:"Berlin",remote:true,example:true},
  {id:"example-3",type:"The Fixer",second:"The Operator",thread:"Walked into three struggling operations and turned each around within a year.",edge:"Calm in chaos: finds the real bottleneck fast.",thrive:["Turnarounds","Operations under pressure","Hands-on roles"],problems:[{title:"Fixed late deliveries at a food distributor",result:"On-time deliveries went from about 70% to 95%."}],region:"Tel Aviv",remote:false,example:true},
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
const problems = v => (Array.isArray(v) ? v : []).slice(0, 6).map(x => x && typeof x === "object" ? {
  title: s(x.title, 90), situation: s(x.situation, 240), did: s(x.did, 300), result: s(x.result, 240),
} : null).filter(x => x && x.title && (x.situation || x.did || x.result));
const parse = x => { try { return JSON.parse(x); } catch (e) { return null; } };

// Whose profile is this call about? The signed-in account wins over the browser key.
// Returns { id, uid } or { error, status }.
async function owner(b, needToken) {
  if (b.session) {
    const u = await userFromSession(b.session);
    if (!u) return { status: 401, error: "You were signed out. Sign in again.", code: "signed_out" };
    return { id: idOf("user:" + u.id), uid: u.id };
  }
  if (okToken(b.token)) return { id: idOf(b.token), uid: "" };
  return { status: needToken ? 400 : 401, error: needToken ? "Bad token" : "Sign in first.", code: "no_owner" };
}
// Who is acting as a recruiter? { uid, domain } from the session, or { uid:"", domain:"" }.
// When verification is switched on, a missing or personal address is refused.
const verifyOn = () => !!process.env.RESEND_API_KEY;
async function recruiter(b) {
  let u = null;
  if (b.session) {
    u = await userFromSession(b.session);
    if (!u) return { status: 401, error: "You were signed out. Sign in again.", code: "signed_out" };
  }
  const domain = u ? workDomain(u.email) : "";
  if (verifyOn() && !u) return { status: 403, error: "Verify your work email first, so candidates know who you are.", code: "need_work_email" };
  if (verifyOn() && !domain) return { status: 403, error: "Sign in with your work email to post or ask for intros. Personal addresses like Gmail can't show which company you're with.", code: "need_work_email" };
  return { uid: u ? u.id : "", domain };
}
const fail = (res, o) => res.status(o.status).json({ error: o.error, code: o.code });
const needPublic = ({ contact, token, owner, ...pub }) => pub;

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
        const [all] = await redis([["LRANGE", "gc:needs", 0, 199]]);
        const real = (all || []).map(parse).filter(n => n && !n.hidden).map(needPublic);
        const needs = real.length >= 3 ? real : real.concat(EXAMPLE_NEEDS);
        return res.status(200).json({ needs });
      }
      case "profile.save": {
        const o = await owner(b, true);
        if (o.error) return fail(res, o);
        if (await limited(req, "profile", 30)) return res.status(429).json({ error: "Too many changes. Try again later." });
        const p = b.profile || {};
        if (!TYPES.includes(p.type)) return res.status(400).json({ error: "Get your reading first." });
        const id = o.id;
        const prof = {
          id, type: p.type, second: TYPES.includes(p.second) ? p.second : "",
          thread: s(p.thread, 240), say: s(p.say, 200), edge: s(p.edge, 240),
          thrive: list(p.thrive, 3, 80), problems: problems(p.problems), region: s(p.region, 60), remote: !!p.remote,
          at: Date.now(), example: false,
        };
        await redis([["HSET", "gc:profiles", id, JSON.stringify(prof)]]);
        return res.status(200).json({ profile: prof });
      }
      case "profile.delete": {
        const o = await owner(b, true);
        if (o.error) return fail(res, o);
        const id = o.id;
        await redis([["HDEL", "gc:profiles", id], ["DEL", "gc:intros:" + id]]);
        return res.status(200).json({ ok: true });
      }
      case "need.post": {
        const r = await recruiter(b);
        if (r.error) return fail(res, r);
        const uid = r.uid;
        if (await limited(req, "need", 8)) return res.status(429).json({ error: "You've posted a lot today. Try again later." });
        const n = b.need || {};
        const title = s(n.title, 120), problem = s(n.problem, 400);
        if (title.length < 4 || problem.length < 10) return res.status(400).json({ error: "The brief is too short." });
        const need = {
          id: "n" + randomBytes(8).toString("hex"), title, problem,
          type: TYPES.includes(n.type) ? n.type : "", company: s(n.company, 80),
          work: list(n.work, 3, 30).filter(w => WORK.includes(w)), contact: s(n.contact, 120),
          at: Date.now(), example: false, ...(uid ? { owner: uid } : {}), ...(r.domain ? { verified: r.domain } : {}),
        };
        await redis([["LPUSH", "gc:needs", JSON.stringify(need)], ["LTRIM", "gc:needs", 0, 199]]);
        return res.status(200).json({ id: need.id });
      }
      case "intro.request": {
        const r = await recruiter(b);
        if (r.error) return fail(res, r);
        if (await limited(req, "intro", 20)) return res.status(429).json({ error: "Too many requests. Try again later." });
        const pid = s(b.profileId, 40);
        if (!/^p[0-9a-f]{16}$/.test(pid)) return res.status(400).json({ error: "That profile can't receive requests." });
        const [exists] = await redis([["HEXISTS", "gc:profiles", pid]]);
        if (!exists) return res.status(404).json({ error: "That profile is no longer on the board." });
        const contact = s(b.contact, 120);
        if (contact.length < 5) return res.status(400).json({ error: "Add how candidates can reach you." });
        const intro = { need: s(b.needId, 40), title: s(b.title, 120), company: s(b.company, 80), contact, at: Date.now(), ...(r.domain ? { verified: r.domain } : {}) };
        await redis([["LPUSH", "gc:intros:" + pid, JSON.stringify(intro)], ["LTRIM", "gc:intros:" + pid, 0, 49]]);
        return res.status(200).json({ ok: true });
      }
      case "mine": {
        const o = await owner(b, true);
        if (o.error) return fail(res, o);
        const id = o.id;
        const [p, intros] = await redis([["HGET", "gc:profiles", id], ["LRANGE", "gc:intros:" + id, 0, 49]]);
        let briefs = [];
        if (o.uid) {
          const [all] = await redis([["LRANGE", "gc:needs", 0, 199]]);
          briefs = (all || []).map(parse).filter(n => n && n.owner === o.uid).map(({ token, owner, ...n }) => n);
        }
        return res.status(200).json({ profile: parse(p), intros: (intros || []).map(parse).filter(Boolean), briefs, account: !!o.uid });
      }
      case "claim": {
        // First sign-in on a browser that already had a profile: move it into the account.
        const o = await owner({ session: b.session }, false);
        if (o.error) return fail(res, o);
        if (!okToken(b.token)) return res.status(200).json({ moved: false });
        if (await limited(req, "claim", 30)) return res.status(429).json({ error: "Too many tries. Try again later." });
        const from = idOf(b.token), to = o.id;
        if (from === to) return res.status(200).json({ moved: false });
        const [oldP, newP, oldI, newI] = await redis([
          ["HGET", "gc:profiles", from], ["HGET", "gc:profiles", to],
          ["LRANGE", "gc:intros:" + from, 0, 49], ["LRANGE", "gc:intros:" + to, 0, 49],
        ]);
        const a = parse(oldP), z = parse(newP);
        if (!a && !(oldI || []).length) return res.status(200).json({ moved: false });
        const cmds = [];
        // Keep whichever profile was updated last, under the account's id.
        if (a && (!z || (a.at || 0) > (z.at || 0))) cmds.push(["HSET", "gc:profiles", to, JSON.stringify({ ...a, id: to })]);
        const intros = (newI || []).concat(oldI || []).map(parse).filter(Boolean)
          .sort((x, y) => (y.at || 0) - (x.at || 0)).slice(0, 50);
        if ((oldI || []).length) {
          cmds.push(["DEL", "gc:intros:" + to]);
          if (intros.length) cmds.push(["RPUSH", "gc:intros:" + to, ...intros.map(x => JSON.stringify(x))]);
        }
        cmds.push(["HDEL", "gc:profiles", from], ["DEL", "gc:intros:" + from]);
        await redis(cmds);
        return res.status(200).json({ moved: true });
      }
      case "need.delete": {
        const o = await owner({ session: b.session }, false);
        if (o.error) return fail(res, o);
        const nid = s(b.id, 40);
        const [all] = await redis([["LRANGE", "gc:needs", 0, 199]]);
        const raw = (all || []).find(x => { const n = parse(x); return n && n.id === nid && n.owner === o.uid; });
        if (!raw) return res.status(404).json({ error: "That brief is already gone." });
        await redis([["LREM", "gc:needs", 1, raw]]);
        return res.status(200).json({ ok: true });
      }
      default:
        return res.status(400).json({ error: "Unknown action" });
    }
  } catch (e) {
    console.log("Board error", String(e));
    return res.status(502).json({ error: "The board is having trouble right now. Try again in a minute." });
  }
}
