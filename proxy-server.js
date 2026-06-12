/* ════════════════════════════════════════════════════════════════
   TPG HubSpot Health Check Proxy
   Relays browser requests to api.hubapi.com (which sends no CORS
   headers to any origin) and mirrors the HubSpot status code back.

   Deploy on Render (same pattern as the AXO diagnostic proxy):
     1. New Web Service, Node, this file as the repo root
     2. Build command:  npm install
     3. Start command:  node proxy-server.js
     4. Env var ALLOWED_ORIGINS = https://www.pedowitzgroup.com,https://pedowitzgroup.com
        (add any sandbox/staging domains, comma-separated)
   Endpoint: POST https://<your-service>.onrender.com/hs

   The token arrives in the X-HubSpot-Token header per request.
   It is never logged and never stored.
   ════════════════════════════════════════════════════════════════ */
"use strict";

const express = require("express");
const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;

// EU-hosted portals issue pat-eu1- tokens and live on a different API host.
function hubspotBase(token) {
  return (typeof token === "string" && token.toLowerCase().indexOf("pat-eu1-") === 0)
    ? "https://api-eu1.hubapi.com"
    : "https://api.hubapi.com";
}

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ||
  "https://www.pedowitzgroup.com,https://pedowitzgroup.com")
  .split(",").map(s => s.trim()).filter(Boolean);

// Only relay to API families the health check actually uses.
const ALLOWED_PATH_PREFIXES = [
  "/crm/v3/", "/marketing/v3/", "/automation/v4/",
  "/cms/v3/", "/account-info/v3/"
];

function corsHeaders(req, res) {
  const origin = req.headers.origin || "";
  if (ALLOWED_ORIGINS.includes("*") || ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-HubSpot-Token");
  res.setHeader("Access-Control-Max-Age", "86400");
}

app.options(/.*/, (req, res) => { corsHeaders(req, res); res.sendStatus(204); });

app.get("/", (req, res) => { corsHeaders(req, res); res.json({ ok: true, service: "tpg-hs-health-check-proxy", endpoint: "POST /hs" }); });

app.post("/hs", async (req, res) => {
  corsHeaders(req, res);

  const token = req.headers["x-hubspot-token"];
  if (!token || typeof token !== "string") {
    return res.status(400).json({ error: "Missing X-HubSpot-Token header" });
  }

  const { method, path, query, body } = req.body || {};
  const m = String(method || "GET").toUpperCase();
  if (!["GET", "POST", "PATCH"].includes(m)) {
    return res.status(400).json({ error: "Method not allowed: " + m });
  }
  if (typeof path !== "string" || !ALLOWED_PATH_PREFIXES.some(p => path.startsWith(p))) {
    return res.status(400).json({ error: "Path not allowed: " + String(path).slice(0, 80) });
  }

  const url = new URL(hubspotBase(token) + path);
  if (query && typeof query === "object") {
    for (const [k, v] of Object.entries(query)) {
      if (v != null) url.searchParams.set(k, String(v));
    }
  }

  try {
    const hs = await fetch(url.toString(), {
      method: m,
      headers: {
        "Authorization": "Bearer " + token,
        "Content-Type": "application/json"
      },
      body: (m === "GET" || body == null) ? undefined : JSON.stringify(body)
    });
    const text = await hs.text();
    res.status(hs.status);
    res.setHeader("Content-Type", hs.headers.get("content-type") || "application/json");
    return res.send(text);
  } catch (e) {
    return res.status(502).json({ error: "Upstream error: " + e.message });
  }
});

app.use((req, res) => {
  corsHeaders(req, res);
  res.status(404).json({ error: "Not found. The relay endpoint is POST /hs", path: req.path });
});

app.listen(PORT, () => {
  console.log("TPG HubSpot Health Check proxy listening on " + PORT);
  console.log("Allowed origins: " + ALLOWED_ORIGINS.join(", "));
});
