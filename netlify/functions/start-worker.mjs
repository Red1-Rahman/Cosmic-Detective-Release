// netlify/functions/start-worker.mjs
//
// Called by a Supabase Database Webhook whenever a row is INSERTed into
// processing_jobs. Starts the GitHub Actions workflow that runs the Python
// worker. spherex-job is not modified: cache hits insert no row, so they never
// reach this function.
//
// Required Netlify env vars (all server side, none with a VITE_ prefix):
//   GITHUB_DISPATCH_TOKEN   fine-grained token, this repo only, Actions: read and write
//   WORKER_WEBHOOK_SECRET   long random string, also set as a header in the Supabase webhook
// Optional:
//   GITHUB_REPO             default Red1-Rahman/Cosmic-Detective-Release
//   GITHUB_WORKFLOW_FILE    default worker.yml
//   GITHUB_REF              default main

import { timingSafeEqual } from "node:crypto";

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function secretMatches(received, expected) {
  if (!received || !expected) return false;
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export default async (req) => {
  if (req.method !== "POST") return json(405, { error: "method not allowed" });

  if (!secretMatches(req.headers.get("x-webhook-secret"), process.env.WORKER_WEBHOOK_SECRET)) {
    return json(401, { error: "unauthorized" });
  }

  const token = process.env.GITHUB_DISPATCH_TOKEN;
  if (!token) return json(500, { error: "GITHUB_DISPATCH_TOKEN is not configured" });

  // Supabase webhook payload: { type, table, schema, record, old_record }
  let event = {};
  try {
    event = await req.json();
  } catch {
    // An empty or invalid body is treated as a manual call and still starts the worker.
  }
  if (event.type && event.type !== "INSERT") return json(200, { skipped: "not an insert" });
  const status = event.record?.status;
  if (["running", "completed", "failed"].includes(status)) {
    return json(200, { skipped: `job status is ${status}` });
  }

  const repo = process.env.GITHUB_REPO || "Red1-Rahman/Cosmic-Detective-Release";
  const workflow = process.env.GITHUB_WORKFLOW_FILE || "worker.yml";
  const ref = process.env.GITHUB_REF || "main";

  try {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "cosmic-detective-netlify",
        },
        body: JSON.stringify({ ref }),
        signal: AbortSignal.timeout(8000),
      },
    );
    if (res.status === 204) return json(202, { started: true });
    console.error(`GitHub dispatch failed: HTTP ${res.status}`);
    return json(502, { started: false, githubStatus: res.status });
  } catch (error) {
    console.error("GitHub dispatch error:", error?.message || error);
    return json(502, { started: false, error: "could not reach GitHub" });
  }
};
