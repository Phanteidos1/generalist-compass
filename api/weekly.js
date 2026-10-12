// The weekly email: 3 open problems that fit you, 1 short lesson, and your requests.
//
// Opt-in only. A signed-in person turns it on under "Your account". Every email has a
// one-click "stop these emails" link (no sign-in needed) and a link to the account page.
//
// Calls (POST, JSON):
//   get      { session }        -> { on, email, last, ready }
//   set      { session, on }    -> turn it on or off
//   preview  { session }        -> { subject, html, text } this week's email for the caller
//   sendme   { session }        -> sends this week's email to the caller now (for trying it out)
// GET ?off=<token>              -> stops the emails for that person, shows a small page
// GET (Vercel cron, Mondays)    -> sends to everyone who turned it on and didn't get one in 6 days
//
// Needs in Vercel (Project > Settings > Environment Variables):
//   RESEND_API_KEY  already there (sign-in emails use it)
//   CRON_SECRET     any long random text. Vercel sends it with the Monday run; without it
//                   the Monday run refuses to send, so nobody can trigger a mass send.
//   The Monday run itself is set in vercel.json. Vercel only runs it on the live site.
//
// Storage: gc:weekly (hash uid -> JSON {on, tok, last, at}), gc:wkoff:<hash(tok)> -> uid.

import { randomBytes } from "node:crypto";
import { redis, storeReady, s, hash, parse, clientIp, limited } from "./_store.js";
import { userFromSession, emailReady, sendMail, siteUrl } from "./auth.js";
import { weeklyData } from "./board.js";

const DEFAULT_URL = "https://generalist-compass.vercel.app";
const PER_RUN = 90;           // Resend's free plan sends 100 a day
const GAP_MS = 6 * 86400000;  // never two weekly emails within 6 days

// One short lesson a week. Picked by the reading's type, rotating week by week.
const LESSONS = {
  any: [
    { title: "Lead with the problem, not the title", body: "Nobody hires a title. They hire someone who has solved their kind of problem before. Open every message with the problem you fixed and what changed after.", try: "Rewrite the first line of your LinkedIn About so it names one problem you solved and its result." },
    { title: "One number makes a story real", body: "\"Improved operations\" is forgettable. \"Cut late deliveries from 30% to 5%\" is not. A rough number you can stand behind beats a polished sentence with none.", try: "Add one number to each of your problem cards, even an honest estimate." },
    { title: "Ask for advice, not a job", body: "People say no to job requests and yes to advice. A short, specific question about their world starts a real conversation, and conversations are where intros come from.", try: "Send one person a two-line message asking how they would approach a problem you care about." },
    { title: "Pick fewer doors, knock harder", body: "Ten careful messages beat a hundred copies. Scarcity is what makes a pitch feel personal, and personal is what gets answered.", try: "Choose the one open problem you know best and write your plan for it this week." },
  ],
  "The Opener": [{ title: "Show what was there after you left", body: "Openers are judged on what they leave behind. The strongest proof is not that you started something, but that it kept running without you.", try: "Add one line to a problem card about what still works today because of you." }],
  "The Connector": [{ title: "Name the door you opened", body: "Connectors undersell themselves by saying \"I know people\". Say which introduction you made and what it turned into.", try: "Write down the single best introduction you ever made and what came of it." }],
  "The Translator": [{ title: "Make the gap visible", body: "Your value is the gap you bridge. Describe both sides first: who didn't understand whom, and what it cost them before you came in.", try: "Pick one card and add the cost of the misunderstanding before you fixed it." }],
  "The Fixer": [{ title: "Before and after, in one line", body: "Fixers get hired on contrast. Give the before and the after side by side, with a time frame, and let the reader feel the turn.", try: "Rewrite one result as \"from X to Y in Z months\"." }],
  "The Operator": [{ title: "Show the system, not the effort", body: "Hard work is assumed. What sets an operator apart is the routine or system they built that kept working.", try: "Name one process you set up and how many people still use it." }],
  "The Explorer": [{ title: "Turn range into a thread", body: "Many fields can read as restless. Pick the one question that pulled you through all of them and say it out loud.", try: "Write one sentence that links your three most different jobs." }],
  "The Storyteller": [{ title: "Let the audience speak", body: "Your own words about your story matter less than what the audience did: who came back, who shared, who bought.", try: "Add one audience number or quote to a problem card." }],
  "The Strategist": [{ title: "Show a call you got right early", body: "Strategists are trusted for timing. Describe one decision you made before it was obvious, and what happened next.", try: "Write down one early call you made and when the rest of the market caught up." }],
};
const weekNo = (now = Date.now()) => Math.floor((now / 86400000 + 3) / 7);
function lessonFor(profile, now = Date.now()) {
  const own = profile && LESSONS[profile.type] ? LESSONS[profile.type] : [];
  const pool = own.concat(LESSONS.any);
  return pool[weekNo(now) % pool.length];
}

const esc = t => String(t == null ? "" : t).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const cut = (t, n) => { t = String(t || ""); return t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t; };
const plural = (n, one, many) => n + " " + (n === 1 ? one : many);

// Build this week's email from the data. Pure: no storage, no sending.
export function renderWeekly(d, { site, offUrl, now = Date.now() }) {
  const lesson = lessonFor(d.profile, now);
  const r = d.requests || {};
  const subject = r.introsWaiting && r.introsWaiting.length
    ? (r.introsWaiting.length === 1 ? "A company wants to meet you" : r.introsWaiting.length + " companies want to meet you") + ", and your week on Generalist Compass"
    : d.matches.some(m => m.fit) ? "Your week: " + plural(d.matches.filter(m => m.fit).length, "open problem fits", "open problems fit") + " you" : "Your week on Generalist Compass";

  // Requests, as plain lines.
  const req = [];
  if (r.introsWaiting && r.introsWaiting.length) r.introsWaiting.slice(0, 5).forEach(x => req.push({ strong: true, t: (x.company || "A company") + (x.verified ? " (verified " + x.verified + ")" : "") + " asked to meet you" + (x.title ? " about \"" + cut(x.title, 70) + "\"" : "") + ". Say yes or not this time." }));
  if (r.pitchesAnswered) r.pitchesAnswered.forEach(x => req.push({ strong: x.yes, t: x.yes ? (x.company || "The company") + " said yes to your pitch for \"" + cut(x.title, 70) + "\". Their contact is waiting for you." : "Your pitch for \"" + cut(x.title, 70) + "\" was a no this time. Keep the plan: it fits other briefs too." }));
  if (r.pitchesWaiting && r.pitchesWaiting.length) req.push({ strong: true, t: plural(r.pitchesWaiting.length, "pitch is", "pitches are") + " waiting on your briefs. Someone wrote a plan for your problem." });
  if (r.introsAnswered) r.introsAnswered.forEach(x => req.push({ strong: x.yes, t: x.yes ? "Yes to your intro request" + (x.title ? " for \"" + cut(x.title, 70) + "\"" : "") + ". Their details are under Your intro requests." : "A person said not this time" + (x.title ? " to \"" + cut(x.title, 70) + "\"" : "") + "." }));
  if (r.unread) req.push({ strong: true, t: plural(r.unread, "new message", "new messages") + " waiting for you." });

  const hello = d.profile && d.profile.name ? "Hi, here is your week as " + d.profile.name + "." : "Hi, here is your week.";
  const T = [hello, ""];
  if (d.profile) {
    const head = d.matches.some(m => m.fit) ? "Open problems that fit you" : "New on the board";
    T.push(head.toUpperCase());
    if (d.matches.length) d.matches.forEach(m => T.push("- " + m.title + (m.company ? " (" + m.company + ")" : "") + (m.fresh ? " [new]" : ""), "  " + cut(m.problem, 200)));
    else T.push("No open problems fit you yet this week. New ones come in all the time.");
    T.push("You can pitch " + d.counts.pitches + " of them a week: " + site + "/#problems", "");
  }
  if (d.briefFits) {
    T.push("PEOPLE WHO FIT \"" + d.briefFits.title + "\"");
    if (d.briefFits.people.length) d.briefFits.people.forEach(p => T.push("- " + (p.name || p.type) + (p.region ? ", " + p.region : "") + ": " + cut(p.thread, 140)));
    else T.push("No one fits this brief yet. We will tell you when someone does.");
    T.push("Ask for an intro (" + d.counts.intros + " a week): " + site, "");
  }
  const nudge = !d.profile && !d.briefFits ? "You're not on the board yet. Get your reading and tap \"Make me findable\", and next week this email shows the open problems that fit you." : "";
  if (nudge) T.push(nudge, "");
  T.push("THIS WEEK'S LESSON: " + lesson.title, lesson.body, "Try this: " + lesson.try, "");
  T.push("YOUR REQUESTS");
  if (req.length) req.forEach(x => T.push("- " + x.t)); else T.push("Nothing waiting on you this week.");
  T.push("", "Open Generalist Compass: " + site, "", "Mike, Generalist Compass", "", "You get this because you turned on the weekly email. Stop these emails: " + offUrl);
  const text = T.join("\n");

  // HTML: simple, inline styles, readable in light and dark mail apps.
  const ink = "#18202B", muted = "#5A6573", line = "#D9DFE6", accent = "#22457A", needle = "#C9842A";
  const h = (t) => `<h2 style="font-family:Georgia,serif;font-size:19px;line-height:1.3;color:${ink};margin:28px 0 10px">${esc(t)}</h2>`;
  const p = (t, st = "") => `<p style="margin:0 0 12px;${st}">${t}</p>`;
  const btn = (href, t) => `<a href="${esc(href)}" style="display:inline-block;background:${accent};color:#ffffff;text-decoration:none;font-weight:700;padding:11px 18px;border-radius:10px">${esc(t)}</a>`;
  const box = inner => `<div style="border:1px solid ${line};border-radius:12px;padding:14px 16px;margin:0 0 10px">${inner}</div>`;
  let H = `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:16px;line-height:1.55;color:${ink};max-width:560px;margin:0 auto;padding:8px">`;
  H += p(esc(hello));
  if (d.profile) {
    H += h(d.matches.some(m => m.fit) ? "Open problems that fit you" : "New on the board");
    if (d.matches.length) {
      d.matches.forEach(m => {
        H += box(`<div style="font-weight:700">${esc(m.title)}${m.fresh ? ` <span style="font-size:12px;font-weight:700;color:${needle};border:1px solid ${needle};border-radius:999px;padding:1px 8px;margin-left:4px">new</span>` : ""}</div>`
          + `<div style="color:${muted};font-size:14px;margin:2px 0 6px">${esc(m.company || "A company")}${m.verified ? " &middot; verified " + esc(m.verified) : ""}${m.type ? " &middot; looking for " + esc(m.type) : ""}</div>`
          + `<div style="font-size:15px">${esc(cut(m.problem, 220))}</div>`);
      });
      H += p(`You can pitch ${d.counts.pitches} of them a week. Pick the one you know best.`, `color:${muted};font-size:14px`);
      H += p(btn(site + "/#problems", "See open problems"));
    } else H += p("No open problems fit you yet this week. New ones come in all the time, and you will see them here first.", `color:${muted}`);
  }
  if (d.briefFits) {
    H += h(`People who fit "${cut(d.briefFits.title, 70)}"`);
    if (d.briefFits.people.length) d.briefFits.people.forEach(x => { H += box(`<div style="font-weight:700">${esc(x.name || x.type)}</div><div style="color:${muted};font-size:14px;margin:2px 0 6px">${esc(x.type)}${x.region ? " &middot; " + esc(x.region) : ""}</div><div style="font-size:15px">${esc(cut(x.thread, 160))}</div>`); });
    else H += p("No one fits this brief yet. We will show you here when someone does.", `color:${muted}`);
    H += p(`You can ask for ${d.counts.intros} intros a week, each with a short note on why them.`, `color:${muted};font-size:14px`);
  }
  if (nudge) H += p(esc(nudge) + "<br>" + btn(site, "Get your reading").replace("display:inline-block", "display:inline-block;margin-top:10px"));
  H += h("This week's lesson");
  H += `<div style="background:#F6EBDC;color:${ink};border-radius:12px;padding:14px 16px;margin:0 0 10px"><div style="font-weight:700;margin-bottom:4px">${esc(lesson.title)}</div><div style="font-size:15px;margin-bottom:8px">${esc(lesson.body)}</div><div style="font-size:15px"><b>Try this:</b> ${esc(lesson.try)}</div></div>`;
  H += h("Your requests");
  if (req.length) H += `<ul style="margin:0 0 12px;padding-left:20px">${req.map(x => `<li style="margin:0 0 6px">${x.strong ? "<b>" + esc(x.t) + "</b>" : esc(x.t)}</li>`).join("")}</ul>`;
  else H += p("Nothing waiting on you this week.", `color:${muted}`);
  H += p(btn(site, "Open Generalist Compass"), "margin-top:20px");
  H += p("Mike, Generalist Compass", "margin-top:20px");
  H += `<p style="margin:24px 0 0;padding-top:12px;border-top:1px solid ${line};color:${muted};font-size:13px">You get this because you turned on the weekly email. <a href="${esc(offUrl)}" style="color:${muted}">Stop these emails</a> or change it in <a href="${esc(site + "/#account")}" style="color:${muted}">your account</a>.</p>`;
  H += `</div>`;
  return { subject, text, html: H };
}

async function settings(uid) {
  const [raw] = await redis([["HGET", "gc:weekly", uid]]);
  return parse(raw) || { on: false };
}
// Each person gets one stop-link token, kept for good.
async function ensureToken(uid, set) {
  if (set.tok) return set;
  const tok = randomBytes(24).toString("base64url");
  await redis([["SET", "gc:wkoff:" + hash(tok), uid]]);
  return { ...set, tok };
}
const offLink = (site, tok) => site + "/api/weekly?off=" + encodeURIComponent(tok);

async function build(u, set, site, now = Date.now()) {
  const d = await weeklyData(u.id, set.last || now - 7 * 86400000);
  return renderWeekly(d, { site, offUrl: offLink(site, set.tok), now });
}
async function deliver(u, mail, offUrl) {
  await sendMail({ to: u.email, subject: mail.subject, text: mail.text, html: mail.html,
    headers: { "List-Unsubscribe": "<" + offUrl + ">", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } });
}

function page(res, status, title, body) {
  res.setHeader("content-type", "text/html; charset=utf-8");
  return res.status(status).send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>:root{color-scheme:light dark}body{margin:0;padding:48px 16px;background:#F1F3F5;color:#18202B;font:16px/1.55 system-ui,sans-serif}main{max-width:480px;margin:0 auto;background:#fff;border:1px solid #D9DFE6;border-radius:14px;padding:24px}h1{font-size:22px;margin:0 0 8px}a{color:#22457A;font-weight:700}
@media (prefers-color-scheme:dark){body{background:#10151C;color:#E7EBF0}main{background:#18202A;border-color:#2A3441}a{color:#93B3E6}}</style></head>
<body><main><h1>${esc(title)}</h1><p>${body}</p></main></body></html>`);
}

// Monday run: everyone who turned it on, oldest send first, at most PER_RUN per run.
async function sendAll(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return res.status(503).json({ error: "CRON_SECRET is not set, so the weekly run is off." });
  if ((req.headers.authorization || "") !== "Bearer " + secret) return res.status(401).json({ error: "Not allowed." });
  if (!emailReady() || !storeReady()) return res.status(503).json({ error: "Email or storage is not set up." });
  const site = (process.env.APP_URL || DEFAULT_URL).replace(/\/+$/, "");
  const [flat] = await redis([["HGETALL", "gc:weekly"]]);
  const rows = [];
  if (Array.isArray(flat)) for (let i = 0; i + 1 < flat.length; i += 2) rows.push([flat[i], parse(flat[i + 1])]);
  else if (flat) for (const k of Object.keys(flat)) rows.push([k, parse(flat[k])]);
  const now = Date.now();
  const due = rows.filter(([, v]) => v && v.on && now - (v.last || 0) > GAP_MS).sort((a, z) => (a[1].last || 0) - (z[1].last || 0)).slice(0, PER_RUN);
  let sent = 0, failed = 0, skipped = 0;
  for (const [uid, v] of due) {
    try {
      const [raw] = await redis([["HGET", "gc:users", uid]]);
      const u = parse(raw);
      if (!u || !u.email) { skipped++; continue; }
      const set = await ensureToken(uid, v);
      const mail = await build(u, set, site, now);
      await deliver(u, mail, offLink(site, set.tok));
      await redis([["HSET", "gc:weekly", uid, JSON.stringify({ ...set, last: now })]]);
      sent++;
    } catch (e) { failed++; console.log("Weekly send failed", uid, String(e).slice(0, 200)); }
  }
  return res.status(200).json({ due: due.length, sent, failed, skipped });
}

export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      const off = s((req.query && req.query.off) || "", 80);
      if (off) {
        if (!storeReady()) return page(res, 503, "Try again in a minute", "We couldn't reach our storage just now.");
        const [uid] = await redis([["GET", "gc:wkoff:" + hash(off)]]);
        if (!uid) return page(res, 404, "Link not recognised", "This stop link isn't valid. You can turn the weekly email off in your account on Generalist Compass.");
        const set = await settings(uid);
        await redis([["HSET", "gc:weekly", uid, JSON.stringify({ ...set, on: false, at: Date.now() })]]);
        return page(res, 200, "Done, no more weekly emails", `You won't get the weekly email anymore. Changed your mind? Turn it back on in <a href="/#account">your account</a>.`);
      }
      return sendAll(req, res);
    }
    if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });
    if (!storeReady()) return res.status(503).json({ error: "The weekly email isn't available right now." });
    const b = req.body || {};
    const u = await userFromSession(b.session);
    if (!u) return res.status(401).json({ error: "Sign in first.", code: "signed_out" });
    switch (b.action) {
      case "get": {
        const set = await settings(u.id);
        return res.status(200).json({ on: !!set.on, last: set.last || 0, email: u.email, ready: emailReady() });
      }
      case "set": {
        if (await limited("weekly-set", u.id, 30)) return res.status(429).json({ error: "Too many changes. Try again later." });
        let set = await settings(u.id);
        if (b.on) set = await ensureToken(u.id, set);
        set = { ...set, on: !!b.on, at: Date.now() };
        await redis([["HSET", "gc:weekly", u.id, JSON.stringify(set)]]);
        return res.status(200).json({ on: set.on, last: set.last || 0 });
      }
      case "preview": {
        if (await limited("weekly-preview", clientIp(req), 60)) return res.status(429).json({ error: "Too many tries. Try again later." });
        const set0 = await settings(u.id), set = await ensureToken(u.id, set0);
        if (!set0.tok) await redis([["HSET", "gc:weekly", u.id, JSON.stringify(set)]]);
        const mail = await build(u, set, siteUrl(req));
        return res.status(200).json(mail);
      }
      case "sendme": {
        if (!emailReady()) return res.status(503).json({ error: "Email isn't switched on yet.", code: "not_enabled" });
        if (await limited("weekly-sendme", u.id, 3)) return res.status(429).json({ error: "You've sent yourself a few already. Try again in an hour." });
        const set = await ensureToken(u.id, await settings(u.id));
        await redis([["HSET", "gc:weekly", u.id, JSON.stringify(set)]]);
        const site = siteUrl(req);
        const mail = await build(u, set, site);
        await deliver(u, mail, offLink(site, set.tok));
        return res.status(200).json({ ok: true, to: u.email });
      }
      default:
        return res.status(400).json({ error: "Unknown action" });
    }
  } catch (e) {
    console.log("Weekly error", String(e));
    return res.status(502).json({ error: "The weekly email is having trouble right now. Try again in a minute." });
  }
}
