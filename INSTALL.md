# Installation Guide
## PCO Services Dashboard

---

## Prerequisites

- **Node.js** 18 or later (`node --version` to check)
- **npm** (bundled with Node.js)
- A **Planning Center Online** account with API access
- A **Cloudflare** account

---

## Part 1 — Planning Center API Key

### 1.1 Create a Personal Access Token

1. Log in to Planning Center at [app.planningcenteronline.com](https://app.planningcenteronline.com)
2. Click your avatar (top right) → **Developer Settings** → **Personal Access Tokens**
3. Click **+ New Token**
4. Give it a name (e.g. "PCO Report Worker")
5. Copy both the **Application ID** and **Secret**

> These become `PCO_APP_ID` and `PCO_SECRET` in your Worker configuration.

### 1.2 Required permissions

The application uses two PCO APIs:

**Services API** (required)
- Read access to service types, teams, plans, team members, attendances, and blockouts
- A token created under a user with **Services → Scheduler** permissions or higher will work

**People API** (required for gender, marital status, birthdate, anniversary)
- Read access to people records
- Requires the token owner to have **People → Manager** permissions or higher
- **Important:** `gender`, `birthdate`, and `anniversary` are available at Viewer level, but `marital_status` requires **Manager** level or above. If the token only has Viewer access, the marital status chart will not appear — all other demographic data will still work.
- If People API access is absent entirely, all demographic charts will be empty but the app will still function normally

### 1.3 Find your PCO Folder ID

1. In Planning Center Services, navigate to the folder containing your service types
2. Look at the URL: `https://services.planningcenteronline.com/folders/XXXXXXX`
3. The number at the end is your `folderId` — set it in `src/config.js`

---

## Part 2 — Cloudflare Setup

### 2.1 Cloudflare Workers Paid Plan — ⚠️ Required

**Durable Objects are not available on the free Workers plan.**

You must be on the **Workers Paid** plan at a minimum of **$5 USD/month**.

| Feature | Free Plan | Paid Plan |
|---|---|---|
| Workers requests | 100,000/day | 10 million/month |
| Durable Objects | ❌ Not available | ✅ Included |
| R2 Storage | 10 GB | 10 GB free, then $0.015/GB |
| Durable Object storage | — | 1 GB free, then $0.20/GB |

For typical church use (a few hundred requests per day), the base $5/month cost is the only charge you will see. R2 and DO storage for this application will stay well within free tier limits.

To upgrade: Cloudflare Dashboard → **Workers & Pages** → **Plans** → **Workers Paid**.

### 2.2 Install Wrangler CLI

```bash
npm install -g wrangler
```

Authenticate with your Cloudflare account:

```bash
npx wrangler login
```

This opens a browser window to authorise the CLI.

### 2.3 Create the R2 Bucket

The bucket name must match the `bucket_name` in `wrangler.toml` and the `r2Prefix` in `src/config.js`.

```bash
npx wrangler r2 bucket create pco-services-dashboard-cache
```

Verify it was created:

```bash
npx wrangler r2 bucket list
```

---

## Part 3 — Application Setup

### 3.1 Clone or download the project

```bash
# If using git
git clone <your-repo-url>
cd pco-services-dashboard

# Or download and unzip, then:
cd pco-services-dashboard
```

### 3.2 Configure the application

Edit `src/config.js`:

```js
export const ORG = {
  name:       "Your Organisation Name",
  icon:       "⛪",
  folderId:   "YOUR_PCO_FOLDER_ID",    // from Part 1.3
  r2Prefix:   "pco-services-dashboard-cache",  // must match wrangler.toml bucket_name
  refreshKey: "your-secret-refresh-key",   // choose something hard to guess
  thresholds: {
    consecutiveDeclines: 3,
    confirmedNoShows:    3,
  },
  ttl: {
    teamMembers:    24 * 3600,
    plans:           4 * 3600,
    rosters:         1 * 3600,
    blockouts:            1800,
    prewarmLeadSec:        300,
  },
};
```

Edit `src/teams.js` to define your teams. Each team needs:
- `slug` — URL-safe identifier
- `label` — display name
- `icon` — emoji
- `filterFn` — function that matches the PCO team name
- `trackAttendance` — whether this team tracks attendance in PCO

### 3.3 Configure PCO credentials

There are three ways to provide credentials, depending on your workflow:

#### Option A — `wrangler.toml` (quick start, local + deployed)

The simplest approach. Credentials in `[vars]` work for both `wrangler dev` and `wrangler deploy`:

```toml
[vars]
PCO_APP_ID = "your-app-id"
PCO_SECRET = "your-secret"
```

> ⚠️ **Security warning:** If you commit `wrangler.toml` to version control, your credentials will be in the repo history. Use Option B or C before pushing to a shared repository.

#### Option B — `.dev.vars` for local + secrets for production (recommended)

1. Create a `.dev.vars` file in the project root (already in `.gitignore`):

```
PCO_APP_ID=your-app-id
PCO_SECRET=your-secret
```

2. Set production secrets via the CLI:

```bash
npx wrangler secret put PCO_APP_ID
# Paste your Application ID when prompted

npx wrangler secret put PCO_SECRET
# Paste your Secret when prompted
```

3. Remove the credential values from `wrangler.toml`:

```toml
[vars]
# Credentials stored as Wrangler secrets — see .dev.vars for local dev
```

Secrets set via `wrangler secret put` are encrypted and never visible in source files. They take precedence over `[vars]` if both are set.

#### Option C — `local-server.js` for local development only

Edit the credentials directly in `local-server.js`:

```js
const PCO_APP_ID = "your-app-id";
const PCO_SECRET  = "your-secret";
```

This only affects the local Node.js server and does not apply to deployed Workers.

### 3.4 Update wrangler.toml

Verify these values match your setup:

```toml
name = "pco-services-dashboard"   # your Worker name
main = "src/index.js"
compatibility_date = "2025-01-01"

[[r2_buckets]]
binding = "PCO_CACHE"
bucket_name = "pco-services-dashboard-cache"   # must match your R2 bucket

[[durable_objects.bindings]]
name = "PCO_DATA_CACHE"
class_name = "PCODataCache"

[[migrations]]
tag = "v1"
new_classes = ["PCODataCache"]
```

---

## Part 4 — Local Development

### 4.1 Run the local server

```bash
node local-server.js
```

Open `http://localhost:8787` in your browser.

The local server:
- Serves the executive summary at `/`
- Serves team reports at `/team/:slug`
- Caches data in memory for 60 minutes
- Force-refresh with `?refresh=your-secret-refresh-key`

### 4.2 Verify PCO connectivity

Check the terminal output when a team report loads — you should see log lines like:

```
[adult-choir] Fetching service types from 1 folder(s)...
[adult-choir] Found 3 service type(s): ...
[adult-choir] Teams found:
  Your Organisation | 8AM: Choir
  ...
[adult-choir] Total: 12 plan columns, 68 unique members — 142 API calls in 28.3s
```

If you see `PCO API 401` errors, your credentials are incorrect.  
If you see `PCO API 403` errors, your token lacks the required permissions.  
If teams are not found, check your `folderId` in `config.js` and the `filterFn` in `teams.js`.

---

## Part 5 — Production Deployment

### 5.1 Deploy to Cloudflare

```bash
npx wrangler deploy
```

On first deploy, Wrangler will:
1. Bundle `src/index.js` and its imports
2. Upload `src/public/` as static assets
3. Apply the Durable Object migration (`v1`)
4. Register the `PCODataCache` class

You should see output like:

```
✅ Successfully deployed to https://pco-services-dashboard.your-subdomain.workers.dev
```

### 5.2 Verify deployment

Visit your Worker URL. You should see the executive summary page. Navigate to a team to trigger the first PCO fetch — this will take 30–60 seconds on a cold cache.

After the first successful load, subsequent visits will be served from R2 cache in milliseconds.

### 5.3 Custom domain (optional)

In the Cloudflare Dashboard:
1. Go to **Workers & Pages** → your Worker → **Settings** → **Domains & Routes**
2. Click **Add Custom Domain**
3. Enter your subdomain (e.g. `pco.yourdomain.com`)
4. Cloudflare will provision an SSL certificate automatically

### 5.4 Enable Cloudflare Zero Trust Access (recommended)

To restrict access to authorised users only, enable Cloudflare Access with One-time PIN (OTP) authentication.

#### 5.4.1 Navigate to Cloudflare Access

1. Log in to the [Cloudflare Dashboard](https://dash.cloudflare.com)
2. Select your domain
3. Go to **Zero Trust** → **Access** → **Applications**

#### 5.4.2 Create an Access Application

1. Click **Add an application**
2. Choose **Self-hosted**
3. Configure:
   - **Application name**: PCO Reports (or your preferred name)
   - **Session duration**: 24 hours (or as preferred)
   - **Application domain**: Select your Worker domain (e.g. `pco.yourdomain.com` or `your-worker.your-subdomain.workers.dev`)
   - Leave **Domain type** as standard
4. Click **Next**

#### 5.4.3 Add an Authentication Policy (One-time PIN)

1. On the **Policies** tab, click **Add a policy**
2. Configure the policy:
   - **Policy name**: Allow authorised users
   - **Action**: Allow
   - **Session duration**: Same as application (or override)

3. Under **Identity** ("Include" section):
   - Select **One-time PIN** as the authentication method
   - Or add **Emails ending in** → `@yourdomain.com` to restrict to your organisation

4. **Email addresses** (optional but recommended):
   - Add specific emails under "Include" → **Email** → individual addresses
   - Or use **Email ending in** for domain-wide access

5. Click **Next**, then **Add policy**

> **Note:** One-time PIN sends a magic link to the user's email. No password or IdP required.

#### 5.4.4 Advanced policies (optional)

For more granular control, add additional policies with different rules:

- **IP-based**: Allow only from office/home IP ranges
- **Country-based**: Block/allow specific countries
- **Device posture**: Require updated OS or antivirus

Policies are evaluated in order — place more specific rules before broader ones.

#### 5.4.5 Configure the login page (optional)

1. Go to **Zero Trust** → **Settings** → **Custom Pages**
2. Customise the **Identity selection** page with your logo/branding
3. Add a custom **Forbidden** page for denied users

#### 5.4.6 Testing access

1. Visit your Worker URL in an incognito window
2. You should see the Cloudflare Access login page
3. Enter your authorised email address
4. Check email for the one-time PIN / magic link
5. After authentication, the PCO Reports application loads

#### 5.4.7 User identity in the application (advanced)

When Access is enabled, the user's email is passed to the Worker via headers:

- `CF-Access-Authenticated-User-Email` — the authenticated user's email
- `Cf-Access-Jwt-Assertion` — signed JWT with full identity claims

If you want to display the logged-in user or implement user-specific features, modify `src/index.js` to read these headers.

---

## Part 6 — Ongoing Maintenance

### Updating teams

Edit `src/teams.js` and run `npx wrangler deploy`. The new team will appear immediately. Its cache will be cold until someone first visits `/team/new-slug`.

### Changing configuration

Edit `src/config.js` and run `npx wrangler deploy`. Changes to TTLs take effect on the next cache miss.

### Viewing logs

```bash
npx wrangler tail
```

This streams live logs from your Worker, including Durable Object alarm logs.

### Clearing the R2 cache

To force all teams to re-fetch from PCO:

```bash
# List cached objects
npx wrangler r2 object list pco-services-dashboard-cache

# Delete a specific team's cache
npx wrangler r2 object delete pco-services-dashboard-cache adult-choir/data.json
```

Or add `?refresh=your-secret-key` to any URL to refresh that team's cache via the browser.

---

## Troubleshooting

**"Durable Object reset because its code was updated"**  
Normal on first request after a new deployment. Reload the page and it will work.

**Workers exits cleanly with no output (local-server.js)**  
Check for syntax errors: `node --trace-uncaught local-server.js`

**PCO API returns 0 results for a team**  
Verify the `filterFn` in `teams.js` matches the exact team name in PCO (case-insensitive substring match).

**Demographic fields are all Unknown**  
Your API token does not have People API read access. See Part 1.2 for required permissions.

**Cache is stale / not refreshing**  
The Durable Object alarm may not have fired yet. Force refresh with `?refresh=your-key` or wait for the next alarm cycle. Check Worker logs with `npx wrangler tail`.

**Build failed: "No matching export for PCODataCache"**  
Ensure `src/index.js` exports the class: `export class PCODataCache { ... }`  
Ensure `wrangler.toml` has `class_name = "PCODataCache"` under `[[durable_objects.bindings]]`.