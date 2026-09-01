# Drop Involve — what's left

Written 15 August 2026. Nothing here is urgent; roughly in priority order.

---

## Editing the nginx config — read this first

On 21 August a `sed` edit left a duplicate `location /client-error` block. The
config was invalid from that moment, but nginx carried on serving from what it
already held in memory. It only died the next morning, when certbot's renewal
made it re-read from disk — and the site was then down for two days.

So:

- **Edit `/etc/nginx/sites-available/file.involve.no` with `nano`**, not `sed`.
  Chained inserts silently duplicate lines.
- **Always `nginx -t && systemctl reload nginx`** after any change. A reload
  forces a re-read, so a broken config fails while you're watching rather than
  at 06:00 on a Saturday.
- `nginx -t` passing is not enough on its own. The running process can be
  healthy while the file on disk is unloadable.

---

## Operational

### Remove the old-bucket read fallback
`readJson` in `server/index.js` reads the data bucket, then falls back to the
file bucket. That fallback existed only to cover the migration on 1 September
and is now dead weight — an extra R2 round trip on every genuine miss.

Safe to delete once everything has been rewritten to the new bucket, so from
around 10 September. Delete the `users/`, `short-urls/` and `index/` copies
left behind in `get-involve` at the same time; the lifecycle rule will have
removed them anyway.

### Never put a lifecycle rule on the data bucket
`involve-drop-data` holds history, contacts, session revocation markers,
short-link records and landing-page slides. None of it should ever expire. The
8-day rule on `get-involve` is correct for uploaded files and must stay.

### Retire Render
Unused since the API moved to the VPS. It runs the same repo, so it keeps
redeploying and drifting quietly out of date — which is precisely what made
debugging confusing on 14 August. Delete the service in the Render dashboard.

Check its request count first; it should be zero.

### Upgrade the VPS to Node 22
Deadline January 2027, when the AWS SDK stops supporting Node 20. Low risk now
that `better-sqlite3` — the only native module — has been removed.

```bash
node -v                      # currently 20.20.2
# install 22 via NodeSource, then:
cd /var/www/drop-involve-backend && npm install
pm2 restart drop-backend --update-env
pm2 logs drop-backend --lines 20 --nostream
```

### Two remaining npm audit findings, both unreachable
`uuid` before 11.1.1, pulled in through `gaxios` by `google-auth-library`.
Moderate: a missing buffer bounds check in uuid v3/v5/v6, but only when a
`buf` argument is passed — which nothing in our sign-in path does.

Fixing it needs `google-auth-library` 10.x, a major bump on the code that
verifies Google sign-in. Not worth it for an advisory we can't reach. Revisit
when that library is being upgraded for some other reason.

Everything else was cleared on 1 September, including nodemailer 6 → 9.

---

## Product and code

### Do not run pm2 in cluster mode without moving this state out of memory
Three things are counted in process memory: the password rate limiter
(`linkAttempts`), the download de-duplication (`recentDownloads`), and the
slide cache. With one process they're correct. With two, the brute-force limit
silently doubles, downloads get counted twice, and an edited slide takes up to
a minute longer to appear on one of the workers.

None of that raises an error — it just quietly stops working as intended. If
more capacity is ever needed, move the first two into R2 (or Redis) *before*
adding workers. At ~20 users this is nowhere near necessary.

### Accessible form labels
Fields use placeholders with no `<label>`, so a screen reader announces
nothing useful. Placeholders also vanish once typing starts, which is a
problem for anyone who loses their place. Applies to: Send til, Din melding,
Utløper om, Passord på lenken.

### Stream the zip instead of building it in memory
`JSZip.generateAsync({ type: 'blob' })` materialises the whole archive before a
single byte is uploaded, so a folder starts failing somewhere around 1–2 GB
depending on the machine. The upload itself is already streamed — this is
purely the zip step.

No backend change needed: `/multipart/sign` already signs parts on demand,
which is exactly what a streaming producer requires.

1. Swap JSZip for `client-zip` (or `@zip.js/zip.js`), which returns a
   `ReadableStream`. Both are STORE-only, which matches what JSZip does today
   since we never pass `compression: 'DEFLATE'` — output is comparable, just
   streamed. **Confirm zip64 is enabled**, or anything over 4 GB unpacks corrupt.
2. Add `uploadStreamInParts()` beside `uploadInParts()` in `lib/multipart.js`.
   Same create/sign/complete/abort flow; only the source of each blob changes.
3. Buffer stream chunks until `partSize` is reached, emit a part, repeat. The
   final part is whatever remains.
4. Bound the read-ahead, or the producer just refills memory by another route.
   A queue of ~2 parts plus 3 in flight at 16 MB is ~80 MB peak, and
   10,000 parts × 16 MB still allows 160 GB.
5. Always multipart when streaming — the total length isn't known upfront, so
   the single-PUT path can't be used.
6. Estimate progress from the sum of input file sizes. With STORE the archive
   lands within a fraction of a percent of that.
7. Cancel must abort the in-flight part, stop the producer, *and* call
   `/multipart/abort`. A stream that keeps pulling after cancellation leaks.
8. Test: nested folders, a folder over 5 GB, cancel mid-upload, network drop
   mid-part. Verify a downloaded zip actually unpacks at each size — the
   failure mode here is a silently corrupt file, not a visible error.

Roughly half a day with testing. On the desktop apps there's a shortcut worth
considering separately: Tauri has a real filesystem, so it could zip to a temp
file in Rust and upload from disk with near-zero memory and no streaming logic.
That does nothing for the website, though.

### Raise the file size cap
Currently 20 GB in `MAX_SIZE_BYTES`. Multipart handles far more — R2's real
ceiling is 4.995 TiB. 50 GB would give headroom over your largest videos.
Cost at 8-day retention is roughly $0.05 per 50 GB transfer.

### Cosmetic leftovers
- `client/public/favicon.png` still uses the old yellow `#F5FE6D`; the SVG was
  updated to brand `#F5FF8C` but the PNG is a binary and needs regenerating
- Three unused Cloudflare Workers: `soft-glitter-d8b9`, `noisy-bar-5b50`, and
  `drop-involve-frontend`. The last one serves a real copy of the app at
  `drop-involve-frontend.mediozo.workers.dev` with no custom domain attached,
  and it caused a confusing hour on 25 August: `npm run deploy` was publishing
  to it rather than to Pages, so deploys succeeded while the live site never
  changed. The npm script is fixed; deleting the Worker removes the ambiguity
  for good.
- `actions/checkout@v4` and `actions/setup-node@v4` are deprecated on Node 20
  runners — bumping to `@v5` silences the warnings

---

## Deferred deliberately

### Apple code signing and notarization
macOS shows a Gatekeeper warning and the app must be approved through Privacy
& Security. Fixing it means the Apple Developer Program at $99/year, plus
signing and notarizing in CI. Judged not worth it for ~20 users; revisit if it
rolls out more widely, or ask whether Involve's MDM can trust the app centrally.

Windows has a milder version of this — SmartScreen warns on first run because
the `.exe` is unsigned. A Windows certificate is a separate purchase.

### Rotate the Tauri updater signing key
`src-tauri/updater.key` was committed to the public repo between 12 May and
14 August. It's encrypted with a real password, so exposure is limited, and it
remains in git history regardless. Rotating means shipping one release signed
with the old key that carries the new public key, then switching.

---

## Done (14–15 August)

Desktop apps fixed · repo reconciled with production · backend moved off
Render's free tier · email moved from Resend (100/day) to Google Workspace
(10,000/day) · Google sign-in on web and desktop · email-code auth removed ·
unauthenticated upload endpoint closed · open email relay closed · password
protected links · branded recipient pages · server-side history and contacts ·
link revocation · download counts · multipart uploads for files over 5 GB ·
real upload progress · session revocation · client error reporting ·
health endpoint · R2 lifecycle 14 → 8 days · brand redesign · rebranded
recipient emails · password strength feedback · uptime monitoring on Google
Apps Script (5-minute checks, keyword match, alerts after two failures)

## Done (1 September)

Metadata moved out of the expiring bucket. The 8-day lifecycle rule on
`get-involve` had a blank prefix, so it deleted everything — not just uploaded
files. Session revocation markers were disappearing after 8 days, and a missing
marker reads as "nothing was revoked", so revoked sessions silently came back
for the rest of their 30-day life. History and contacts were being lost by
anyone who didn't send a file for a week; several colleagues had already lost
theirs. Now split: files stay in `get-involve` with the rule, everything else
lives in `involve-drop-data` with no rule.
