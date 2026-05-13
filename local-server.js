// PCO Services Dashboard — Local dev server
// Usage: node local-server.js

import http from "node:http";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { fetchTeamData, renderHTML } from "./src/shared.js";

function detectDevice(req) {
  const ua = (req.headers['user-agent'] || '').toLowerCase();
  if (/ipad|android(?!.*mobile)|tablet/i.test(ua)) return 'tablet';
  if (/mobile|iphone|ipod|android|blackberry|windows phone/i.test(ua)) return 'mobile';
  return 'desktop';
}
import { TEAMS, getTeam } from "./src/teams.js";
import { ORG } from "./src/config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFRESH_KEY = ORG.refreshKey;
const env = {
  PCO_APP_ID: "",
  PCO_SECRET:  "",
};

// In-memory cache per team slug
const teamCache = new Map(); // slug -> { html, fetchedAt }
const CACHE_TTL_MS = 3600_000;
const isFresh = (slug) => {
  const c = teamCache.get(slug);
  return c && (Date.now() - c.fetchedAt) < CACHE_TTL_MS;
};

function localExecSummary() {
  const cards = TEAMS.map(team => {
    const cached = teamCache.get(team.slug);
    const ageStr = cached
      ? Math.round((Date.now() - cached.fetchedAt) / 60000) + "m ago"
      : "not cached";
    return '<a href="/team/' + team.slug + '" style="display:block;background:#1e293b;border:1px solid #334155;border-radius:12px;padding:1.5rem;text-decoration:none;color:#f1f5f9" onmouseover="this.style.borderColor=\'#3b82f6\'" onmouseout="this.style.borderColor=\'#334155\'">'
      + '<div style="font-size:2rem">' + team.icon + '</div>'
      + '<div style="font-size:1.1rem;font-weight:700;margin:0.5rem 0">' + team.label + '</div>'
      + '<div style="font-size:0.75rem;color:#94a3b8">' + ageStr + '</div>'
      + '<div style="font-size:0.8rem;font-weight:600;color:#3b82f6;margin-top:0.75rem">View Report &rarr;</div>'
      + '</a>';
  }).join("");

  return '<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>' + ORG.name + ' &mdash; PCO Reports</title>'
    + '<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui,sans-serif;background:#0f172a;color:#f1f5f9;padding:2rem;min-height:100vh}'
    + 'h1{font-size:1.75rem;font-weight:700;margin-bottom:0.25rem}.sub{color:#94a3b8;font-size:0.9rem;margin-bottom:2rem}'
    + '.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:1.25rem}</style></head>'
    + '<body><h1>' + ORG.icon + ' ' + ORG.name + ' &mdash; PCO Reports</h1><p class="sub">Local dev server</p>'
    + '<div class="grid">' + cards + '</div></body></html>';
}

function loadingPage(team) {
  return '<!DOCTYPE html><html><head><meta charset="UTF-8">'
    + '<title>Loading ' + team.label + '...</title>'
    + '<style>body{background:#0f172a;color:#f1f5f9;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;flex-direction:column;gap:1rem}'
    + '.spinner{width:40px;height:40px;border:4px solid #334155;border-top-color:#3b82f6;border-radius:50%;animation:spin .9s linear infinite}'
    + '@keyframes spin{to{transform:rotate(360deg)}}</style></head>'
    + '<body><h2>' + team.icon + ' Loading ' + team.label + '...</h2><div class="spinner"></div>'
    + '<script>fetch("/team/' + team.slug + '/report"+window.location.search)'
    + '.then(r=>r.text()).then(h=>{document.open();document.write(h);document.close()})'
    + '.catch(e=>{document.body.innerHTML="<p style=\'color:red\'>"+e.message+"</p>"})'
    + '</script></body></html>';
}

const server = http.createServer(async (req, res) => {
  const urlObj       = new URL(req.url, "http://localhost");
  const path         = urlObj.pathname;
  const forceRefresh = urlObj.searchParams.get("refresh") === REFRESH_KEY;
  console.log(new Date().toISOString() + " GET " + path);

  // Static assets
  if (path === "/favicon.ico" || path === "/favicon.png") {
    try {
      const img = fs.readFileSync(join(__dirname, "src/public/favicon.png"));
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(img);
    } catch { res.writeHead(204); res.end(); }
    return;
  }

  if (path === "/style.css") {
    try {
      const css = fs.readFileSync(join(__dirname, "src/public/style.css"));
      res.writeHead(200, { "Content-Type": "text/css" });
      res.end(css);
    } catch (e) { res.writeHead(500); res.end(e.message); }
    return;
  }

  // / — exec summary
  if (path === "/" || path === "") {
    res.writeHead(200, { "Content-Type": "text/html;charset=UTF-8" });
    res.end(localExecSummary());
    return;
  }

  // /team/:slug — serve cached report or loading page
  const teamMatch = path.match(/^\/team\/([^/]+)$/);
  if (teamMatch) {
    const slug = teamMatch[1];
    const team = getTeam(slug);
    if (!team) { res.writeHead(404); res.end("Team not found"); return; }

    if (!forceRefresh && isFresh(slug)) {
      const cached = teamCache.get(slug);
      res.writeHead(200, { "Content-Type": "text/html;charset=UTF-8" });
      res.end(renderHTML(cached.data, detectDevice(req)));
      return;
    }

    res.writeHead(200, { "Content-Type": "text/html;charset=UTF-8" });
    res.end(loadingPage(team));
    return;
  }

  // /team/:slug/report — fetch from PCO and render
  const reportMatch = path.match(/^\/team\/([^/]+)\/report$/);
  if (reportMatch) {
    const slug = reportMatch[1];
    const team = getTeam(slug);
    if (!team) { res.writeHead(404); res.end("Team not found"); return; }

    if (!forceRefresh && isFresh(slug)) {
      const cached = teamCache.get(slug);
      res.writeHead(200, { "Content-Type": "text/html;charset=UTF-8" });
      res.end(renderHTML(cached.data, detectDevice(req)));
      return;
    }

    try {
      console.log("Fetching data for: " + team.label);
      const data = await fetchTeamData(env, team);
      console.log("Got " + data.columns.length + " columns, " + data.peopleMap.size + " members");
      const html = renderHTML(data, detectDevice(req));
      // Cache data object, render per-request for correct device detection
      teamCache.set(slug, { data, fetchedAt: Date.now() });
      res.writeHead(200, { "Content-Type": "text/html;charset=UTF-8" });
      res.end(html);
    } catch (err) {
      console.error("Error:", err);
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Error: " + err.message + "\n" + err.stack);
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

const PORT = 8787;
server.listen(PORT, () => {
  console.log(ORG.name + " PCO Dashboard running at http://localhost:" + PORT);
  console.log("Teams: " + TEAMS.map(t => t.icon + " " + t.label + " -> /team/" + t.slug).join(", "));
});
