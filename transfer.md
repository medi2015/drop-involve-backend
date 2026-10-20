# Drop Involve — Transfer & Handoff Guide

This document captures the current state, deployment setup, recent changes, open problems, environment configuration, and critical conventions for **Drop Involve**.

---

## 1. What Changed in the Last Few Sessions & Unfinished Work

### Recent Changes

#### Transfer History & Recipient Visibility
- **14-day post-expiry retention**: Transfers older than 14 days after their expiry date are now filtered out on the client (`client/src/components/UploadCard.jsx`) and automatically pruned on the server (`server/index.js`).
- **Recipient email tracking**: Recipient email address is now tracked and persisted in history items (`item.recipientEmail`). A migration helper automatically backfills missing recipient emails from corresponding `short-urls/<id>.json` records.
- **History UI display**: The transfer history list displays recipient emails and collapses older history items when the list exceeds 10 items.

#### Recipient Landing Page & Showcase Carousel
- **Typography & Styling**: Restored Google Font **Inter** (weight 500) on the recipient landing page (`server/pages.js`) to match brand standards.
- **Vertical spacing rhythm**: Standardized vertical spacing to 16px between kicker, headline, and body copy; normalized bottom padding; aligned author byline baseline with the call-to-action button.
- **Carousel UX**: Added carousel navigation dots, prev/next chevrons, active pill indicator, and color adaptation across slide themes.
- **Random initial slide**: Recipient landing pages now select an initial showcase slide at random per visit (`server/pages.js`).
- **Default kicker color**: Updated default kicker color fallback to brand yellow (`#F5FF8C`).

#### Landing Page Content Editor ("Innhold")
- **Access control**: Restricted the "Innhold" editor via optional `CONTENT_EDITORS` environment variable in `.env` (comma-separated `@involve.no` emails). Enforced on `GET/PUT /admin/slides` and `POST /admin/slides/media`, with `GET /me` exposing permissions to the client. Fails open when unset to avoid lockouts.
- **Color picker**: Added category/kicker color customization directly within the editor (`ContentAdmin.jsx`).
- **Favicon update**: Replaced legacy yellow favicon with the exact brand yellow (`#F5FF8C`).

#### Architecture & Backend Cleanup
- **R2 Storage cleanup**: Removed legacy fallback reading from the expiring file bucket in `server/index.js` (`readJson` and `deleteJson`). All persistent records now strictly target `R2_DATA_BUCKET`.
- **Deployment discipline**: Standardized on `npm ci` on the VPS to prevent `package-lock.json` drifts.

#### Desktop App & Streaming Uploads
- **Version bump**: v0.1.46 includes automatic background updater checks, macOS dock icon fix (`RunEvent::Reopen`), tray template icon with `image-png` feature, and rounded app icon on brand yellow.
- **Streaming zip uploads**: Replaced `JSZip.generateAsync` with streaming multipart uploads (`client/src/lib/zipUpload.js`). Files are zipped on-the-fly into 16 MB chunks as they upload, eliminating V8's ~2.1 GB memory allocation ceiling and allowing arbitrary folder sizes.

---

### Unfinished Work & Pending Tasks

1. **Verify v0.1.46 on macOS**:
   - `RunEvent::Reopen` in `src-tauri/src/main.rs` (the macOS dock re-open fix) and the tray template icon have compiled in CI but need hands-on verification on physical macOS hardware.
   - Test closing the app window to the tray, then clicking the dock icon to verify it un-hides cleanly.
2. **Windows background auto-updates**:
   - Observe whether the Windows NSIS auto-installer prompts for UAC during a silent update. If it does, updates should be deferred until the user next launches the app.
3. **Turn on more landing page showcase slides**:
   - Only one slide is currently enabled in production. Other slides remain toggled off or contain placeholder copy.
4. **Clean up orphaned Cloudflare Workers**:
   - Three unused Cloudflare Workers exist on the account: `drop-involve-frontend`, `soft-glitter-d8b9`, and `noisy-bar-5b50`. Deleting them prevents accidental deploys to unused worker endpoints.
5. **VPS OS Updates**:
   - VPS has pending kernel and ~60 apt packages. Confirm `pm2 startup` is configured before rebooting.
6. **Form accessibility**:
   - Form inputs currently rely on placeholder text without explicit `<label>` elements. Screen readers announce minimal context, and placeholders disappear once typing starts.
7. **Retire obsolete Render service**:
   - The old Render service from early development still auto-deploys on git push. Verify zero traffic and terminate it in the Render dashboard.

---

## 2. Known Bugs & Open Problems

### Typing Lag / Slow Input Latency
- **Slide Editor (`ContentAdmin.jsx`)**:
  - Typing into any text field (`kicker`, `title`, `body`, `tagline`, `ctaLabel`, `ctaUrl`) calls `update(editing, changes)` on every `onChange` keystroke.
  - This updates the root `slides` state array in `ContentAdmin`, causing the entire component tree to re-render on every keystroke.
  - This forces re-renders of heavy children, including two `ImagePicker` instances (which maintain canvas handles and crop listeners) and color pickers.
  - **Recommended fix**: Hold the active slide being edited in local form state within a dedicated subcomponent or use uncontrolled inputs with debounced/blur synchronization to root state.
- **Send Form (`UploadCard.jsx`)**:
  - Typing in the `emailTo`, `message`, or `linkPassword` fields re-renders the ~1,200 line `UploadCard` component on every keystroke, continuously recomputing contact suggestions and password strength regexes.
  - **Recommended fix**: Isolate input fields or use `React.memo` and `useCallback` to prevent top-level card re-renders while typing.

### Operating & Environment Constraints
- **Unsigned Desktop Binaries**:
  - macOS Gatekeeper and Windows SmartScreen warn users on first run because binaries are not signed with paid certificates ($99/year Apple Developer, plus Windows code signing certificate). Deliberately deferred for internal ~20-user tool.
  - macOS users must approve the app under *System Settings > Privacy & Security*.
- **In-Memory Rate Limiting & Slide Cache**:
  - Password brute-force attempts (`linkAttempts`), download de-duplication (`recentDownloads`), and slide cache live in PM2 process memory.
  - **Do NOT run PM2 in cluster mode**: Running multiple workers will divide rate limits and cause duplicate download counts. Move this state to R2 or Redis if multi-process scaling is ever required.
- **Email Client CSS Limitations**:
  - Email clients strip `@font-face`, so emails fall back to system fonts (Helvetica/Arial/monospace). Desktop Outlook also ignores `border-radius`.

---

## 3. Deployment Architecture & Operational Runbooks

### Three Deployables & Targets

```
┌──────────────────────────────┬──────────────────────────────┬──────────────────────────────┐
│ Web App (drop.involve.no)    │ API (file.involve.no)        │ Desktop Apps (Mac & Win)     │
├──────────────────────────────┼──────────────────────────────┼──────────────────────────────┤
│ Cloudflare Pages             │ Vultr VPS (Ubuntu + Nginx)   │ GitHub Releases              │
│ Project: drop-involve-page   │ Process: pm2 (drop-backend)  │ Tauri 2 auto-updater         │
│ Directory: client/           │ Directory: server/           │ Directory: client/src-tauri/ │
└──────────────────────────────┴──────────────────────────────┴──────────────────────────────┘
```

---

### Deploying the Web App (drop.involve.no)
The web client is hosted on **Cloudflare Pages** and is **NOT on the VPS**. Never attempt to build or deploy the client from the VPS.

Run locally from Windows:
```cmd
cd "C:\Users\medio\Downloads\Antigravity\Upload link\client"
git add -A
git commit -m "Your commit message"
git push origin main
npm run deploy
```
*(Note: `npm run deploy` triggers `vite build` followed by `wrangler pages deploy dist --project-name=drop-involve-page --branch main`).*

---

### Deploying the Backend API & Landing Pages (file.involve.no)
The backend runs on a **Vultr VPS** (`80.240.25.105`) behind Nginx, managed by PM2 under the process name `drop-backend`. The remote path is `/var/www/drop-involve-backend`.

1. Commit and push from local Windows:
   ```cmd
   cd "C:\Users\medio\Downloads\Antigravity\Upload link\server"
   git add -A
   git commit -m "Your commit message"
   git push origin main
   ```

2. SSH to the VPS (`ssh root@80.240.25.105`):
   ```bash
   cd /var/www/drop-involve-backend
   git pull origin main
   npm ci
   pm2 restart drop-backend --update-env
   pm2 logs drop-backend --lines 20 --nostream
   ```

---

### Deploying Desktop Releases
Desktop releases are built automatically via GitHub Actions:
1. Bump the version in `client/src-tauri/tauri.conf.json` (e.g. `0.1.47`).
2. Commit and push:
   ```cmd
   git add client/src-tauri/tauri.conf.json
   git commit -m "chore(release): bump desktop version to 0.1.47"
   git push origin main
   git tag v0.1.47
   git push origin v0.1.47
   ```
3. GitHub Actions builds the macOS and Windows binaries, signs them with the Tauri updater key, creates a GitHub Release, and publishes release manifests for the auto-updater.

---

### Domains & External Services
- **`drop.involve.no`**: Frontend sender web app (Cloudflare Pages).
- **`file.involve.no`**: Backend API and server-rendered recipient download pages (Vultr VPS + Nginx).
- **Cloudflare R2**: Object storage (S3-compatible API). Direct browser-to-R2 presigned PUT for file uploads; VPS is never in the data transfer path.
- **Google Workspace OAuth**: Sign-in restricted to `@involve.no` Google accounts.
- **Google Workspace SMTP Relay**: `smtp-relay.gmail.com` on port 587 (IP-authenticated from the VPS) for recipient notification and download receipt emails.
- **Resend**: Fallback mail provider if `SMTP_HOST` is unset.
- **Google Apps Script**: External 5-minute health check monitor (`server/uptime-monitor.gs`).

---

## 4. Environment Variables

> [!IMPORTANT]
> **Never commit secret values or `.env` files to git.** Store values in a secure password manager.

### Backend (`server/.env` on VPS)
| Variable Name | Purpose |
| --- | --- |
| `PORT` | Local port Express listens on (proxied by Nginx) |
| `R2_ENDPOINT` | Cloudflare R2 S3-compatible API endpoint |
| `R2_ACCESS_KEY_ID` | Cloudflare R2 API access key |
| `R2_SECRET_ACCESS_KEY` | Cloudflare R2 API secret key |
| `R2_BUCKET_NAME` | Bucket for expiring uploads (e.g. `get-involve`, 8-day lifecycle) |
| `R2_DATA_BUCKET` | Bucket for persistent data (e.g. `involve-drop-data`, NO lifecycle) |
| `SESSION_SECRET` | Secret key for signing stateless auth session tokens |
| `SMTP_HOST` | Google Workspace SMTP relay host (`smtp-relay.gmail.com`) |
| `SMTP_PORT` | SMTP relay port (typically `587`) |
| `MAIL_FROM` | Default sender email address (e.g. `drop@involve.no`) |
| `GOOGLE_CLIENT_ID` | OAuth Client ID for Web Sign-In |
| `GOOGLE_DESKTOP_CLIENT_ID` | OAuth Client ID for Desktop PKCE loopback flow |
| `GOOGLE_DESKTOP_CLIENT_SECRET` | OAuth Client Secret for Desktop flow |
| `RESEND_API_KEY` | Optional fallback email API key |
| `ADMIN_EMAILS` | Comma-separated list of administrative emails for revocation routes |
| `CONTENT_EDITORS` | Optional comma-separated list of emails allowed to edit landing slides |

### Frontend Build (`client/.env` or build environment)
| Variable Name | Purpose |
| --- | --- |
| `VITE_API_BASE` | Base URL of the backend API (defaults to `https://file.involve.no`) |
| `VITE_GOOGLE_CLIENT_ID` | Google OAuth Client ID for web sign-in |

---

## 5. Critical Conventions & "Don't Touch" Rules

1. **R2 Buckets Must Never Be Mixed Up**:
   - **`get-involve`** has an **8-day auto-delete lifecycle rule with an empty prefix**. It must ONLY hold raw transfer payload files.
   - **`involve-drop-data`** has **NO lifecycle rule**. It holds `users/`, `contacts/`, `security/`, `short-urls/`, and `slides/`. Placing any persistent file in `get-involve` will cause it to silently disappear after 8 days.
2. **Direct Browser-to-R2 Upload**:
   - Large file transfers never transit the VPS Node.js process. The backend only issues presigned URLs or signs multipart parts. Do not attempt to pipe upload streams through Express.
3. **Always use `npm ci` on the VPS**:
   - Never run `npm install` on the VPS. `npm install` alters `package-lock.json`, which breaks future `git pull` commands.
4. **Edit Nginx configuration with `nano`, NEVER with `sed`**:
   - Chained `sed` commands previously duplicated Nginx `location` blocks, causing an unnoticed failure that took down the site during certbot renewal. Always verify with:
     ```bash
     nginx -t && systemctl reload nginx
     ```
5. **Tailwind CSS v4 Configuration**:
   - The frontend uses Tailwind v4 via `@tailwindcss/postcss`. There is **NO `tailwind.config.js`**. Brand colors and theme variables live in `@theme` in `client/src/index.css`.
6. **Brand Design Rules**:
   - Primary brand yellow: `#F5FF8C`.
   - Dark background: `#0B1416` / `#003F46`.
   - App typography uses **Inter**. Recipient landing pages use **Neue Haas Grotesk** and **Andale Mono** via Adobe Fonts kit `lnt3nfg`.
   - UI language is Norwegian (`no-NO`) across all sender and recipient views.
7. **Tauri Version Source of Truth**:
   - Desktop app versioning is dictated by `client/src-tauri/tauri.conf.json`, not by the git tag. The release workflow enforces that the git tag and `tauri.conf.json` version match before building.
