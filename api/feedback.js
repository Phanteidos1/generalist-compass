// Collects "Did this feel like you?" feedback.
// Read it in Vercel: Project > Logs, search for FEEDBACK.

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });
  const { rating, comment, type, at } = req.body || {};
  const entry = {
    rating: rating === "up" || rating === "down" ? rating : "",
    comment: typeof comment === "string" ? comment.slice(0, 1000) : "",
    type: typeof type === "string" ? type.slice(0, 40) : "",
    at: typeof at === "string" ? at.slice(0, 40) : new Date().toISOString(),
  };
  console.log("FEEDBACK " + JSON.stringify(entry));
  return res.status(200).json({ ok: true });
}
