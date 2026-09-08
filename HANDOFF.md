# Drop Involve — handoff

Internal file transfer for Involve, a Norwegian communications agency. A
WeTransfer replacement: staff sign in with their Google Workspace account,
upload a file or a folder, and send the recipient a link that expires. About
20 users, all `@involve.no`.

Live at **drop.involve.no** (the app) and **file.involve.no** (the API and the
pages recipients see). Interface language is Norwegian throughout.

Written 7 September 2026.

---

## 1. Tech stack and architecture

### Three deployables, three routes to production

| Part | Stack | Hosted | How it deploys |
| --- | --- | --- | --- |
| Web app | Vite 8 + React 19 | Cloudflare **Pages**, project `drop-involve-page` | `npm run deploy` from `client/` |
| Desktop apps | Tauri 2 (Rust) wrapping the same React build | GitHub Releases + Tauri updater | git tag `v0.1.x` → GitHub Actions |
| API | Node 22 + Express 4 | Vultr VPS behind nginx, run by pm2 | `git pull` on the VPS |

The desktop app is the *same* React bundle. There is no separate desktop
codebase — only `src-tauri/` for the native shell.

### Frontend

- **Vite 8**, React 19, plain JSX. No TypeScript, no router — the app is one
  screen with panels swapped by state in `App.jsx`.
- **Tailwind CSS v4** via `@tailwindcss/postcss`. There is **no
  `tailwind.config.js`** — v4 puts the theme in CSS. Brand tokens live in an
  `@theme` block in `src/index.css`.
- `framer-motion` for transitions, `lucide-react` for icons, `jszip` for
  archives.
- Fonts: **Inter** (Google Fonts) in the app.

### Backend

- **Express 4** on Node 22, one file (`server/index.js`, ~1,600 lines) plus four
  modules. No framework beyond Express, no ORM, no database.
- Recipient-facing pages are **server-rendered plain HTML** with inline CSS
  (`server/pages.js`) — no bundle, so they open instantly for someone who has
  never used Drop. These use **Neue Haas Grotesk** and **Andale Mono** from
  Involve's Adobe Fonts kit (`lnt3nfg`).
- Mail via **Google Workspace SMTP relay** (`smtp-relay.gmail.com`,
  IP-authenticated, 10,000/day). `server/mailer.js` falls back to Resend if
  `SMTP_HOST` is unset.

### Storage — there is no database

Everything lives in **Cloudflare R2**, in **two buckets that must not be
confused**:

| Bucket | Lifecycle rule | Contents |
| --- | --- | --- |
| `get-involve` | **Delete after 8 days, blank prefix** | Uploaded files only, at the bucket root |
| `involve-drop-data` | **None** | Everything that must persist |

The 8-day rule has an empty prefix, so it deletes *everything* in that bucket.
That is correct for uploaded files and catastrophic for anything else — it was
silently deleting session-revocation markers (making "sign out everywhere" stop
working after 8 days) and users' history and contacts. Hence the split.

Keys in `involve-drop-data`:

```
users/<google-sub>/history.json     transfers, download counts
users/<google-sub>/contacts.json    remembered recipients
users/<google-sub>/security.json    session revocation cut-off
index/email/<address>.json          email → account lookup
short-urls/<shortId>.json           live download links
slides/index.json                   landing page content
slides/media/<id>.<ext>             landing page images
```

**Anything new that must persist goes in the data bucket, via the `readJson` /
`writeJson` / `deleteJson` helpers in `index.js`. A raw `PutObjectCommand` to
the file bucket will work perfectly for a week and then vanish.**

### Auth

Google Identity Services in the browser; a loopback + PKCE flow in the desktop
app (`src-tauri/src/oauth.rs`, dependency-free). Both exchange at
`/auth/google` or `/auth/google/desktop` for an **HMAC-signed stateless session
token** issued by our own server — no sessions table. The `hd` claim is checked,
so only `@involve.no` accounts get in. Revocation is a per-user cut-off
timestamp in R2, checked on each request with a 60-second cache and a 2-second
timeout that **fails open** — if R2 is unreachable, auth still works.

### How a transfer actually flows

1. Browser asks the API for a presigned R2 URL, or starts a multipart upload.
2. **Bytes go browser → R2 directly.** They never touch the VPS.
3. The API stores a short-link record and returns `file.involve.no/s/<id>`.
4. The recipient gets a branded email, lands on a server-rendered page, and
   clicks through to a presigned download.

Multi-file selections are **zipped and uploaded simultaneously**
(`src/lib/zipUpload.js`) — see §2.

---

## 2. Current state — working and tested

Everything below is live and has been exercised with real transfers.

**Transfers**
- Single files to 20 GB, multipart above 100 MB, 16–64 MB parts, per-part
  retries, resumable-ish (a failed part retries rather than the whole file).
- **Streaming zip**: multi-file and folder selections are zipped *as they
  upload*, so the archive never exists in memory. Replaced `JSZip.generateAsync`,
  which built one buffer and hit V8's ~2.1 GB allocation ceiling — 96 photos
  totalling 2.1 GB failed. Verified in Node that streamed output is
  byte-identical to a normal archive and unpacks intact across many small files,
  a file spanning parts, empty files, deep paths, Norwegian filenames, and an
  exact part-size multiple. Tested live at 2.1 GB and 12 GB.
- Folder drag-and-drop, recursive, structure preserved. Requires
  `dragDropEnabled: false` in `tauri.conf.json` or the desktop webview never
  sees the drop.
- Real upload progress and working cancel (aborts in-flight parts and the
  multipart upload).

**Links and recipients**
- Optional link passwords (scrypt, rate-limited, never emailed).
- Link revocation from history; expiry 1/3/7 days, capped at 7 by the presigned
  URL limit.
- Branded landing page at `/s/<id>` with a rotating showcase — one of N slides
  picked at random per visit. Falls back to a plain card if a slide fails to
  render, so bad content can never block a download.
- Download counts and optional receipts. **Receipts fire on the actual
  download**, not on opening the page, and carry a per-recipient token so they
  name who collected it. Link scanners (Outlook Safe Links and similar), HEAD
  requests and browser prefetch are filtered out.

**Content editor ("Innhold")**
- Any signed-in `@involve.no` user can edit the landing-page slides: text,
  links, images, per-slide colours, on/off toggle, delete.
- Images are cropped and resized **in the browser** (16:9 backgrounds, square
  card images) before upload, so no native image library on the VPS.
- Concurrent edits are refused rather than silently overwriting: the list is
  fingerprinted, and a stale save returns 409 with "reload and try again".

**Operations**
- Nightly backup of the data bucket to `/var/backups/drop-involve`, 30 days
  retained (`server/scripts/backup-data.js`, cron 03:15).
- Uptime monitoring via a Google Apps Script (`uptime-monitor.gs`), 5-minute
  checks, alerts after two failures.
- Client crashes report to `/client-error` and land in `pm2 logs`.
- nginx proxies everything to Node; the app returns its own branded 404.

---

## 3. The missing 10%

### Needs doing before it's finished

**1. v0.1.46 is written but unverified.** It carries automatic updates, the
macOS dock fix, streaming uploads and Inter. Two parts have never been compiled
on macOS — only on Windows and in CI:
- `RunEvent::Reopen` in `src-tauri/src/main.rs` (the dock fix). The variant and
  its `has_visible_windows` field were checked against the macOS-target docs,
  but not compiled.
- The tray template icon, which needed the `image-png` Cargo feature — that
  already caught one CI failure.

Tag it, watch the macOS job, and test on a Mac: close the window (it hides to
the tray), then click the dock icon.

**2. Automatic updates are new and unproven.** Checks on launch and every six
hours, installs without asking, but never while a transfer is running or while
the window is focused. **Unknown:** whether the Windows NSIS installer raises a
UAC prompt during a background update. If it does, the app will sit waiting for
a click and the fix is to defer installation to the next launch.

**3. Restricting the content editor. (Implemented)** Supported via optional
`CONTENT_EDITORS` in `.env` (comma-separated list of emails). Enforced on
`GET/PUT /admin/slides` and `POST /admin/slides/media`, with `GET /me` exposing
permissions to the client. Fails open when unset/empty to avoid lockout.

**4. Only one slide is switched on.** Every recipient currently sees the same
page. The rotation does nothing until more are enabled, and the placeholder
slides still contain invented copy for two of the six.

### Housekeeping

- **Remove the old-bucket read fallback (DONE)** in `readJson` and `deleteJson`
  (`index.js`). Fallback removed; storage helpers now strictly target `DATA_BUCKET`.

- **`client/public/favicon.png` regenerated (DONE)** to brand yellow `#F5FF8C`
  from `src-tauri/icon-source.png` (32x32, matching `favicon.svg`).

- **Three unused Cloudflare Workers**: `drop-involve-frontend`,
  `soft-glitter-d8b9`, `noisy-bar-5b50`. The first serves a real copy of the app
  at a `workers.dev` URL and once caused an hour of confusion when `npm run
  deploy` published to it instead of Pages.
- **VPS wants a reboot** — pending kernel and ~60 apt updates. Confirm
  `pm2 startup` is configured first.
- **Two npm audit findings remain**, both unreachable: `uuid` via `gaxios` via
  `google-auth-library`. Fixing needs a major bump of the library that verifies
  Google sign-in. Documented in `TODO.md`.
- **Form fields have no `<label>`s** — placeholders only, so screen readers
  announce nothing useful.
- **`actions/checkout@v4` and `setup-node@v4`** are deprecated on the runners.
- **Retire the Render service.** Unused since the API moved to the VPS, but it
  still auto-deploys from the same repo and drifts.

### Deliberately deferred

- **Apple code signing** ($99/yr). macOS shows a Gatekeeper warning; the app must
  be approved through Privacy & Security. Judged not worth it for ~20 users.
  Windows SmartScreen warns similarly.
- **Rotating the Tauri updater key.** `src-tauri/updater.key` was committed to a
  public repo between 12 May and 14 August. It is password-encrypted and remains
  in git history regardless. Rotating means shipping one release signed with the
  old key that carries the new public key, then switching.
- **Raising `MAX_SIZE_BYTES`** from 20 GB. The streaming upload could handle
  ~160 GB; the cap is a product decision, not a technical one.

### Known constraints, not bugs

- **Emails cannot use the brand fonts.** Clients strip `@font-face`, so body
  text is Helvetica/Arial. The monospace details survive via the generic
  `monospace` keyword. Desktop Outlook also ignores `border-radius`, so the card
  is square there.
- **Rate limiting, download de-duplication and the slide cache live in process
  memory.** Correct with one process. Running pm2 in cluster mode would silently
  halve the brute-force limit and double-count downloads. Move that state to R2
  before adding workers.
- **Link expiry is capped at 7 days** by the SigV4 presigned URL maximum.

---

## 4. File tree

```
Upload link/
├── client/                       ← repo: medi2015/drop-involve-frontend
│   ├── index.html                Inter is loaded here
│   ├── vite.config.js
│   ├── postcss.config.js
│   ├── wrangler.jsonc            Worker config; Pages ignores it (see DEPLOY.md)
│   ├── scripts/predeploy.js      strips Worker artefacts before a Pages deploy
│   ├── .github/workflows/build.yml
│   │       create-release → build (mac + win) → publish-release.
│   │       Fails fast if the git tag and tauri.conf.json version disagree.
│   ├── public/
│   │   ├── involve-logo-white.png
│   │   ├── involve-wordmark-sand.png   used by the emails
│   │   ├── download-icon.png           used by the emails
│   │   └── favicon.png / favicon.svg
│   ├── src/
│   │   ├── main.jsx
│   │   ├── App.jsx               header, view switching, auto-updater
│   │   ├── index.css             Tailwind v4 @theme — the brand palette
│   │   ├── components/
│   │   │   ├── UploadCard.jsx    the main screen: drop, form, progress, history
│   │   │   ├── ContentAdmin.jsx  the "Innhold" landing-page editor
│   │   │   ├── ImagePicker.jsx   crop + resize + upload
│   │   │   ├── LoginScreen.jsx
│   │   │   └── ErrorBoundary.jsx
│   │   └── lib/
│   │       ├── api.js            API_BASE, Google client IDs, isDesktop()
│   │       ├── auth.js           session in localStorage
│   │       ├── desktopAuth.js    loopback + PKCE for Tauri
│   │       ├── multipart.js      multipart primitives + single-file upload
│   │       ├── zipUpload.js      streaming zip → multipart (see §2)
│   │       ├── images.js         canvas crop/resize maths
│   │       ├── storage.js
│   │       └── reportError.js    crashes → /client-error → pm2 logs
│   └── src-tauri/
│       ├── tauri.conf.json       version lives here, NOT in the git tag
│       ├── Cargo.toml            tauri features: devtools, tray-icon, image-png
│       ├── icon-source.png       1024px source; regenerate icons from this
│       └── src/
│           ├── main.rs           tray, window hiding, macOS Reopen
│           └── oauth.rs          loopback OAuth server
│
└── server/                       ← repo: medi2015/drop-involve-backend
    ├── index.js                  all routes, auth, R2, buckets
    ├── pages.js                  recipient landing / expired / error pages
    ├── emails.js                 recipient email + download receipt
    ├── mailer.js                 SMTP or Resend
    ├── slides.js                 placeholder slides + random pick + safe render
    ├── slidesStore.js            slide storage, validation, revision check
    ├── scripts/
    │   ├── backup-data.js        nightly backup (cron)
    │   └── migrate-metadata.js   one-off bucket migration, kept for reference
    ├── DEPLOY.md                 ← read this before deploying anything
    ├── TODO.md                   ← outstanding work, with the reasoning
    ├── HANDOFF.md                this file
    ├── PLAN-google-sso.md        historical
    ├── uptime-monitor.gs         Google Apps Script monitor
    └── vps-api-setup.sh
```

**Not in git:** `.env` on the VPS, and `client/src-tauri/updater.key`.

---

## 5. Things that will bite you

Learned the hard way; each cost real time.

1. **The desktop version comes from `tauri.conf.json`, not the git tag.** The
   workflow substitutes it. Tagging `v0.1.45` while the config says `0.1.44`
   builds 0.1.44 and collides with the existing release. The workflow now fails
   in six seconds on a mismatch — that guard is load-bearing.

2. **`npm run deploy` publishes to Cloudflare *Pages*, project
   `drop-involve-page`.** A Worker called `drop-involve-frontend` also exists and
   serves the same app at a `workers.dev` URL that nothing points at. Deploying
   to it succeeds and changes nothing users see.

3. **Use `npm ci` on the VPS, never `npm install`.** `npm install` rewrites
   `package-lock.json`, which is tracked, and the next `git pull` then refuses.

4. **Edit the nginx config with `nano`, never `sed`.** Chained `sed` inserts
   once produced a duplicate `location` block. nginx kept serving from memory
   for a day, then died when certbot reloaded it — the site was down for two
   days. Always `nginx -t && systemctl reload nginx`.

5. **Never put a lifecycle rule on `involve-drop-data`**, and never write
   persistent data to `get-involve`. See §1.

6. **Secrets never go in the repo.** `.env` and the nginx config belong in a
   password manager. The working folder is a git repo.

---

## 6. Environment variables (VPS `.env`)

```
PORT
R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
R2_BUCKET_NAME        = get-involve          (expiring; files)
R2_DATA_BUCKET        = involve-drop-data    (permanent; everything else)
SESSION_SECRET
SMTP_HOST, SMTP_PORT, MAIL_FROM
GOOGLE_CLIENT_ID, GOOGLE_DESKTOP_CLIENT_ID, GOOGLE_DESKTOP_CLIENT_SECRET
RESEND_API_KEY        (fallback only)
ADMIN_EMAILS          (for /admin/revoke-user)
CONTENT_EDITORS       (optional, comma-separated; restricts landing-page editor)
```

`R2_ENDPOINT` plus `forcePathStyle` is load-bearing — without it every `/s/`
redirect breaks.

After editing, restart with `pm2 restart drop-backend --update-env` or the
change is not picked up.
