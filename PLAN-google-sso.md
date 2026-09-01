# Plan — Google sign-in, protected links, and the design that goes with it

Written 14 August 2026. Covers the web app; desktop follows separately.

## What changes and what doesn't

Senders sign in. Recipients never do — clients are external and can't have
accounts on involve.no, so download links stay public. That split already
exists in the code:

| Route | Access | Change |
|---|---|---|
| `/s/:id`, `/track-download` | public | password prompt added (optional per link) |
| `/generate-upload-url` | `requireSession` | unchanged |
| `/generate-download-url` | `requireSession` | unchanged |
| `/send-email` | `requireSession` | unchanged |
| `/request-code`, `/verify-code` | public | kept for desktop, removed later |

`requireSession` is the seam. Only the token *issuer* changes — from "typed the
right email code" to "presented a valid Google ID token". Nothing downstream
cares which.

---

## Phase 1 — Google Cloud Console

One-off setup, no code.

1. Use (or create) a Google Cloud project owned by the involve.no Workspace org.
2. **OAuth consent screen → User type: Internal.** This is the important one:
   Internal restricts sign-in to involve.no accounts automatically and skips
   Google's app-verification review entirely.
3. Scopes: `openid`, `email`, `profile`. Nothing else. Sensitive scopes would
   trigger a review process we don't need.
4. Create an OAuth client, type **Web application**:
   - Authorised JavaScript origins: `https://drop.involve.no`,
     `http://localhost:5173`
   - No redirect URIs needed — Google Identity Services returns the token to
     the page rather than redirecting.
5. Note the client ID. It is not a secret; it ships in the frontend bundle.

## Phase 2 — Backend authentication

Add `google-auth-library`.

**New route `POST /auth/google`**

Takes the ID token from the browser. Verifies signature and issuer against
Google's published keys, then checks three claims:

- `aud` matches our client ID — the token was minted for us, not another app
- `hd === 'involve.no'` — the account belongs to the org
- `email_verified === true`

Only then issue a session. The `hd` check replaces today's
`emailFrom.endsWith('@involve.no')`, and unlike that string comparison it can't
be forged, because Google signed it.

**Never trust claims read client-side.** The browser sends the raw token; the
server decides what it means.

**Session token gains fields**

```
{ sub, email, name, method: 'google', exp }
```

`sub` is Google's stable user ID. Key stored data on it rather than email —
addresses change when people marry or change roles, `sub` doesn't.

**Lifetime:** 12 hours for Google sessions, versus 30 minutes for code-based
ones. Longer is safe because Google enforces its own session policy upstream.

**Revocation** stays imperfect while tokens are stateless: disabling someone's
Workspace account stops new sign-ins but doesn't kill a token already issued.
Twelve hours bounds the exposure. A sessions table can come with the history
feature, which needs one anyway.

## Phase 3 — Web frontend

**Sign-in screen.** Shown when no session exists. Involve mark, one line of
explanation, one button: "Logg inn med Google". Dark green, sand, yellow — same
palette as the app. No email field, no code field.

**Signed-in state.** Small identity block in the header: name, email, sign out.

**The upload form gets simpler.** Two fields disappear because we already know
who the user is:

- "Din e-post (@involve.no)" — comes from the token
- The 6-digit code field — gone entirely on web

Both transfer modes lose a step. Link mode in particular goes back to being one
click, which is what it was before we added verification this morning.

**Session persistence.** Token in `localStorage`, restored on load, cleared on
sign out. Wrapped in the safe accessors from `lib/storage.js` so a corrupt value
can't white-screen the app again.

## Phase 4 — Password-protected links

Optional per link. Off by default.

**Creating.** A password field appears next to the expiry selector. When set,
the short-link record in R2 gains a hash:

```json
{ "longUrl": "...", "passwordHash": "scrypt$...", "createdBy": "sub", "createdAt": 0 }
```

`crypto.scrypt`, already in Node core — no new dependency. Never store the
password itself.

**Opening.** `GET /s/:id` currently redirects immediately. With a password set
it instead returns a small page asking for it; `POST /s/:id` checks the hash and
redirects on success. Attempts rate limited per short ID to stop guessing.

**Sharing the password is the user's problem** — by phone, in person, however.
Sending it in the same email would defeat the point, and the UI should say so
plainly rather than assuming people know.

## Phase 5 — The pages clients actually see

Currently `/s/:id` failure renders:

```html
<h1>Linken er utløpt eller finnes ikke</h1>
```

No styling, no branding, no explanation. For an agency this is the worst place
to look unfinished — it's the one page external clients reliably see when
something goes wrong.

Three server-rendered pages, in the brand palette, sharing one small template:

- **Password prompt** — filename, who sent it, one input
- **Wrong password** — the prompt again with an error, no detail that would
  help someone guessing
- **Expired or missing** — explain that files are kept for a limited time and
  suggest asking the sender for a new link

Server-rendered rather than React: they must load instantly for someone who has
never used Drop, and shipping a bundle for a single message is wasteful.

## Phase 6 — Desktop

Separate piece of work, deliberately after the web ships.

Desktop keeps the email-code flow until then — the backend supports both
issuers simultaneously, so nothing breaks. When it's ready: `tauri-plugin-oauth`
with loopback redirect and PKCE, a second OAuth client of type Desktop, then a
release. Only once everyone is updated do `/request-code` and `/verify-code`
come out.

---

## Order of work

1. Console setup — blocks everything, no code
2. Backend `/auth/google` — testable with curl before any UI exists
3. Web sign-in screen and simplified form
4. Recipient pages restyled — independent, could go first if preferred
5. Password-protected links
6. Desktop, later

## Decisions (14 August)

- **Gate the whole app.** No interface is shown until signed in.
- **Sessions last 30 days.** Safe because Google enforces its own session policy
  upstream; disabling a Workspace account stops new sign-ins immediately.
- **Passwords: minimum length only**, no complexity rules.

Note this makes the earlier point about revocation more pressing: a 30-day
stateless token can't be cancelled, so someone who leaves keeps a working token
until it expires. A sessions table fixes it properly and is needed for the
history feature anyway — worth doing before this sees heavy use.
