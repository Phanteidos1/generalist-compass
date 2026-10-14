// Saved Living CVs: a short link (/cv/k3P9xQ2a) instead of the long link that carries the
// whole CV in its hash. Optional: the long link keeps working and stores nothing.
//
// Who owns a saved CV:
//   - Saving returns a secret "key" that stays in that browser. Only the key can change or
//     delete the CV.
//   - Saved while signed in (email link, see auth.js), it also belongs to the account, so the
//     person can see and delete it from any device.
//
// Intros through the board: when the owner has a board profile (see board.js) and says so, the
//   saved CV remembers that profile ("pid", never sent to the page). Anyone opening the short
//   link can then send a real double opt-in intro request to it ("intro"); it lands with the
//   person's other intro requests on Compass. The board profile stays anonymous on the board.
//
// Records: gc:cv:<id> = JSON { id, cv, key: hash of the key, uid, pid?, at, upd }.
//   gc:cvs:<uid> = set of ids an account saved. gc:cvviews = hash id -> times opened by others.
//   Anyone with the link can read it; nothing lists saved CVs publicly.
//
// Actions (POST): get, save, update, link, delete, mine, board, intro.

import { randomBytes } from "node:crypto";
import { redis, storeReady, s, hash, parse, clientIp, limited } from "./_store.js";
import { userFromSession } from "./auth.js";
import { boardProfileOf, introRequest } from "./board.js";

const ABC = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
const newId = () => [...randomBytes(8)].map(b => ABC[b % ABC.length]).join("");
const okId = x => typeof x === "string" && /^[A-Za-z0-9]{8}$/.test(x);
const okKey = x => typeof x === "string" && /^[A-Za-z0-9_-]{30,60}$/.test(x);
const MAX_SAVED_PER_ACCOUNT = 20;
const MAX_BYTES = 40000;

const list = (v, n, each) => (Array.isArray(v) ? v : []).map(x => s(x, each)).filter(Boolean).slice(0, n);
const year = v => { const n = Number(v); return Number.isInteger(n) && n >= 1940 && n <= 2100 ? n : null; };

// Only the fields the page shows, each with a length cap.
export function cleanCv(v) {
  if (!v || typeof v !== "object") return null;
  const roles = (Array.isArray(v.roles) ? v.roles : []).slice(0, 12).map(r => r && typeof r === "object" ? {
    start: year(r.start), end: year(r.end), title: s(r.title, 120), org: s(r.org, 120), place: s(r.place, 120),
    skills: list(r.skills, 8, 40), problem: s(r.problem, 400), did: s(r.did, 400), changed: s(r.changed, 400),
    behind: s(r.behind, 400), bullets: list(r.bullets, 4, 200),
  } : null).filter(r => r && (r.title || r.org) && r.start);
  const cv = {
    name: s(v.name, 80), line: s(v.line, 200), meta: list(v.meta, 4, 120), contact: s(v.contact, 200),
    skills: list(v.skills, 8, 40), roles,
  };
  if (!cv.name || !roles.length) return null;
  return cv;
}

async function account(b) {
  if (!b.session) return null;
  const u = await userFromSession(b.session);
  return u || null;
}
// Is this caller the owner? The browser key or the signed-in account.
// The caller's own board profile, from the signed-in session or the board key in this browser.
const myBoard = b => boardProfileOf({ session: b.session, token: b.boardToken });
async function profileThere(pid) {
  if (!pid) return false;
  const [n] = await redis([["HEXISTS", "gc:profiles", pid]]);
  return Number(n) === 1;
}
const owns = (rec, b, u) => !!rec && ((okKey(b.key) && hash(b.key) === rec.key) || (!!u && !!rec.uid && rec.uid === u.id));

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });
  if (!storeReady()) return res.status(503).json({ error: "Saving isn't switched on yet. Your long link still works.", code: "no_store" });
  const b = req.body || {};
  const ip = clientIp(req);
  try {
    switch (b.action) {
      case "get": {
        // A missing CV answers 200 { gone } so the page shows a kind note, not a browser error.
        if (!okId(b.id)) return res.status(200).json({ gone: true });
        if (await limited("cv-get", ip, 600)) return res.status(429).json({ error: "Too many requests. Try again later." });
        const [raw, views] = await redis([["GET", "gc:cv:" + b.id], ["HGET", "gc:cvviews", b.id]]);
        const rec = parse(raw);
        if (!rec) return res.status(200).json({ gone: true });
        const u = b.session ? await account(b) : null;
        const mine = owns(rec, b, u);
        if (!mine) await redis([["HINCRBY", "gc:cvviews", rec.id, 1]]);
        const introable = await profileThere(rec.pid);
        return res.status(200).json({ id: rec.id, cv: rec.cv, at: rec.at, upd: rec.upd, mine, introable, ...(mine ? { views: Number(views) || 0, linked: !!rec.pid } : {}) });
      }

      case "save": {
        if (await limited("cv-save", ip, 20)) return res.status(429).json({ error: "You've saved a lot this hour. Try again later." });
        const cv = cleanCv(b.cv);
        if (!cv) return res.status(400).json({ error: "This CV needs a name and at least one role before it can be saved.", code: "bad_cv" });
        if (JSON.stringify(cv).length > MAX_BYTES) return res.status(413).json({ error: "This CV is too long to save. Shorten a few stories.", code: "too_big" });
        const u = await account(b);
        if (b.session && !u) return res.status(401).json({ error: "You were signed out. Sign in again, or save without signing in.", code: "signed_out" });
        if (u) {
          const [blocked, n] = await redis([["SISMEMBER", "gc:blocked", u.id], ["SCARD", "gc:cvs:" + u.id]]);
          if (Number(blocked) === 1) return res.status(403).json({ error: "This account can't save here any more.", code: "blocked" });
          if (Number(n) >= MAX_SAVED_PER_ACCOUNT) return res.status(409).json({ error: "You have " + MAX_SAVED_PER_ACCOUNT + " saved Living CVs. Delete one first.", code: "too_many" });
        }
        let pid = "";
        if (b.intro) { const bp = await myBoard(b); if (bp.exists) pid = bp.id; }
        const key = randomBytes(24).toString("base64url");
        const now = Date.now();
        for (let tries = 0; tries < 5; tries++) {
          const id = newId();
          const rec = { id, cv, key: hash(key), uid: u ? u.id : "", ...(pid ? { pid } : {}), at: now, upd: now };
          const [ok] = await redis([["SET", "gc:cv:" + id, JSON.stringify(rec), "NX"]]);
          if (ok !== "OK") continue;
          if (u) await redis([["SADD", "gc:cvs:" + u.id, id]]);
          return res.status(200).json({ id, key, at: now, introable: !!pid });
        }
        return res.status(500).json({ error: "Couldn't save right now. Try again." });
      }

      case "update": {
        if (!okId(b.id)) return res.status(404).json({ error: "That Living CV isn't here any more.", code: "gone" });
        if (await limited("cv-upd", ip, 120)) return res.status(429).json({ error: "Too many saves this hour. Try again later." });
        const cv = cleanCv(b.cv);
        if (!cv) return res.status(400).json({ error: "This CV needs a name and at least one role.", code: "bad_cv" });
        if (JSON.stringify(cv).length > MAX_BYTES) return res.status(413).json({ error: "This CV is too long to save. Shorten a few stories.", code: "too_big" });
        const [raw] = await redis([["GET", "gc:cv:" + b.id]]);
        const rec = parse(raw);
        if (!rec) return res.status(404).json({ error: "That Living CV isn't here any more.", code: "gone" });
        const u = await account(b);
        if (!owns(rec, b, u)) return res.status(403).json({ error: "Only the person who saved this CV can change it.", code: "not_owner" });
        rec.cv = cv; rec.upd = Date.now();
        await redis([["SET", "gc:cv:" + rec.id, JSON.stringify(rec), "XX"]]);
        return res.status(200).json({ id: rec.id, upd: rec.upd });
      }

      // Turn intro requests through the board on or off for one saved CV (owner only).
      case "link": {
        if (!okId(b.id)) return res.status(404).json({ error: "That Living CV isn't here any more.", code: "gone" });
        if (await limited("cv-upd", ip, 120)) return res.status(429).json({ error: "Too many changes this hour. Try again later." });
        const [raw] = await redis([["GET", "gc:cv:" + b.id]]);
        const rec = parse(raw);
        if (!rec) return res.status(404).json({ error: "That Living CV isn't here any more.", code: "gone" });
        const u = await account(b);
        if (!owns(rec, b, u)) return res.status(403).json({ error: "Only the person who saved this CV can change it.", code: "not_owner" });
        if (b.intro) {
          const bp = await myBoard(b);
          if (!bp.exists) return res.status(409).json({ error: "Make yourself findable on Compass first. Then intro requests can reach you there.", code: "no_profile" });
          rec.pid = bp.id;
        } else delete rec.pid;
        await redis([["SET", "gc:cv:" + rec.id, JSON.stringify(rec), "XX"]]);
        return res.status(200).json({ linked: !!rec.pid, introable: !!rec.pid });
      }

      // Does the caller have a board profile that intro requests could reach?
      case "board": {
        const bp = await myBoard(b);
        return res.status(200).json({ hasProfile: bp.exists });
      }

      // An employer asks for an intro from a saved Living CV. Same rules as the board: a verified
      // work email once sign-in is on, 5 a week, a short note, and the person says yes or no.
      case "intro": {
        if (!okId(b.id)) return res.status(404).json({ error: "That Living CV isn't here any more.", code: "gone" });
        const [raw] = await redis([["GET", "gc:cv:" + b.id]]);
        const rec = parse(raw);
        if (!rec) return res.status(404).json({ error: "That Living CV isn't here any more.", code: "gone" });
        if (!rec.pid) return res.status(409).json({ error: "This person doesn't take intro requests through Compass. Write to them directly.", code: "not_introable" });
        const company = s(b.company, 80);
        if (company.length < 2) return res.status(400).json({ error: "Add your name and company, so they know who is asking.", code: "need_company" });
        const out = await introRequest(req, { session: b.session, token: b.boardToken, note: b.note, contact: b.contact }, rec.pid,
          { title: "Found you through your Living CV", company, via: "cv" });
        return res.status(out.status).json(out.body);
      }

      case "delete": {
        if (!okId(b.id)) return res.status(200).json({ deleted: true });
        if (await limited("cv-upd", ip, 120)) return res.status(429).json({ error: "Too many actions this hour. Try again later." });
        const [raw] = await redis([["GET", "gc:cv:" + b.id]]);
        const rec = parse(raw);
        if (!rec) return res.status(200).json({ deleted: true });
        const u = await account(b);
        if (!owns(rec, b, u)) return res.status(403).json({ error: "Only the person who saved this CV can delete it.", code: "not_owner" });
        const cmds = [["DEL", "gc:cv:" + rec.id], ["HDEL", "gc:cvviews", rec.id]];
        if (rec.uid) cmds.push(["SREM", "gc:cvs:" + rec.uid, rec.id]);
        await redis(cmds);
        return res.status(200).json({ deleted: true });
      }

      // The caller's saved CVs: from this browser's keys, plus the account's when signed in.
      case "mine": {
        if (await limited("cv-get", ip, 600)) return res.status(429).json({ error: "Too many requests. Try again later." });
        const u = await account(b);
        const keys = (Array.isArray(b.keys) ? b.keys : []).slice(0, 30).filter(x => x && okId(x.id) && okKey(x.key));
        let ids = keys.map(x => x.id);
        if (u) { const [acc] = await redis([["SMEMBERS", "gc:cvs:" + u.id]]); ids = ids.concat(acc || []); }
        ids = [...new Set(ids.filter(okId))].slice(0, 40);
        if (!ids.length) return res.status(200).json({ items: [], signedIn: !!u });
        const rows = await redis(ids.map(id => ["GET", "gc:cv:" + id]).concat([["HMGET", "gc:cvviews", ...ids]]));
        const views = rows.pop() || [];
        const items = rows.map((raw, i) => {
          const rec = parse(raw);
          if (!rec) return null;
          const k = keys.find(x => x.id === rec.id);
          if (!owns(rec, { key: k && k.key }, u)) return null;
          return { id: rec.id, name: rec.cv.name, line: rec.cv.line || "", at: rec.at, upd: rec.upd, views: Number(views[i]) || 0 };
        }).filter(Boolean).sort((a, z) => z.upd - a.upd);
        const gone = keys.map(x => x.id).filter(id => !items.some(it => it.id === id));
        return res.status(200).json({ items, gone, signedIn: !!u });
      }

      default:
        return res.status(400).json({ error: "Unknown action" });
    }
  } catch (e) {
    return res.status(500).json({ error: "Something went wrong saving. Your long link still works." });
  }
}
