// Fetches fresh remote job openings from free public feeds.
// Sources: Himalayas (himalayas.app) and Jobicy (jobicy.com). Both ask for a visible credit and a link back,
// which the page shows. We cache results for 6 hours so we never hammer their servers.

export const config = { maxDuration: 30 };
const cache = new Map();
const SIX_HOURS = 6 * 60 * 60 * 1000;
const UA = { "user-agent": "GeneralistCompass/1.0 (+https://generalist-compass.vercel.app)" };

const strip = t => String(t || "").replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim();

async function himalayas(q) {
  const r = await fetch("https://himalayas.app/jobs/api/search?q=" + encodeURIComponent(q), { headers: UA });
  if (!r.ok) throw new Error("himalayas " + r.status);
  const d = await r.json();
  return (d.jobs || []).map(j => ({
    title: strip(j.title), company: strip(j.companyName),
    location: (j.locationRestrictions && j.locationRestrictions.length) ? j.locationRestrictions.join(", ") : "Worldwide",
    url: j.applicationLink || "", source: "Himalayas",
    date: j.pubDate ? new Date(Number(j.pubDate) * 1000).toISOString() : "",
    excerpt: strip(j.excerpt).slice(0, 220),
  }));
}

async function jobicy(q) {
  const r = await fetch("https://jobicy.com/api/v2/remote-jobs?count=30&tag=" + encodeURIComponent(q), { headers: UA });
  if (!r.ok) throw new Error("jobicy " + r.status);
  const d = await r.json();
  return (d.jobs || []).map(j => ({
    title: strip(j.jobTitle), company: strip(j.companyName),
    location: strip(j.jobGeo) || "Worldwide",
    url: j.url || "", source: "Jobicy",
    date: j.pubDate ? new Date(j.pubDate).toISOString() : "",
    excerpt: strip(j.jobExcerpt).slice(0, 220),
  }));
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });
  let { queries } = req.body || {};
  if (!Array.isArray(queries)) queries = [];
  queries = queries.map(q => String(q || "").trim().slice(0, 60)).filter(Boolean).slice(0, 3);
  if (!queries.length) return res.status(400).json({ error: "No search terms" });

  const key = queries.map(q => q.toLowerCase()).sort().join("|");
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < SIX_HOURS) return res.status(200).json({ jobs: hit.jobs, cached: true });

  const tasks = [];
  for (const q of queries) { tasks.push(himalayas(q)); tasks.push(jobicy(q)); }
  const results = await Promise.allSettled(tasks);
  const all = [];
  results.forEach(r => { if (r.status === "fulfilled") all.push(...r.value); else console.log("job source failed:", String(r.reason)); });

  const seen = new Set(), jobs = [];
  for (const j of all) {
    if (!j.title || !j.url) continue;
    const k = (j.title + "|" + j.company).toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k); jobs.push(j);
  }
  jobs.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const top = jobs.slice(0, 40);
  cache.set(key, { at: Date.now(), jobs: top });
  return res.status(200).json({ jobs: top });
}
