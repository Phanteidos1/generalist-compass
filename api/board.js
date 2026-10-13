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
//
// Intros are double opt-in:
//   1. A recruiter asks for an intro with a short "why you" note (5 a week per recruiter,
//      the week starts on Monday). The person sees the company, the brief, the note and
//      whether the work email is verified, but not the recruiter's contact details yet.
//   2. The person says yes (and shares a name and how to reach them) or "not this time".
//   3. Only after a yes do both sides see each other's contact details.
//   Records live in the hash gc:intro (id -> JSON). gc:intros:<profile id> lists the ids a
//   person received, gc:sent:<owner id> the ids a recruiter sent. Older lists may still hold
//   whole JSON requests from before double opt-in; those are shown as they were.
//
// Pitches are the other direction, also double opt-in:
//   1. A seeker with a board profile writes to a brief with a short plan (3 a week, week
//      starts Monday). Their name and contact go with it but stay hidden.
//   2. The company that posted the brief (signed in, so it has an owner) sees the anonymous
//      profile and the plan, then says "Yes, let's talk" (sharing how to reach them) or
//      "Not this time". Briefs posted signed out can't receive pitches.
//   3. Only after a yes do both sides see each other's contact details.
//   Records live in the hash gc:pitch (id -> JSON). gc:pitched:<profile id> lists the ids a
//   seeker sent, gc:pitches:<brief id> the ids a brief received.
//
// Messages: after a yes (on an intro or a pitch), both sides can write to each other here.
//   The thread id is the intro or pitch id. Only its two sides can read or write, and only
//   once the status is "yes". Each side is "person" (the seeker) or "company".
//   gc:msg:<thread id> is a list of JSON messages {by, text, at}, the last 200 kept.
//   gc:msgc:<thread id> is a hash of counters: <side> = messages that side sent,
//   seen:<side> = how many of the other side's messages that side has opened.
//
// Public numbers ("stats"): counted from the real records, never the examples.
//   Introductions asked = intro requests + pitches; "both said yes" = those with status yes;
//   hires = yes conversations where either side tapped "We're working together" ("hire.mark"
//   stores { by, at } as "hired" on the intro or pitch). Counted at most every 10 minutes and
//   kept in gc:stats:cache; an answer or a marked hire clears it so the numbers move right away.

import { createHash, randomBytes } from "node:crypto";
import { userFromSession, workDomain } from "./auth.js";

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

const TYPES = ["The Opener","The Connector","The Translator","The Fixer","The Operator","The Explorer","The Storyteller","The Strategist"];
const WORK = ["Remote","On-site or hybrid","Project or freelance"];
const INTROS_PER_WEEK = 5;
const PITCHES_PER_WEEK = 3;
// Weeks are counted from Monday 00:00 UTC.
const weekNo = (now = Date.now()) => Math.floor((now / 86400000 + 3) / 7);
const weekEnds = (now = Date.now()) => (weekNo(now) + 1) * 7 * 86400000 - 3 * 86400000;

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
const isIntroId = x => typeof x === "string" && /^i[0-9a-f]{16}$/.test(x);
const isPitchId = x => typeof x === "string" && /^k[0-9a-f]{16}$/.test(x);
const isNeedId = x => typeof x === "string" && /^n[0-9a-f]{16}$/.test(x);

// What each side may see of an intro. Contact details only after a yes.
function forSeeker(r) {
  const { from, pid, contact, seeker, ...pub } = r;
  return { ...pub, ...(r.status === "yes" ? { contact, seeker } : {}) };
}
function forRecruiter(r, prof) {
  const { from, contact, seeker, ...pub } = r;
  const who = prof ? { type: prof.type, second: prof.second || "", thread: prof.thread || "", region: prof.region || "" } : null;
  return { ...pub, profile: who, gone: r.status === "closed" || (!prof && r.status === "waiting"), ...(r.status === "yes" ? { seeker } : {}) };
}
async function loadIntros(ids) {
  ids = (ids || []).filter(isIntroId);
  if (!ids.length) return [];
  const [vals] = await redis([["HMGET", "gc:intro", ...ids]]);
  return (vals || []).map(parse).filter(Boolean);
}
async function weekUsed(rid, kind = "intro") {
  const [n] = await redis([["GET", "gc:wk:" + kind + ":" + rid + ":" + weekNo()]]);
  return Number(n) || 0;
}
async function loadPitches(ids) {
  ids = [...new Set((ids || []).filter(isPitchId))];
  if (!ids.length) return [];
  const [vals] = await redis([["HMGET", "gc:pitch", ...ids]]);
  return (vals || []).map(parse).filter(Boolean);
}
// The seeker sees their own pitch, and the company's reply only after a yes.
function forPitcher(k) {
  const { owner, from, reply, ...pub } = k;
  return { ...pub, ...(k.status === "yes" ? { reply } : {}) };
}
// The company sees the anonymous profile and the plan; name and contact only after a yes.
function forBriefOwner(k, prof) {
  const { owner, from, name, contact, reply, ...pub } = k;
  const who = prof ? { type: prof.type, second: prof.second || "", name: prof.name || "", thread: prof.thread || "", edge: prof.edge || "", region: prof.region || "", remote: !!prof.remote, problems: prof.problems || [] } : null;
  return { ...pub, profile: who, gone: !prof && k.status === "waiting", ...(k.status === "yes" ? { name, contact, reply } : {}) };
}

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
// Which side of a thread is this caller on? Returns { rec, side, other } or { status, error }.
const MSG_KEEP = 200;
async function threadFor(b) {
  const tid = s(b.id, 40);
  if (!isIntroId(tid) && !isPitchId(tid)) return { status: 400, error: "That conversation can't be found.", code: "no_thread" };
  const o = await owner(b, false);
  if (o.error) return o;
  const [raw] = await redis([["HGET", isIntroId(tid) ? "gc:intro" : "gc:pitch", tid]]);
  const rec = parse(raw);
  let side = "";
  if (rec && isIntroId(tid)) side = rec.pid === o.id ? "person" : rec.from === o.id ? "company" : "";
  if (rec && isPitchId(tid)) side = rec.from === o.id ? "person" : (o.uid && rec.owner === o.uid) ? "company" : "";
  if (!side) return { status: 404, error: "That conversation can't be found.", code: "no_thread" };
  if (rec.status !== "yes") return { status: 409, error: "Messages open once both of you have said yes.", code: "not_yes" };
  return { tid, rec, side, other: side === "person" ? "company" : "person" };
}
// Counters for many threads at once: { [id]: { total, unread } } from the given side's view.
async function chatMeta(items) {
  items = items.filter(x => x && x.id && x.side);
  if (!items.length) return {};
  const rows = await redis(items.map(x => ["HGETALL", "gc:msgc:" + x.id]));
  const out = {};
  items.forEach((x, i) => {
    const r = rows[i] || [], h = {};
    if (Array.isArray(r)) for (let j = 0; j + 1 < r.length; j += 2) h[r[j]] = Number(r[j + 1]) || 0;
    else Object.assign(h, r);
    const other = x.side === "person" ? "company" : "person";
    const total = (Number(h.person) || 0) + (Number(h.company) || 0);
    out[x.id] = { total, unread: Math.max(0, (Number(h[other]) || 0) - (Number(h["seen:" + x.side]) || 0)) };
  });
  return out;
}
// The public numbers, worked out from the records themselves so they can't drift.
const STATS_TTL = 600;
async function computeStats() {
  const [intros, pitches, findable, needs] = await redis([
    ["HVALS", "gc:intro"], ["HVALS", "gc:pitch"], ["HLEN", "gc:profiles"], ["LRANGE", "gc:needs", 0, 199],
  ]);
  const I = (intros || []).map(parse).filter(Boolean), K = (pitches || []).map(parse).filter(Boolean);
  const yes = x => x.status === "yes";
  const out = {
    findable: Number(findable) || 0,
    problems: (needs || []).map(parse).filter(n => n && !n.hidden && !n.example).length,
    intros: I.length, introsYes: I.filter(yes).length,
    pitches: K.length, pitchesYes: K.filter(yes).length,
    hires: I.concat(K).filter(x => yes(x) && x.hired).length,
    at: Date.now(),
  };
  out.asked = out.intros + out.pitches;
  out.yes = out.introsYes + out.pitchesYes;
  return out;
}

const fail = (res, o) => res.status(o.status).json({ error: o.error, code: o.code });
const needPublic = ({ contact, token, owner, ...pub }) => ({ ...pub, pitchable: !!owner });

async function limited(req, bucket, max) {
  const ip = s((req.headers["x-forwarded-for"] || "").split(",")[0] || req.socket?.remoteAddress || "x", 64);
  const key = "gc:rl:" + bucket + ":" + hash(ip).slice(0, 16);
  const [n] = await redis([["INCR", key], ["EXPIRE", key, 3600, "NX"]]);
  return n > max;
}

// What the weekly email says to one account (see weekly.js). Only real records, never examples.
//   since: when the last weekly email went out (answers after that count as new).
// Returns { profile, matches, requests, briefFits, counts }.
export async function weeklyData(uid, since = 0) {
  const id = idOf("user:" + uid);
  const [p, introList, sentIds, pitchedIds, allNeeds] = await redis([
    ["HGET", "gc:profiles", id], ["LRANGE", "gc:intros:" + id, 0, 49], ["LRANGE", "gc:sent:" + id, 0, 99],
    ["LRANGE", "gc:pitched:" + id, 0, 99], ["LRANGE", "gc:needs", 0, 199],
  ]);
  const profile = parse(p);
  const needs = (allNeeds || []).map(parse).filter(n => n && !n.hidden && !n.example);
  const pitches = await loadPitches(pitchedIds);
  const pitchedNeeds = new Set(pitches.map(k => k.need));

  // Three open problems that fit: same type first, then the second type, newest first.
  let matches = [];
  if (profile) {
    const score = n => (n.type && n.type === profile.type ? 2 : 0) + (n.type && n.type === profile.second ? 1 : 0) + (n.at > since ? 0.5 : 0);
    matches = needs.filter(n => n.owner !== uid && !pitchedNeeds.has(n.id))
      .sort((a, z) => score(z) - score(a) || (z.at || 0) - (a.at || 0)).slice(0, 3)
      .map(n => ({ id: n.id, title: n.title, problem: n.problem, company: n.company || "", type: n.type || "", verified: n.verified || "", work: n.work || [], fresh: (n.at || 0) > since, fit: !!n.type && (n.type === profile.type || n.type === profile.second), pitchable: !!n.owner }));
  }

  // Requests: what waits for this person, and what was answered since the last email.
  const got = (await loadIntros(introList)).filter(r => r.pid === id);
  const sentRecs = (await loadIntros(sentIds)).filter(r => r.from === id);
  const myBriefs = needs.filter(n => n.owner === uid);
  const briefLists = myBriefs.length ? await redis(myBriefs.map(n => ["LRANGE", "gc:pitches:" + n.id, 0, 199])) : [];
  const onBriefs = (await loadPitches(briefLists.flat())).filter(k => k.owner === uid);
  const requests = {
    introsWaiting: got.filter(r => r.status === "waiting").map(r => ({ company: r.company || "", title: r.title || "", verified: r.verified || "" })),
    pitchesAnswered: pitches.filter(k => (k.answeredAt || 0) > since && (k.status === "yes" || k.status === "no")).map(k => ({ title: k.title, company: k.company || "", yes: k.status === "yes" })),
    pitchesWaiting: onBriefs.filter(k => k.status === "waiting").map(k => ({ title: k.title })),
    introsAnswered: sentRecs.filter(r => (r.answeredAt || 0) > since && (r.status === "yes" || r.status === "no")).map(r => ({ title: r.title || "", yes: r.status === "yes" })),
  };
  const yesItems = [
    ...got.filter(r => r.status === "yes").map(r => ({ id: r.id, side: "person" })),
    ...sentRecs.filter(r => r.status === "yes").map(r => ({ id: r.id, side: "company" })),
    ...pitches.filter(k => k.status === "yes").map(k => ({ id: k.id, side: "person" })),
    ...onBriefs.filter(k => k.status === "yes").map(k => ({ id: k.id, side: "company" })),
  ];
  const chats = await chatMeta(yesItems);
  requests.unread = Object.values(chats).reduce((t, c) => t + (c.unread || 0), 0);

  // For recruiters: people on the board who fit their newest brief (anonymous).
  let briefFits = null;
  const newest = myBriefs.sort((a, z) => (z.at || 0) - (a.at || 0))[0];
  if (newest && newest.type) {
    const [all] = await redis([["HVALS", "gc:profiles"]]);
    const people = (all || []).map(parse).filter(x => x && !x.example && x.id !== id && (x.type === newest.type || x.second === newest.type))
      .sort((a, z) => (z.type === newest.type) - (a.type === newest.type) || (z.at || 0) - (a.at || 0)).slice(0, 3)
      .map(x => ({ type: x.type, name: x.name || "", thread: x.thread || "", region: x.region || "" }));
    briefFits = { title: newest.title, people };
  }
  const counts = { intros: INTROS_PER_WEEK, pitches: PITCHES_PER_WEEK };
  return { profile: profile ? { type: profile.type, second: profile.second || "", name: profile.name || "" } : null, matches, requests, briefFits, hasBriefs: myBriefs.length > 0, counts };
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
      case "stats": {
        const [cached] = await redis([["GET", "gc:stats:cache"]]);
        let stats = parse(cached);
        if (!stats) {
          stats = await computeStats();
          await redis([["SET", "gc:stats:cache", JSON.stringify(stats), "EX", STATS_TTL]]);
        }
        res.setHeader("Cache-Control", "public, max-age=60");
        return res.status(200).json({ stats });
      }
      case "hire.mark": {
        // Either side of a yes conversation can say it turned into work (or take that back).
        const th = await threadFor(b);
        if (th.error) return fail(res, th);
        if (await limited(req, "hire", 30)) return res.status(429).json({ error: "Too many changes. Try again later." });
        const key = isIntroId(th.tid) ? "gc:intro" : "gc:pitch";
        const rec = th.rec;
        if (b.hired) { if (!rec.hired) rec.hired = { by: th.side, at: Date.now() }; }
        else delete rec.hired;
        await redis([["HSET", key, th.tid, JSON.stringify(rec)], ["DEL", "gc:stats:cache"]]);
        return res.status(200).json({ hired: !!rec.hired });
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
          name: s(p.name, 60), thread: s(p.thread, 240), say: s(p.say, 200), edge: s(p.edge, 240),
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
        // Requests still waiting for an answer close with the profile.
        const [ids, pids] = await redis([["LRANGE", "gc:intros:" + id, 0, 49], ["LRANGE", "gc:pitched:" + id, 0, 99]]);
        const closing = (await loadIntros(ids)).filter(r => r.status === "waiting")
          .map(r => ["HSET", "gc:intro", r.id, JSON.stringify({ ...r, status: "closed", answeredAt: Date.now() })]);
        // Pitches still waiting are withdrawn: the company no longer sees them.
        const withdrawn = (await loadPitches(pids)).filter(k => k.status === "waiting")
          .map(k => ["HSET", "gc:pitch", k.id, JSON.stringify({ ...k, status: "withdrawn", answeredAt: Date.now() })]);
        await redis([["HDEL", "gc:profiles", id], ["DEL", "gc:intros:" + id], ...closing, ...withdrawn]);
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
        const o = await owner(b, true);
        if (o.error) return fail(res, o);
        if (await limited(req, "intro", 20)) return res.status(429).json({ error: "Too many requests. Try again later." });
        const pid = s(b.profileId, 40);
        if (!/^p[0-9a-f]{16}$/.test(pid)) return res.status(400).json({ error: "That profile can't receive requests." });
        if (pid === o.id) return res.status(400).json({ error: "That's your own profile." });
        const [exists, sentIds] = await redis([["HEXISTS", "gc:profiles", pid], ["LRANGE", "gc:sent:" + o.id, 0, 99]]);
        if (!exists) return res.status(404).json({ error: "That profile is no longer on the board." });
        const note = s(b.note, 300);
        if (note.length < 15) return res.status(400).json({ error: "Add a line or two on why them: what made you pick this person.", code: "need_note" });
        const contact = s(b.contact, 120);
        if (contact.length < 5) return res.status(400).json({ error: "Add how candidates can reach you.", code: "need_contact" });
        const sent = await loadIntros(sentIds);
        if (sent.some(x => x.pid === pid && x.status !== "no")) return res.status(409).json({ error: "You already asked this person. Their answer will show under Your intro requests.", code: "already" });
        // Weekly limit: count first, give the slot back if we went over.
        const wk = "gc:wk:intro:" + o.id + ":" + weekNo();
        const [used] = await redis([["INCR", wk], ["EXPIRE", wk, 8 * 86400]]);
        if (used > INTROS_PER_WEEK) {
          await redis([["DECR", wk]]);
          return res.status(429).json({ error: `You've used your ${INTROS_PER_WEEK} intro requests for this week. New ones open on Monday, so pick the people you're surest about.`, code: "week_limit", left: 0, limit: INTROS_PER_WEEK });
        }
        const intro = {
          id: "i" + randomBytes(8).toString("hex"), pid, from: o.id,
          need: s(b.needId, 40), title: s(b.title, 120), company: s(b.company, 80), note, contact,
          at: Date.now(), status: "waiting", ...(r.domain ? { verified: r.domain } : {}),
        };
        await redis([
          ["HSET", "gc:intro", intro.id, JSON.stringify(intro)],
          ["LPUSH", "gc:intros:" + pid, intro.id], ["LTRIM", "gc:intros:" + pid, 0, 49],
          ["LPUSH", "gc:sent:" + o.id, intro.id], ["LTRIM", "gc:sent:" + o.id, 0, 99],
        ]);
        return res.status(200).json({ ok: true, id: intro.id, left: INTROS_PER_WEEK - used, limit: INTROS_PER_WEEK });
      }
      case "intro.answer": {
        const o = await owner(b, true);
        if (o.error) return fail(res, o);
        if (await limited(req, "answer", 60)) return res.status(429).json({ error: "Too many changes. Try again later." });
        const iid = s(b.id, 40);
        if (!isIntroId(iid)) return res.status(400).json({ error: "That request can't be found." });
        const [raw] = await redis([["HGET", "gc:intro", iid]]);
        const rec = parse(raw);
        if (!rec || rec.pid !== o.id) return res.status(404).json({ error: "That request can't be found." });
        if (rec.status !== "waiting") return res.status(409).json({ error: "You already answered this one.", code: "answered" });
        if (b.yes) {
          const name = s(b.name, 80), contact = s(b.contact, 120);
          if (name.length < 2) return res.status(400).json({ error: "Add your name, so they know who to expect.", code: "need_name" });
          if (contact.length < 5) return res.status(400).json({ error: "Add how they can reach you: an email or a LinkedIn link.", code: "need_contact" });
          rec.status = "yes"; rec.seeker = { name, contact, note: s(b.note, 300) };
        } else rec.status = "no";
        rec.answeredAt = Date.now();
        await redis([["HSET", "gc:intro", iid, JSON.stringify(rec)], ["DEL", "gc:stats:cache"]]);
        return res.status(200).json({ intro: forSeeker(rec) });
      }
      case "pitch.send": {
        const o = await owner(b, true);
        if (o.error) return fail(res, o);
        if (await limited(req, "pitch", 20)) return res.status(429).json({ error: "Too many tries. Try again later." });
        const nid = s(b.needId, 40);
        if (!isNeedId(nid)) return res.status(400).json({ error: "That brief can't receive pitches.", code: "not_pitchable" });
        const [myP, all, sentIds] = await redis([["HGET", "gc:profiles", o.id], ["LRANGE", "gc:needs", 0, 199], ["LRANGE", "gc:pitched:" + o.id, 0, 99]]);
        if (!myP) return res.status(400).json({ error: "Make yourself findable first, so they can see the problems you've solved.", code: "need_profile" });
        const need = (all || []).map(parse).find(n => n && n.id === nid);
        if (!need || need.hidden) return res.status(404).json({ error: "That brief is no longer on the board.", code: "gone" });
        if (!need.owner) return res.status(400).json({ error: "This company posted without an account, so it can't receive pitches yet.", code: "not_pitchable" });
        if (o.uid && need.owner === o.uid) return res.status(400).json({ error: "That's your own brief.", code: "own" });
        const plan = s(b.plan, 600);
        if (plan.length < 40) return res.status(400).json({ error: "Write a few lines on how you'd tackle it: what you'd do first, and why you.", code: "need_plan" });
        const name = s(b.name, 80), contact = s(b.contact, 120);
        if (name.length < 2) return res.status(400).json({ error: "Add your name. They only see it if they say yes.", code: "need_name" });
        if (contact.length < 5) return res.status(400).json({ error: "Add how they can reach you: an email or a LinkedIn link.", code: "need_contact" });
        const sent = await loadPitches(sentIds);
        if (sent.some(k => k.need === nid && k.status !== "withdrawn")) return res.status(409).json({ error: "You already pitched this one. Their answer will show under Your pitches.", code: "already" });
        const wk = "gc:wk:pitch:" + o.id + ":" + weekNo();
        const [used] = await redis([["INCR", wk], ["EXPIRE", wk, 8 * 86400]]);
        if (used > PITCHES_PER_WEEK) {
          await redis([["DECR", wk]]);
          return res.status(429).json({ error: `You've sent your ${PITCHES_PER_WEEK} pitches for this week. New ones open on Monday, so save them for the problems you know best.`, code: "week_limit", left: 0, limit: PITCHES_PER_WEEK });
        }
        const pitch = {
          id: "k" + randomBytes(8).toString("hex"), need: nid, owner: need.owner, from: o.id,
          title: s(need.title, 120), company: s(need.company, 80), ...(need.verified ? { verified: need.verified } : {}),
          plan, name, contact, at: Date.now(), status: "waiting",
        };
        await redis([
          ["HSET", "gc:pitch", pitch.id, JSON.stringify(pitch)],
          ["LPUSH", "gc:pitched:" + o.id, pitch.id], ["LTRIM", "gc:pitched:" + o.id, 0, 99],
          ["LPUSH", "gc:pitches:" + nid, pitch.id], ["LTRIM", "gc:pitches:" + nid, 0, 199],
        ]);
        return res.status(200).json({ ok: true, pitch: forPitcher(pitch), left: PITCHES_PER_WEEK - used, limit: PITCHES_PER_WEEK });
      }
      case "pitch.answer": {
        // Only the signed-in recruiter who posted the brief can answer.
        const o = await owner({ session: b.session }, false);
        if (o.error) return fail(res, o);
        if (await limited(req, "panswer", 60)) return res.status(429).json({ error: "Too many changes. Try again later." });
        const kid = s(b.id, 40);
        if (!isPitchId(kid)) return res.status(400).json({ error: "That pitch can't be found." });
        const [raw] = await redis([["HGET", "gc:pitch", kid]]);
        const rec = parse(raw);
        if (!rec || rec.owner !== o.uid) return res.status(404).json({ error: "That pitch can't be found." });
        if (rec.status !== "waiting") return res.status(409).json({ error: rec.status === "withdrawn" ? "They took their profile off the board." : "You already answered this one.", code: "answered" });
        if (b.yes) {
          const contact = s(b.contact, 120);
          if (contact.length < 5) return res.status(400).json({ error: "Add how they can reach you: an email or a LinkedIn link.", code: "need_contact" });
          rec.status = "yes"; rec.reply = { contact, note: s(b.note, 300) };
        } else rec.status = "no";
        rec.answeredAt = Date.now();
        await redis([["HSET", "gc:pitch", kid, JSON.stringify(rec)], ["DEL", "gc:stats:cache"]]);
        const [p] = await redis([["HGET", "gc:profiles", rec.from]]);
        return res.status(200).json({ pitch: forBriefOwner(rec, parse(p)) });
      }
      case "mine": {
        const o = await owner(b, true);
        if (o.error) return fail(res, o);
        const id = o.id;
        const [p, introList, sentIds, pitchedIds] = await redis([["HGET", "gc:profiles", id], ["LRANGE", "gc:intros:" + id, 0, 49], ["LRANGE", "gc:sent:" + id, 0, 99], ["LRANGE", "gc:pitched:" + id, 0, 99]]);
        let briefs = [];
        if (o.uid) {
          const [all] = await redis([["LRANGE", "gc:needs", 0, 199]]);
          briefs = (all || []).map(parse).filter(n => n && n.owner === o.uid).map(({ token, owner, ...n }) => n);
          // Pitches each brief received, with a fresh anonymous view of each person.
          if (briefs.length) {
            const lists = await redis(briefs.map(n => ["LRANGE", "gc:pitches:" + n.id, 0, 199]));
            const recs = await loadPitches(lists.flat());
            const froms = [...new Set(recs.map(k => k.from))];
            const profs = froms.length ? (await redis([["HMGET", "gc:profiles", ...froms]]))[0] : [];
            const pm = new Map(froms.map((x, i) => [x, parse((profs || [])[i])]));
            briefs = briefs.map(n => ({ ...n, pitches: recs.filter(k => k.need === n.id && k.owner === o.uid && k.status !== "withdrawn").map(k => forBriefOwner(k, pm.get(k.from))) }));
          }
        }
        const pitches = (await loadPitches(pitchedIds)).map(forPitcher);
        // Received: new double opt-in records by id, plus older whole requests as they were.
        const got = await loadIntros(introList);
        const byId = new Map(got.map(x => [x.id, x]));
        const intros = (introList || []).map(x => isIntroId(x) ? (byId.has(x) ? forSeeker(byId.get(x)) : null) : parse(x)).filter(Boolean);
        // Sent: with a short anonymous view of the person, or their details after a yes.
        const sentRecs = await loadIntros(sentIds);
        const pids = [...new Set(sentRecs.map(x => x.pid))];
        const profs = pids.length ? (await redis([["HMGET", "gc:profiles", ...pids]]))[0] : [];
        const pmap = new Map(pids.map((x, i) => [x, parse((profs || [])[i])]));
        const sent = sentRecs.map(x => forRecruiter(x, pmap.get(x.pid)));
        // Message counters for every conversation that is open (both said yes).
        const yesItems = [
          ...intros.filter(x => x.id && x.status === "yes").map(x => ({ id: x.id, side: "person" })),
          ...sent.filter(x => x.status === "yes").map(x => ({ id: x.id, side: "company" })),
          ...pitches.filter(x => x.status === "yes").map(x => ({ id: x.id, side: "person" })),
          ...briefs.flatMap(n => (n.pitches || []).filter(x => x.status === "yes").map(x => ({ id: x.id, side: "company" }))),
        ];
        const chats = await chatMeta(yesItems);
        const used = await weekUsed(id), pUsed = await weekUsed(id, "pitch");
        return res.status(200).json({
          profile: parse(p), intros, sent, briefs, pitches, chats, account: !!o.uid,
          week: { used, left: Math.max(0, INTROS_PER_WEEK - used), limit: INTROS_PER_WEEK, resets: weekEnds() },
          pitchWeek: { used: pUsed, left: Math.max(0, PITCHES_PER_WEEK - pUsed), limit: PITCHES_PER_WEEK, resets: weekEnds() },
        });
      }
      case "claim": {
        // First sign-in on a browser that already had a profile: move it into the account.
        const o = await owner({ session: b.session }, false);
        if (o.error) return fail(res, o);
        if (!okToken(b.token)) return res.status(200).json({ moved: false });
        if (await limited(req, "claim", 30)) return res.status(429).json({ error: "Too many tries. Try again later." });
        const from = idOf(b.token), to = o.id;
        if (from === to) return res.status(200).json({ moved: false });
        const [oldP, newP, oldI, newI, oldS, newS, oldK, newK] = await redis([
          ["HGET", "gc:profiles", from], ["HGET", "gc:profiles", to],
          ["LRANGE", "gc:intros:" + from, 0, 49], ["LRANGE", "gc:intros:" + to, 0, 49],
          ["LRANGE", "gc:sent:" + from, 0, 99], ["LRANGE", "gc:sent:" + to, 0, 99],
          ["LRANGE", "gc:pitched:" + from, 0, 99], ["LRANGE", "gc:pitched:" + to, 0, 99],
        ]);
        const a = parse(oldP), z = parse(newP);
        if (!a && !(oldI || []).length && !(oldS || []).length && !(oldK || []).length) return res.status(200).json({ moved: false });
        const cmds = [];
        // Keep whichever profile was updated last, under the account's id.
        if (a && (!z || (a.at || 0) > (z.at || 0))) cmds.push(["HSET", "gc:profiles", to, JSON.stringify({ ...a, id: to })]);
        // Requests this browser received and sent now belong to the account.
        const moveRecs = async (ids, field) => {
          for (const r of await loadIntros(ids)) cmds.push(["HSET", "gc:intro", r.id, JSON.stringify({ ...r, [field]: to })]);
        };
        if ((oldI || []).length) {
          await moveRecs(oldI, "pid");
          const atOf = x => isIntroId(x) ? 0 : ((parse(x) || {}).at || 0);
          const merged = [...new Set((newI || []).concat(oldI || []))].slice(0, 50);
          // Newest first: id entries keep their list order, older whole requests sort by date among them.
          const ordered = merged.filter(isIntroId).concat(merged.filter(x => !isIntroId(x) && parse(x)).sort((x, y) => atOf(y) - atOf(x)));
          cmds.push(["DEL", "gc:intros:" + to]);
          if (ordered.length) cmds.push(["RPUSH", "gc:intros:" + to, ...ordered]);
        }
        if ((oldS || []).length) {
          await moveRecs(oldS, "from");
          const merged = [...new Set((newS || []).concat(oldS || []))].slice(0, 100);
          cmds.push(["DEL", "gc:sent:" + to], ["RPUSH", "gc:sent:" + to, ...merged]);
        }
        if ((oldK || []).length) {
          for (const k of await loadPitches(oldK)) cmds.push(["HSET", "gc:pitch", k.id, JSON.stringify({ ...k, from: to })]);
          const merged = [...new Set((newK || []).concat(oldK || []))].slice(0, 100);
          cmds.push(["DEL", "gc:pitched:" + to], ["RPUSH", "gc:pitched:" + to, ...merged]);
        }
        cmds.push(["HDEL", "gc:profiles", from], ["DEL", "gc:intros:" + from], ["DEL", "gc:sent:" + from], ["DEL", "gc:pitched:" + from]);
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
        // Pitches still waiting close with the brief; the seeker sees it was taken down.
        const [kids] = await redis([["LRANGE", "gc:pitches:" + nid, 0, 199]]);
        const closing = (await loadPitches(kids)).filter(k => k.status === "waiting")
          .map(k => ["HSET", "gc:pitch", k.id, JSON.stringify({ ...k, status: "closed", answeredAt: Date.now() })]);
        await redis([["LREM", "gc:needs", 1, raw], ...closing]);
        return res.status(200).json({ ok: true });
      }
      case "msg.list": {
        const th = await threadFor(b);
        if (th.error) return fail(res, th);
        const [raw, counts] = await redis([["LRANGE", "gc:msg:" + th.tid, 0, MSG_KEEP - 1], ["HGET", "gc:msgc:" + th.tid, th.other]]);
        // Opening the thread marks the other side's messages as read.
        await redis([["HSET", "gc:msgc:" + th.tid, "seen:" + th.side, Number(counts) || 0]]);
        const messages = (raw || []).map(parse).filter(Boolean).map(m => ({ mine: m.by === th.side, text: m.text, at: m.at }));
        return res.status(200).json({ messages, side: th.side });
      }
      case "msg.send": {
        const th = await threadFor(b);
        if (th.error) return fail(res, th);
        if (await limited(req, "msg", 60)) return res.status(429).json({ error: "That's a lot of messages in one hour. Take a breath and try again later." });
        const text = String(b.text == null ? "" : b.text).replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000B-\u001F]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, 1000);
        if (!text) return res.status(400).json({ error: "Write something first.", code: "empty" });
        const msg = { by: th.side, text, at: Date.now() };
        const [, , mine, otherN] = await redis([
          ["RPUSH", "gc:msg:" + th.tid, JSON.stringify(msg)], ["LTRIM", "gc:msg:" + th.tid, -MSG_KEEP, -1],
          ["HINCRBY", "gc:msgc:" + th.tid, th.side, 1], ["HGET", "gc:msgc:" + th.tid, th.other],
        ]);
        // Writing back means you have read what they sent so far.
        await redis([["HSET", "gc:msgc:" + th.tid, "seen:" + th.side, Number(otherN) || 0]]);
        return res.status(200).json({ ok: true, message: { mine: true, text: msg.text, at: msg.at }, count: mine });
      }
      default:
        return res.status(400).json({ error: "Unknown action" });
    }
  } catch (e) {
    console.log("Board error", String(e));
    return res.status(502).json({ error: "The board is having trouble right now. Try again in a minute." });
  }
}
