// Email-link sign-in. No passwords.
//
// How it works:
//   1. "request": someone types their email. We store a one-time code for 15 minutes
//      and email them a link with that code.
//   2. "verify": the link opens the site, which sends the code back here. We swap it
//      for a session that lasts 30 days. The code works once.
//   3. "me" / "logout": check or end a session.
//
// Switches on by itself once these are set in Vercel (Project > Settings > Environment Variables):
//   RESEND_API_KEY  the key from resend.com (free plan is enough)
//   EMAIL_FROM      optional, e.g. "Generalist Compass <hello@yourdomain.com>".
//                   Until a domain is verified at Resend, the default test sender only
//                   delivers to the email address of the Resend account owner.
//   APP_URL         optional, e.g. "https://generalist-compass.vercel.app" (used in the link).
// Storage: the same Upstash Redis as the board.

import { randomBytes } from "node:crypto";
import { redis, storeReady, s, hash, parse, clientIp, limited } from "./_store.js";

const LINK_MINUTES = 15;
const SESSION_DAYS = 30;
const DEFAULT_FROM = "Generalist Compass <onboarding@resend.dev>";
const DEFAULT_URL = "https://generalist-compass.vercel.app";

const emailReady = () => !!process.env.RESEND_API_KEY;
const token = () => randomBytes(32).toString("base64url");
const okToken = t => typeof t === "string" && /^[A-Za-z0-9_-]{40,60}$/.test(t);

export function cleanEmail(v) {
  const e = s(v, 254).toLowerCase();
  return /^[^\s@<>()",;:]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(e) ? e : "";
}

// Where the link in the email points. Only our own addresses, never whatever host a caller claims.
function siteUrl(req) {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/+$/, "");
  const host = s(req.headers["x-forwarded-host"] || req.headers.host, 200).toLowerCase();
  if (/^[a-z0-9-]+\.vercel\.app$/.test(host)) return "https://" + host;
  if (/^(localhost|127\.0\.0\.1)(:\d{2,5})?$/.test(host)) return "http://" + host;
  return DEFAULT_URL;
}

async function sendLinkEmail(to, link) {
  const text = [
    "Hi,",
    "",
    "Here is your sign-in link for Generalist Compass:",
    link,
    "",
    `It works once and expires in ${LINK_MINUTES} minutes.`,
    "If you didn't ask for this, you can ignore this email. Nothing happens without the link.",
    "",
    "Mike, Generalist Compass",
  ].join("\n");
  const html = `<div style="font-family:system-ui,sans-serif;font-size:16px;line-height:1.5;color:#18202B;max-width:480px">
<p>Hi,</p>
<p>Here is your sign-in link for Generalist Compass.</p>
<p><a href="${link}" style="display:inline-block;background:#22457A;color:#fff;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:10px">Sign me in</a></p>
<p style="color:#5A6573;font-size:14px">It works once and expires in ${LINK_MINUTES} minutes. If you didn't ask for this, you can ignore this email. Nothing happens without the link.</p>
<p>Mike, Generalist Compass</p>
</div>`;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: "Bearer " + process.env.RESEND_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({ from: process.env.EMAIL_FROM || DEFAULT_FROM, to: [to], subject: "Your sign-in link for Generalist Compass", text, html }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error("email " + r.status + " " + body.slice(0, 300));
  }
}

// Personal and throwaway mail providers. An address there proves a person, not a company.
const PERSONAL = new Set(("gmail.com googlemail.com yahoo.com ymail.com rocketmail.com hotmail.com outlook.com live.com msn.com " +
  "icloud.com me.com mac.com aol.com aim.com proton.me protonmail.com protonmail.ch pm.me gmx.com gmx.net gmx.de gmx.at gmx.ch " +
  "web.de t-online.de freenet.de mail.com email.com zoho.com zohomail.com yandex.com yandex.ru mail.ru inbox.ru bk.ru list.ru " +
  "tutanota.com tutanota.de tuta.io tuta.com hey.com fastmail.com fastmail.fm hushmail.com qq.com 163.com 126.com sina.com " +
  "naver.com daum.net hanmail.net rediffmail.com orange.fr wanadoo.fr free.fr laposte.net sfr.fr libero.it virgilio.it tiscali.it " +
  "skynet.be telenet.be proximus.be scarlet.be ziggo.nl kpnmail.nl planet.nl hetnet.nl home.nl seznam.cz wp.pl o2.pl onet.pl interia.pl " +
  "btinternet.com sky.com virginmedia.com ntlworld.com talktalk.net comcast.net verizon.net att.net sbcglobal.net cox.net " +
  "bellsouth.net charter.net earthlink.net shaw.ca rogers.com sympatico.ca bigpond.com optusnet.com.au xtra.co.nz " +
  "uol.com.br bol.com.br terra.com.br ig.com.br mailinator.com guerrillamail.com sharklasers.com 10minutemail.com " +
  "temp-mail.org tempmail.com yopmail.com trashmail.com getnada.com dispostable.com maildrop.cc").split(" "));
const PERSONAL_FAMILY = /^(yahoo|hotmail|outlook|live|gmx|yandex|aol|icloud)\.[a-z.]{2,6}$/;

// The company domain behind a work email, or "" for personal and throwaway addresses.
export function workDomain(email) {
  const e = cleanEmail(email);
  if (!e) return "";
  const d = e.split("@")[1];
  if (PERSONAL.has(d) || PERSONAL_FAMILY.test(d)) return "";
  return d;
}

// Look up the account behind a session. Used by other functions later.
export async function userFromSession(session) {
  if (!okToken(session)) return null;
  const [uid] = await redis([["GET", "gc:sess:" + hash(session)]]);
  if (!uid) return null;
  const [u] = await redis([["HGET", "gc:users", uid]]);
  return parse(u);
}

const publicUser = u => ({ id: u.id, email: u.email, since: u.created, work: workDomain(u.email) });

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });
  const b = req.body || {};
  const enabled = emailReady() && storeReady();
  try {
    switch (b.action) {
      case "status":
        return res.status(200).json({ enabled });

      case "workcheck":
        // Lets the page warn before sending a link that a personal address can't verify a company.
        return res.status(200).json({ work: workDomain(b.email) });

      case "request": {
        if (!enabled) return res.status(503).json({ error: "Sign-in by email isn't switched on yet.", code: "not_enabled" });
        const email = cleanEmail(b.email);
        if (!email) return res.status(400).json({ error: "That doesn't look like an email address." });
        if (await limited("login-ip", clientIp(req), 10) || await limited("login-mail", email, 4))
          return res.status(429).json({ error: "Too many links asked for. Try again in an hour." });
        const code = token();
        await redis([["SET", "gc:login:" + hash(code), email, "EX", LINK_MINUTES * 60]]);
        await sendLinkEmail(email, siteUrl(req) + "/#login." + code);
        return res.status(200).json({ ok: true });
      }

      case "verify": {
        if (!storeReady()) return res.status(503).json({ error: "Sign-in isn't available right now." });
        if (!okToken(b.code)) return res.status(400).json({ error: "This sign-in link isn't valid.", code: "bad_link" });
        if (await limited("verify-ip", clientIp(req), 30)) return res.status(429).json({ error: "Too many tries. Try again later." });
        const [email] = await redis([["GETDEL", "gc:login:" + hash(b.code)]]);
        if (!email) return res.status(400).json({ error: "This link has expired or was already used. Ask for a new one.", code: "bad_link" });
        const ekey = "gc:uid:" + hash("email:" + email);
        const newId = "u" + randomBytes(8).toString("hex");
        const [, uid] = await redis([["SET", ekey, newId, "NX"], ["GET", ekey]]);
        let [u] = await redis([["HGET", "gc:users", uid]]);
        u = parse(u);
        if (!u) {
          u = { id: uid, email, created: Date.now() };
          await redis([["HSET", "gc:users", uid, JSON.stringify(u)]]);
        }
        const session = token();
        await redis([["SET", "gc:sess:" + hash(session), uid, "EX", SESSION_DAYS * 86400]]);
        return res.status(200).json({ session, user: publicUser(u) });
      }

      case "me": {
        if (!storeReady()) return res.status(503).json({ error: "Sign-in isn't available right now." });
        const u = await userFromSession(b.session);
        if (!u) return res.status(401).json({ error: "Signed out." });
        return res.status(200).json({ user: publicUser(u) });
      }

      case "logout": {
        if (storeReady() && okToken(b.session)) await redis([["DEL", "gc:sess:" + hash(b.session)]]);
        return res.status(200).json({ ok: true });
      }

      default:
        return res.status(400).json({ error: "Unknown action" });
    }
  } catch (e) {
    console.log("Auth error", String(e));
    return res.status(502).json({ error: "Sign-in is having trouble right now. Try again in a minute." });
  }
}
