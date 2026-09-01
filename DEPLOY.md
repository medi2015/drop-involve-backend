# Deploying Drop Involve

Three separate things get deployed, by three different routes. Changes only
reach production when you run these — editing files on your PC changes nothing
on its own.

---

## 1. Backend (the API)

Files: anything in `server/`

```cmd
cd /d "C:\Users\medio\Downloads\Antigravity\Upload link\server"
git status
git add -A
git commit -m "describe what changed"
git push
```

Then on the VPS over SSH:

```bash
cd /var/www/drop-involve-backend
git pull
npm install
pm2 restart drop-backend --update-env
pm2 logs drop-backend --lines 10 --nostream
```

`npm install` is only needed when dependencies changed, but it's harmless.

**Render** also auto-deploys from the same repo. It's the standby for old
desktop builds and stays on Resend for mail, because it has no `SMTP_HOST`.

---

## 2. Web app (drop.involve.no)

Files: anything in `client/src/`

```cmd
cd /d "C:\Users\medio\Downloads\Antigravity\Upload link\client"
git add -A
git commit -m "describe what changed"
git push
npm run deploy
```

Pushing to GitHub does **not** deploy the website. `npm run deploy` is what
publishes it — it builds and then runs `wrangler pages deploy`.

**Production is Cloudflare Pages, project `drop-involve-page`.** There is also
a Worker called `drop-involve-frontend` serving the same app at
`drop-involve-frontend.mediozo.workers.dev`. Nothing points at it. Until
25 August, `npm run deploy` published to *that Worker*, so it reported success
while drop.involve.no went on serving the previous build. If a change ever
seems not to land, confirm which of the two you actually deployed to:

```cmd
npx wrangler pages project list
```

The project whose domains include `drop.involve.no` is the real one.

---

## 3. Desktop apps (Mac + Windows)

Files: `client/src/`, `client/src-tauri/`

**The version comes from `client/src-tauri/tauri.conf.json`, not from the git
tag.** The workflow substitutes `__VERSION__` from that file, so pushing tag
`v0.1.25` while the config still says `0.1.24` builds version 0.1.24 and
publishes it to a release called `v0.1.24`. The tag only triggers the build.

So: **bump the config first, then tag with the same number.** They must match.

Check what already exists before picking a number:

```cmd
git tag
```

Then: 

```cmd
cd /d "C:\Users\medio\Downloads\Antigravity\Upload link\client"
git add -A
git commit -m "Bump version to 0.1.XX"
git push
git tag v0.1.XX
git push origin v0.1.XX
```

Pushing the tag triggers GitHub Actions, which builds both platforms and
publishes a release with `latest.json`. Takes 10-20 minutes. Watch it at
github.com/medi2015/drop-involve-frontend/actions

Installed apps prompt to update a few seconds after a **fresh launch**. The app
lives in the system tray, so closing the window isn't enough — quit it properly.

---

## When something doesn't work

Check in this order:

1. **`git status` on your PC** — if files are listed as modified, the change was
   never pushed. This is the most common cause by a wide margin.
2. **`git log --oneline -1` on the VPS** — does it match what you pushed?
3. **`pm2 logs drop-backend --lines 20 --nostream`** — did it start cleanly?
4. **Cloudflare cache** — `file.involve.no` has a bypass rule now, but if a
   stale response persists, test with `?cb=123` on the end of the URL to
   confirm before purging.

---

## Environment variables

Not in git — set directly on each host.

**VPS** (`/var/www/drop-involve-backend/.env`): `PORT`, `R2_ENDPOINT`,
`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `R2_DATA_BUCKET`,
`RESEND_API_KEY`, `SESSION_SECRET`, `SMTP_HOST`, `SMTP_PORT`, `MAIL_FROM`,
`GOOGLE_CLIENT_ID`, `GOOGLE_DESKTOP_CLIENT_ID`, `GOOGLE_DESKTOP_CLIENT_SECRET`

**Two buckets, and they are not interchangeable.** `R2_BUCKET_NAME` holds
uploaded files and carries an 8-day lifecycle rule with a blank prefix, so
*everything* in it is deleted after 8 days. `R2_DATA_BUCKET` has no lifecycle
rule and holds history, contacts, session revocation markers, short-link
records and landing-page slides. Never add a lifecycle rule to the data bucket,
and never move metadata back into the file bucket.

**Render** (dashboard → Environment): `CLOUDFLARE_ACCOUNT_ID`, `PORT`,
`R2_ACCESS_KEY_ID`, `R2_BUCKET_NAME`, `R2_SECRET_ACCESS_KEY`, `RESEND_API_KEY`,
`SESSION_SECRET`

After editing `.env` on the VPS, restart with `--update-env` or the change
won't be picked up.
