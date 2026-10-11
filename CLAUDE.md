# Generalist Compass

Job-matching platform: people are known by the problems they've solved, companies describe the problem they need solved, both are introduced warmly (double opt-in).

- The plan and build order live in the "Generalist Compass: The Plan" doc: https://claude.ai/code/artifact/126ced21-9d68-4ad5-9d7d-2fe58fd602d1
- Hosting: Vercel (auto-deploys `main` to generalist-compass.vercel.app; other branches get preview URLs).
- Work on the `dev` branch only. Never push to `main` unless Mike explicitly says "go live".
- Stack: one static `index.html` + Vercel serverless functions in `api/` (ES modules, `package.json` type module).
  - `api/claude.js` proxies the Anthropic API (env ANTHROPIC_API_KEY).
  - `api/jobs.js` live remote jobs (Himalayas, Jobicy). `api/radar.js` web-search radar.
  - `api/board.js` recruiter board on Upstash Redis (env KV_REST_API_URL / KV_REST_API_TOKEN).
  - `api/feedback.js` logs feedback.
- Style: warm and human, English only, no em dashes in any user-facing text.
- Never commit secrets. Never add mass-apply features.
