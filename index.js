const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const dotenv = require('dotenv');
const {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { nanoid } = require('nanoid');
const { OAuth2Client } = require('google-auth-library');
const { sendMail, verifyTransport, backend } = require('./mailer');
const { landingPage, expiredPage, errorPage } = require('./pages');
const { PLACEHOLDER_SLIDES, pickSlide, renderWithSlide } = require('./slides');
const { createSlideStore } = require('./slidesStore');
const { fileSharedEmail, downloadReceiptEmail } = require('./emails');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

const allowedOrigins = [
  'http://localhost:5173',     // Dev environment
  'http://tauri.localhost',    // Windows compiled .exe
  'tauri://localhost',         // Mac compiled .app
  'https://drop.involve.no',   // Live web version
  'https://file.involve.no'    // Password prompt posts back to its own origin
];

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  }
}));

app.use(express.json());
// The password prompt served to recipients is a plain HTML form.
app.use(express.urlencoded({ extended: false }));

// --- Link passwords -------------------------------------------------------
// Optional per link. Minimum length only: complexity rules mostly produce
// passwords written on sticky notes.
const MIN_LINK_PASSWORD_LENGTH = 6;
const LINK_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const LINK_ATTEMPT_MAX = 10;
const linkAttempts = new Map(); // shortId -> [timestamps]

const hashPassword = (password) =>
  new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString('hex');
    crypto.scrypt(password, salt, 32, (err, key) =>
      err ? reject(err) : resolve(`scrypt$${salt}$${key.toString('hex')}`)
    );
  });

const verifyPassword = (password, stored) =>
  new Promise((resolve) => {
    const [algorithm, salt, expected] = String(stored).split('$');
    if (algorithm !== 'scrypt' || !salt || !expected) return resolve(false);

    crypto.scrypt(password, salt, 32, (err, key) => {
      if (err) return resolve(false);
      const a = Buffer.from(expected, 'hex');
      resolve(a.length === key.length && crypto.timingSafeEqual(a, key));
    });
  });

/** Slows down guessing without locking a link permanently. */
const tooManyAttempts = (shortId) => {
  const now = Date.now();
  const recent = (linkAttempts.get(shortId) || []).filter(
    (t) => now - t < LINK_ATTEMPT_WINDOW_MS
  );

  if (recent.length >= LINK_ATTEMPT_MAX) {
    linkAttempts.set(shortId, recent);
    return true;
  }

  recent.push(now);
  linkAttempts.set(shortId, recent);
  return false;
};

// --- Buckets ---------------------------------------------------------------
//
// Two buckets, because they need opposite retention.
//
// The file bucket carries an 8-day lifecycle rule with a blank prefix, which is
// right for uploaded files — they're meant to self-delete — but it matched
// everything else in the bucket too. Session revocation markers were being
// deleted after 8 days, and a missing marker reads as "nothing was revoked", so
// a revoked session quietly came back to life for the rest of its 30 days.
// History and contacts disappeared for anyone who didn't send for a week.
//
// The data bucket has no lifecycle rule. Nothing here should ever expire.
const FILE_BUCKET = process.env.R2_BUCKET_NAME;
const DATA_BUCKET = process.env.R2_DATA_BUCKET || process.env.R2_BUCKET_NAME;

/**
 * Reads JSON from the data bucket, falling back to the file bucket.
 *
 * The fallback covers the migration: records written before the split still
 * live in the old bucket, and a link that stopped resolving mid-move would be
 * a broken download for someone outside Involve. It can be removed once the
 * old objects have aged out.
 */
const readJson = async (key) => {
  for (const Bucket of DATA_BUCKET === FILE_BUCKET ? [DATA_BUCKET] : [DATA_BUCKET, FILE_BUCKET]) {
    try {
      const response = await s3Client.send(new GetObjectCommand({ Bucket, Key: key }));
      return JSON.parse(await response.Body.transformToString());
    } catch {
      // Try the next bucket; a genuine miss returns null below.
    }
  }
  return null;
};

const writeJson = async (key, value) => {
  await s3Client.send(
    new PutObjectCommand({
      Bucket: DATA_BUCKET,
      Key: key,
      Body: JSON.stringify(value),
      ContentType: 'application/json',
    })
  );
};

/** Deletes from both buckets — during the migration a key may exist in either. */
const deleteJson = async (key) => {
  const buckets = DATA_BUCKET === FILE_BUCKET ? [DATA_BUCKET] : [DATA_BUCKET, FILE_BUCKET];
  for (const Bucket of buckets) {
    try {
      await s3Client.send(new DeleteObjectCommand({ Bucket, Key: key }));
    } catch (error) {
      console.warn(`[storage] could not delete ${key} from ${Bucket}:`, error.name);
    }
  }
};

// The landing-page showcase. Falls back to the built-in placeholders until
// someone saves a list for the first time.
const slideStore = createSlideStore({
  readJson: (key) => readJson(key),
  writeJson: (key, value) => writeJson(key, value),
  fallback: PLACEHOLDER_SLIDES,
});

// --- Transfer history -----------------------------------------------------
// One JSON object per user in R2, keyed on the Google `sub` rather than the
// email address so it survives someone changing name or role.
//
// Deliberately records only filename, link and dates — not who it was sent to.
// Storing recipients would turn this into a record of correspondence, which is
// personal data with a retention obligation attached.
const HISTORY_LIMIT = 100;

const historyKey = (sub) => `users/${sub}/history.json`;

const readHistory = async (sub) => {
  const parsed = await readJson(historyKey(sub));
  return Array.isArray(parsed) ? parsed : []; // no history yet
};

/**
 * Counts a download against the sender's history entry.
 *
 * Called after the redirect has already gone out, so a slow R2 round trip
 * never delays the recipient. Failures are swallowed deliberately — a missed
 * count is not worth breaking a download over.
 */
const recordDownload = async (owner, shortId) => {
  if (!owner || !shortId) return;

  try {
    const entries = await readHistory(owner);
    let changed = false;

    const updated = entries.map((entry) => {
      if (entry.id !== shortId) return entry;
      changed = true;
      return {
        ...entry,
        downloads: (entry.downloads || 0) + 1,
        lastDownloadedAt: Date.now(),
      };
    });

    if (changed) await writeHistory(owner, updated);
  } catch (error) {
    console.warn(`[downloads] could not record ${shortId}:`, error.name);
  }
};

const writeHistory = async (sub, entries) => {
  await writeJson(historyKey(sub), entries.slice(0, HISTORY_LIMIT));
};

// --- Contacts -------------------------------------------------------------
// Addresses this user has sent to before, so they don't retype them. Captured
// server-side because /send-email already has the recipient list, and stored
// per account so they follow the person between the website and the app.
//
// This is a list of people's email addresses, so it's personal data: capped,
// and deletable through DELETE /contacts.
const CONTACTS_LIMIT = 100;

const contactsKey = (sub) => `users/${sub}/contacts.json`;

const readContacts = async (sub) => {
  const parsed = await readJson(contactsKey(sub));
  return Array.isArray(parsed) ? parsed : [];
};

/** Most recently used first, de-duplicated case-insensitively. */
const rememberContacts = async (sub, addresses) => {
  if (!sub || !addresses?.length) return;

  try {
    const existing = await readContacts(sub);
    const seen = new Set();
    const merged = [];

    for (const address of [...addresses, ...existing]) {
      const key = String(address).toLowerCase().trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push(key);
    }

    await writeJson(contactsKey(sub), merged.slice(0, CONTACTS_LIMIT));
  } catch (error) {
    console.warn('[contacts] could not save:', error.name);
  }
};

/**
 * Builds a Content-Disposition header that survives non-ASCII filenames.
 *
 * `filename="..."` is not percent-decoded by browsers, so encodeURIComponent
 * alone means "Årsrapport.pdf" downloads as "%C3%85rsrapport.pdf". RFC 6266's
 * `filename*` carries the real name; the plain `filename` stays as an ASCII
 * fallback for anything that doesn't understand it.
 *
 * The client builds this identically for the PUT — the value is part of the
 * presigned signature, so the two must match byte for byte.
 */
const contentDispositionFor = (fileName) => {
  const ascii = String(fileName).replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
};

// Cloudflare R2 Client Configuration
//
// Two deployments use this file and they configure R2 differently:
//   Render  — sets CLOUDFLARE_ACCOUNT_ID, endpoint is derived from it
//   the VPS — sets R2_ENDPOINT directly, and needs path-style addressing
//
// Preferring R2_ENDPOINT when present keeps both working from one codebase.
// Without this, whichever host lacks its variable silently builds an endpoint
// of "https://undefined.r2.cloudflarestorage.com" and every R2 call fails.
const useExplicitEndpoint = Boolean(process.env.R2_ENDPOINT);

const s3Client = new S3Client({
  region: 'auto',
  endpoint: useExplicitEndpoint
    ? process.env.R2_ENDPOINT
    : `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  ...(useExplicitEndpoint ? { forcePathStyle: true } : {}),
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});


// --- Sessions -------------------------------------------------------------
// An HMAC-signed token proving the holder signed in with a Google account on
// the allowed Workspace domain. Stateless on purpose: nothing to store, and it
// survives restarts.
//
// The trade-off is that it can't be revoked. Disabling someone's Workspace
// account stops new sign-ins immediately, but a token already issued keeps
// working until it expires. A sessions table would fix that.
const GOOGLE_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Sign-in is restricted to this Workspace domain, checked against the `hd`
// claim Google puts in the ID token — not against a string the client sends.
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_ALLOWED_DOMAIN = process.env.GOOGLE_ALLOWED_DOMAIN || 'involve.no';
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

// The desktop apps use a separate OAuth client. Its secret stays here rather
// than being compiled into the binaries, so the app never talks to Google's
// token endpoint — it hands us the authorization code and we do the exchange.
const GOOGLE_DESKTOP_CLIENT_ID = process.env.GOOGLE_DESKTOP_CLIENT_ID;
const GOOGLE_DESKTOP_CLIENT_SECRET = process.env.GOOGLE_DESKTOP_CLIENT_SECRET;
const googleDesktopClient = GOOGLE_DESKTOP_CLIENT_ID
  ? new OAuth2Client(GOOGLE_DESKTOP_CLIENT_ID)
  : null;

/**
 * Shared gate for both sign-in routes: checks the claims Google asserted and
 * turns them into one of our sessions.
 *
 * @returns {{status: number, body: object}}
 */
function sessionFromGooglePayload(payload) {
  if (payload.hd !== GOOGLE_ALLOWED_DOMAIN) {
    console.warn(`[auth] wrong domain: ${payload.hd || 'none'} (${payload.email})`);
    return {
      status: 403,
      body: { error: `Kun ${GOOGLE_ALLOWED_DOMAIN}-kontoer har tilgang.` },
    };
  }

  if (!payload.email_verified) {
    return {
      status: 403,
      body: { error: 'E-postadressen er ikke bekreftet hos Google.' },
    };
  }

  const token = issueSessionToken(
    {
      sub: payload.sub,           // stable ID; survives email changes
      email: payload.email,
      name: payload.name,
      method: 'google',
    },
    GOOGLE_SESSION_TTL_MS
  );

  console.log(`[auth] signed in: ${payload.email}`);

  // So an admin can revoke by email later without knowing the subject id.
  rememberEmailIndex(payload.email, payload.sub);

  return {
    status: 200,
    body: {
      token,
      expiresIn: GOOGLE_SESSION_TTL_MS / 1000,
      user: {
        email: payload.email,
        name: payload.name,
        picture: payload.picture,
      },
    },
  };
}

const SESSION_SECRET = process.env.SESSION_SECRET || (() => {
  console.warn(
    '[auth] SESSION_SECRET is not set. Using an ephemeral secret, so tokens ' +
    'become invalid on restart. Set SESSION_SECRET in the environment.'
  );
  return crypto.randomBytes(32).toString('hex');
})();

// --- Revocation -----------------------------------------------------------
// Tokens are stateless, so they can't be withdrawn once issued. Rather than
// tracking every token, each user has a cut-off timestamp: any token issued
// before it is refused. One flag revokes every device at once, which is what
// both "sign out everywhere" and "this person has left" actually need.
//
// Cached briefly so this doesn't add an R2 read to every request. The cost is
// that revocation takes up to a minute to bite — acceptable, given the
// alternative was thirty days.
const REVOCATION_CACHE_MS = 60 * 1000;
// This check sits on every authenticated request, so it must never be the
// reason one hangs. If R2 is slow the AWS SDK retries with backoff for many
// seconds; we give up long before that and let the request through.
const REVOCATION_TIMEOUT_MS = 2000;
const revocationCache = new Map(); // sub -> { revokedBefore, fetchedAt }

const withTimeout = (promise, ms) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);

const securityKey = (sub) => `users/${sub}/security.json`;

const readRevokedBefore = async (sub) => {
  const cached = revocationCache.get(sub);
  if (cached && Date.now() - cached.fetchedAt < REVOCATION_CACHE_MS) {
    return cached.revokedBefore;
  }

  let revokedBefore = 0;
  try {
    const parsed = await withTimeout(readJson(securityKey(sub)), REVOCATION_TIMEOUT_MS);
    revokedBefore = Number(parsed?.revokedBefore) || 0;
  } catch (error) {
    if (error.message === 'timeout') {
      // Don't cache a value we didn't actually read, or a brief blip would
      // blind the check for a full minute.
      console.warn(`[auth] revocation lookup timed out for ${sub}`);
      return 0;
    }
    revokedBefore = 0; // no revocation record: nothing has been revoked
  }

  revocationCache.set(sub, { revokedBefore, fetchedAt: Date.now() });
  return revokedBefore;
};

const revokeSessionsFor = async (sub) => {
  const revokedBefore = Date.now();

  await writeJson(securityKey(sub), { revokedBefore });

  // Take effect immediately on this instance rather than after the cache TTL.
  revocationCache.set(sub, { revokedBefore, fetchedAt: Date.now() });
  return revokedBefore;
};

// Lets an admin revoke by email without knowing the Google subject id.
const emailIndexKey = (email) => `index/email/${String(email).toLowerCase()}.json`;

const rememberEmailIndex = async (email, sub) => {
  try {
    await writeJson(emailIndexKey(email), { sub });
  } catch (error) {
    console.warn('[auth] could not index email:', error.name);
  }
};

const subForEmail = async (email) => {
  const parsed = await readJson(emailIndexKey(email));
  return parsed?.sub || null;
};

const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(',')
  .map((entry) => entry.trim().toLowerCase())
  .filter(Boolean);

const sign = (payload) =>
  crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');

/**
 * @param {object} claims  e.g. { email, sub, name, method }
 * @param {number} ttlMs   how long the session should last
 */
function issueSessionToken(claims, ttlMs) {
  const now = Date.now();
  const payload = Buffer.from(
    // `iat` is what makes revocation possible: it's compared against the
    // user's cut-off timestamp on every request.
    JSON.stringify({ ...claims, iat: now, exp: now + ttlMs })
  ).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function verifySessionToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;

  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;

  const expected = Buffer.from(sign(payload));
  const provided = Buffer.from(signature);

  // Length check first: timingSafeEqual throws on mismatched lengths.
  if (expected.length !== provided.length) return null;
  if (!crypto.timingSafeEqual(expected, provided)) return null;

  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!data.exp || data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

async function requireSession(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const session = token ? verifySessionToken(token) : null;

  if (!session) {
    return res.status(401).json({ error: 'Du må logge inn på nytt.' });
  }

  // A valid signature isn't enough: the session may have been revoked since.
  if (session.sub) {
    try {
      const revokedBefore = await readRevokedBefore(session.sub);
      if (revokedBefore && (session.iat || 0) < revokedBefore) {
        return res.status(401).json({ error: 'Økten er avsluttet. Logg inn på nytt.' });
      }
    } catch (error) {
      // Fail open rather than locking everyone out if R2 is briefly
      // unreachable — the token is still signed and unexpired.
      console.warn('[auth] revocation check failed:', error.name);
    }
  }

  req.session = session;
  return next();
}

/**
 * Generate a Presigned URL for uploading a file (PUT)
 */
app.post('/generate-upload-url', requireSession, async (req, res) => {
  try {
    const { fileName, contentType } = req.body;

    if (!fileName || !contentType) {
      return res.status(400).json({ error: 'fileName and contentType are required' });
    }

    const fileExtension = fileName.split('.').pop();
    const objectKey = `${nanoid()}.${fileExtension}`;

    const command = new PutObjectCommand({
      Bucket: FILE_BUCKET,
      Key: objectKey,
      ContentType: contentType,
      ContentDisposition: contentDispositionFor(fileName)
    });

    const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });

    res.json({
      uploadUrl: uploadUrl,
      objectKey: objectKey,
    });
  } catch (error) {
    console.error('Error generating upload URL:', error);
    res.status(500).json({ error: 'Failed to generate upload URL' });
  }
});

/**
 * Generate a presigned download URL and shorten it.
 *
 * Registered for both GET and POST. POST exists because a link password must
 * not travel in a query string, where it would land in nginx logs, Cloudflare
 * logs and browser history. GET stays for desktop builds released before this.
 */
const generateDownloadUrl = async (req, res) => {
  try {
    const source = req.method === 'POST' ? req.body : req.query;
    const { objectKey, expiresIn, password, fileName, fileSize, message } = source || {};

    if (!objectKey) {
      return res.status(400).json({ error: 'objectKey is required' });
    }

    const command = new GetObjectCommand({
      Bucket: FILE_BUCKET,
      Key: objectKey,
    });

    let expirySeconds = parseInt(expiresIn) || 3600;
    const MAX_EXPIRY = 7 * 24 * 60 * 60; // 7 days
    if (expirySeconds > MAX_EXPIRY) {
      expirySeconds = MAX_EXPIRY;
    }

    // 1. Generate the original long S3 URL
    const longUrl = await getSignedUrl(s3Client, command, { expiresIn: expirySeconds });

    // 2. Create a short unique 6-character token
    const shortId = nanoid(6);

    // 3. Save the link mapping as a small JSON file directly into Cloudflare R2.
    //    Only a hash of the password is stored, never the password itself.
    // `owner` lets the public /s/ route attribute a download back to the sender
    // without the recipient being known or authenticated.
    // Everything the landing page needs is stored here, because /s/:id is
    // public and has no session to look anything up from. Links created before
    // this shipped lack these fields, so the page falls back gracefully.
    const record = {
      longUrl,
      owner: req.session?.sub || null,
      senderEmail: req.session?.email || null,
      fileName: fileName ? String(fileName).slice(0, 200) : null,
      fileSize: Number(fileSize) || null,
      message: message ? String(message).slice(0, 1000) : null,
      createdAt: Date.now(),
      expiresAt: Date.now() + expirySeconds * 1000,
    };

    if (password) {
      if (String(password).length < MIN_LINK_PASSWORD_LENGTH) {
        return res.status(400).json({
          error: `Passordet må ha minst ${MIN_LINK_PASSWORD_LENGTH} tegn.`,
        });
      }
      record.passwordHash = await hashPassword(String(password));
    }

    await writeJson(`short-urls/${shortId}.json`, record);

    // 4. Return the shortened domain URL back to the client
    const shortUrl = `https://file.involve.no/s/${shortId}`;

    // 5. Record it against the signed-in user. Done here rather than by the
    //    client so history can't be forged and doesn't depend on the device.
    if (req.session?.sub) {
      const entry = {
        id: shortId,
        fileName: fileName || 'Ukjent fil',
        url: shortUrl,
        objectKey,
        hasPassword: Boolean(password),
        createdAt: Date.now(),
        expiresAt: Date.now() + expirySeconds * 1000,
      };

      const entries = [entry, ...(await readHistory(req.session.sub))];
      await writeHistory(req.session.sub, entries);
    }

    res.json({ downloadUrl: shortUrl, protected: Boolean(password) });
  } catch (error) {
    console.error('Error generating download URL:', error);
    res.status(500).json({ error: 'Failed to generate download URL' });
  }
};

app.get('/generate-download-url', requireSession, generateDownloadUrl);
app.post('/generate-download-url', requireSession, generateDownloadUrl);

// --- Multipart uploads ----------------------------------------------------
// R2 accepts at most 4.995 GiB in a single PUT, so anything larger has to be
// split. Beyond raising the ceiling to ~5 TiB, this makes big transfers
// parallel and lets a failed part be retried instead of restarting the whole
// upload — and it sidesteps the one-hour presigned URL expiry, which a 20 GB
// upload can easily outlast.

/** Opens a multipart upload and returns the id the client will refer to. */
app.post('/multipart/create', requireSession, async (req, res) => {
  try {
    const { fileName, contentType } = req.body || {};

    if (!fileName || !contentType) {
      return res.status(400).json({ error: 'fileName and contentType are required' });
    }

    const fileExtension = fileName.split('.').pop();
    const objectKey = `${nanoid()}.${fileExtension}`;

    const { UploadId } = await s3Client.send(
      new CreateMultipartUploadCommand({
        Bucket: FILE_BUCKET,
        Key: objectKey,
        ContentType: contentType,
        ContentDisposition: contentDispositionFor(fileName),
      })
    );

    res.json({ uploadId: UploadId, objectKey });
  } catch (error) {
    console.error('Error creating multipart upload:', error);
    res.status(500).json({ error: 'Kunne ikke starte opplastingen.' });
  }
});

/** Presigns a batch of part URLs. Requested in batches so they stay fresh. */
app.post('/multipart/sign', requireSession, async (req, res) => {
  try {
    const { objectKey, uploadId, partNumbers } = req.body || {};

    if (!objectKey || !uploadId || !Array.isArray(partNumbers) || partNumbers.length === 0) {
      return res.status(400).json({ error: 'objectKey, uploadId and partNumbers are required' });
    }

    if (partNumbers.length > 100) {
      return res.status(400).json({ error: 'Be om maks 100 deler om gangen.' });
    }

    const urls = {};
    await Promise.all(
      partNumbers.map(async (partNumber) => {
        urls[partNumber] = await getSignedUrl(
          s3Client,
          new UploadPartCommand({
            Bucket: FILE_BUCKET,
            Key: objectKey,
            UploadId: uploadId,
            PartNumber: Number(partNumber),
          }),
          { expiresIn: 3600 }
        );
      })
    );

    res.json({ urls });
  } catch (error) {
    console.error('Error signing parts:', error);
    res.status(500).json({ error: 'Kunne ikke signere deler.' });
  }
});

/** Assembles the parts into the finished object. */
app.post('/multipart/complete', requireSession, async (req, res) => {
  try {
    const { objectKey, uploadId, parts } = req.body || {};

    if (!objectKey || !uploadId || !Array.isArray(parts) || parts.length === 0) {
      return res.status(400).json({ error: 'objectKey, uploadId and parts are required' });
    }

    await s3Client.send(
      new CompleteMultipartUploadCommand({
        Bucket: FILE_BUCKET,
        Key: objectKey,
        UploadId: uploadId,
        MultipartUpload: {
          // R2 requires ascending part numbers.
          Parts: parts
            .map((part) => ({ PartNumber: Number(part.PartNumber), ETag: part.ETag }))
            .sort((a, b) => a.PartNumber - b.PartNumber),
        },
      })
    );

    res.json({ ok: true, objectKey });
  } catch (error) {
    console.error('Error completing multipart upload:', error);
    res.status(500).json({ error: 'Kunne ikke fullføre opplastingen.' });
  }
});

/** Cancels an upload so the uploaded parts don't linger and accrue storage. */
app.post('/multipart/abort', requireSession, async (req, res) => {
  const { objectKey, uploadId } = req.body || {};

  if (!objectKey || !uploadId) {
    return res.status(400).json({ error: 'objectKey and uploadId are required' });
  }

  try {
    await s3Client.send(
      new AbortMultipartUploadCommand({
        Bucket: FILE_BUCKET,
        Key: objectKey,
        UploadId: uploadId,
      })
    );
    res.json({ ok: true });
  } catch (error) {
    console.warn('Error aborting multipart upload:', error.name);
    res.json({ ok: false }); // best effort; the lifecycle rule cleans up anyway
  }
});

/** Signs the user out of every device, including this one. */
app.post('/auth/revoke-sessions', requireSession, async (req, res) => {
  if (!req.session.sub) {
    return res.status(400).json({ error: 'Ingen konto knyttet til økten.' });
  }

  try {
    await revokeSessionsFor(req.session.sub);
    console.log(`[auth] ${req.session.email} signed out everywhere`);
    res.json({ ok: true });
  } catch (error) {
    console.error('Error revoking sessions:', error);
    res.status(500).json({ error: 'Kunne ikke logge ut alle enheter.' });
  }
});

/**
 * Cuts off someone who has left.
 *
 * Disabling a Workspace account stops new sign-ins immediately, but a token
 * already on their laptop stays valid until it expires. This ends it now.
 * Restricted to ADMIN_EMAILS — with that unset, the route is disabled.
 */
app.post('/admin/revoke-user', requireSession, async (req, res) => {
  const caller = String(req.session.email || '').toLowerCase();

  if (ADMIN_EMAILS.length === 0 || !ADMIN_EMAILS.includes(caller)) {
    return res.status(403).json({ error: 'Ikke tilgang.' });
  }

  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'email er påkrevd.' });

  const sub = await subForEmail(email);
  if (!sub) {
    return res.status(404).json({ error: 'Fant ingen bruker med den adressen.' });
  }

  try {
    await revokeSessionsFor(sub);
    console.log(`[auth] ${caller} revoked all sessions for ${email}`);
    res.json({ ok: true });
  } catch (error) {
    console.error('Error revoking user:', error);
    res.status(500).json({ error: 'Kunne ikke trekke tilbake øktene.' });
  }
});

// --- Client error reports -------------------------------------------------
// Crashes in the browser or the desktop app are otherwise invisible: the user
// sees the ErrorBoundary screen and nobody else ever hears about it. This is
// unauthenticated on purpose — a crash on the sign-in screen is exactly the
// kind we most want to know about — so it's capped to stop the logs being
// flooded by anyone who finds the endpoint.
const ERROR_REPORT_WINDOW_MS = 60 * 60 * 1000;
const ERROR_REPORT_MAX = 60;
let errorReports = [];

app.post('/client-error', (req, res) => {
  const now = Date.now();
  errorReports = errorReports.filter((t) => now - t < ERROR_REPORT_WINDOW_MS);

  if (errorReports.length >= ERROR_REPORT_MAX) {
    return res.status(429).json({ ok: false });
  }
  errorReports.push(now);

  const { message, stack, context, appVersion, userAgent } = req.body || {};
  const clip = (value, max) => String(value ?? '').slice(0, max);

  console.error(
    `[client] ${clip(message, 300)}\n` +
    `         where: ${clip(context, 120)} | v${clip(appVersion, 20)}\n` +
    `         agent: ${clip(userAgent, 200)}\n` +
    `${clip(stack, 3000)}`
  );

  // Always 204: a failed error report must never cascade into another error.
  res.status(204).end();
});

/**
 * Liveness check for uptime monitoring.
 *
 * Deliberately cheap and unauthenticated: it proves nginx is routing and the
 * Node process is answering, which covers the failure modes that actually take
 * this service down. It doesn't touch R2 — a monitor polling every five minutes
 * would otherwise make ~9,000 storage calls a month to tell us nothing new.
 */
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    uptimeSeconds: Math.round(process.uptime()),
    mail: backend,
  });
});

/** Addresses this user has sent to before, most recent first. */
app.get('/contacts', requireSession, async (req, res) => {
  if (!req.session.sub) return res.json({ items: [] });
  res.json({ items: await readContacts(req.session.sub) });
});

/** Clears the saved list — these are other people's addresses. */
app.delete('/contacts', requireSession, async (req, res) => {
  if (!req.session.sub) return res.status(403).json({ error: 'Ingen kontakter for denne økten.' });

  try {
    await deleteJson(contactsKey(req.session.sub));
    res.json({ ok: true });
  } catch (error) {
    console.error('Error clearing contacts:', error);
    res.status(500).json({ error: 'Kunne ikke slette kontaktene.' });
  }
});

/**
 * The signed-in user's transfers, newest first, across every device.
 */
app.get('/history', requireSession, async (req, res) => {
  if (!req.session.sub) return res.json({ items: [] });

  try {
    res.json({ items: await readHistory(req.session.sub) });
  } catch (error) {
    console.error('Error reading history:', error);
    res.status(500).json({ error: 'Kunne ikke hente historikk.' });
  }
});

/**
 * Revoke a link.
 *
 * Deletes both the short-link mapping and the stored file, so the link stops
 * working immediately rather than at its expiry — the case being "I sent that
 * to the wrong person". Not recoverable, which is the point.
 */
app.delete('/history/:shortId', requireSession, async (req, res) => {
  if (!req.session.sub) return res.status(403).json({ error: 'Ingen historikk for denne økten.' });

  const { shortId } = req.params;

  try {
    const entries = await readHistory(req.session.sub);
    const entry = entries.find((item) => item.id === shortId);

    if (!entry) {
      return res.status(404).json({ error: 'Fant ikke overføringen.' });
    }

    // Best effort on both: a missing object shouldn't block the rest.
    // The record lives in the data bucket, the file itself in the file bucket.
    await deleteJson(`short-urls/${shortId}.json`);

    if (entry.objectKey) {
      try {
        await s3Client.send(
          new DeleteObjectCommand({ Bucket: FILE_BUCKET, Key: entry.objectKey })
        );
      } catch (error) {
        console.warn(`[revoke] could not delete ${entry.objectKey}:`, error.name);
      }
    }

    await writeHistory(req.session.sub, entries.filter((item) => item.id !== shortId));

    console.log(`[revoke] ${req.session.email} revoked ${shortId}`);
    res.json({ ok: true });
  } catch (error) {
    console.error('Error revoking link:', error);
    res.status(500).json({ error: 'Kunne ikke trekke tilbake lenken.' });
  }
});
/**
 * Sign in with Google.
 *
 * The browser sends the ID token it got from Google Identity Services. We
 * verify it here rather than trusting anything the client claims about itself:
 * google-auth-library checks the signature against Google's published keys and
 * that the audience is our client ID, then we check the account belongs to the
 * right Workspace domain.
 */
app.post('/auth/google', async (req, res) => {
  if (!googleClient) {
    return res.status(503).json({ error: 'Google-innlogging er ikke konfigurert.' });
  }

  const { credential } = req.body;
  if (typeof credential !== 'string' || !credential) {
    return res.status(400).json({ error: 'Mangler Google-token.' });
  }

  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: GOOGLE_CLIENT_ID,
    });
    payload = ticket.getPayload();
  } catch (error) {
    console.warn('[auth] rejected Google token:', error.message);
    return res.status(401).json({ error: 'Ugyldig Google-token.' });
  }

  // `hd` is the Workspace domain, asserted by Google. This replaces the old
  // emailFrom.endsWith('@involve.no') check, which trusted the client.
  const { status, body } = sessionFromGooglePayload(payload);
  return res.status(status).json(body);
});

/**
 * Sign in from the desktop apps.
 *
 * The app runs a temporary loopback server, catches the authorization code
 * Google redirects to it, and posts the code here. We exchange it — the client
 * secret lives on this server, not in the shipped binaries — then verify the
 * resulting ID token exactly as the web route does.
 */
app.post('/auth/google/desktop', async (req, res) => {
  if (!googleDesktopClient || !GOOGLE_DESKTOP_CLIENT_SECRET) {
    return res.status(503).json({ error: 'Google-innlogging for skrivebord er ikke konfigurert.' });
  }

  const { code, codeVerifier, redirectUri } = req.body || {};

  if (!code || !codeVerifier || !redirectUri) {
    return res.status(400).json({ error: 'Mangler code, codeVerifier eller redirectUri.' });
  }

  // Only loopback addresses. Without this the endpoint could be pointed at an
  // attacker's host as part of a code-interception attempt.
  if (!/^http:\/\/(127\.0\.0\.1|localhost):\d{1,5}\/?$/.test(redirectUri)) {
    return res.status(400).json({ error: 'Ugyldig redirectUri.' });
  }

  let idToken;
  try {
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        code_verifier: codeVerifier,
        client_id: GOOGLE_DESKTOP_CLIENT_ID,
        client_secret: GOOGLE_DESKTOP_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });

    const tokens = await tokenResponse.json();

    if (!tokenResponse.ok || !tokens.id_token) {
      console.warn('[auth] desktop code exchange failed:', tokens.error_description || tokens.error);
      return res.status(401).json({ error: 'Innlogging feilet. Prøv igjen.' });
    }

    idToken = tokens.id_token;
  } catch (error) {
    console.error('[auth] desktop token exchange error:', error.message);
    return res.status(502).json({ error: 'Fikk ikke kontakt med Google.' });
  }

  let payload;
  try {
    const ticket = await googleDesktopClient.verifyIdToken({
      idToken,
      audience: GOOGLE_DESKTOP_CLIENT_ID,
    });
    payload = ticket.getPayload();
  } catch (error) {
    console.warn('[auth] rejected desktop token:', error.message);
    return res.status(401).json({ error: 'Ugyldig Google-token.' });
  }

  const { status, body } = sessionFromGooglePayload(payload);
  return res.status(status).json(body);
});
/**
 * Send the final email with the download link
 */
app.post('/send-email', requireSession, async (req, res) => {
  const { emailTo, message, downloadUrl, fileName, requireReceipt, expiryDays, hasPassword } = req.body;
  // The sender is whoever is signed in — not whatever the client claims.
  const emailFrom = req.session.email;

  // UPDATED: Bulletproof splitting for multiple emails (handles spaces, commas, and semicolons)
  const recipientList = emailTo
    .split(/[,;\s]+/)
    .map(email => email.trim())
    .filter(email => email.includes('@'));

  // Remembered for next time. Not awaited — the sender shouldn't wait on it,
  // and a failure here mustn't stop the email going out.
  rememberContacts(req.session?.sub, recipientList);

  // Receipts used to be a /track-download link that emailed the sender and then
  // redirected. That fired the moment the recipient clicked, which since the
  // landing page landed means "opened the page", not "took the file" — the
  // sender was told something untrue. Now each recipient gets a token, the
  // token is stored on the link record, and the receipt is sent from the
  // download itself. See markDownloaded further down.
  const shortId = String(downloadUrl || '').match(/\/s\/([^/?#]+)/)?.[1] || null;
  const tokens = new Map(); // recipient -> token

  if (requireReceipt && shortId) {
    for (const recipient of recipientList) tokens.set(recipient, nanoid(10));

    try {
      const key = `short-urls/${shortId}.json`;
      const record = await readJson(key);

      if (record) {
        record.notify = {
          sender: emailFrom,
          // Merged rather than replaced: the same link can be sent onward to
          // more people later, and the earlier tokens are already in inboxes.
          recipients: {
            ...(record.notify?.recipients || {}),
            ...Object.fromEntries([...tokens].map(([email, token]) => [token, email])),
          },
        };
        await writeJson(key, record);
      }
    } catch (error) {
      // A receipt is worth less than the file arriving. Send anyway.
      console.warn(`[receipts] could not attach to ${shortId}:`, error.name);
      tokens.clear();
    }
  }

  try {
    // Loop through each recipient to give them a personalized email
    const emailPromises = recipientList.map(recipientEmail => {
      const token = tokens.get(recipientEmail);
      const suffix = token ? `?r=${encodeURIComponent(token)}` : '';

return sendMail({
        from: `Drop Involve <${emailFrom}>`,
        to: recipientEmail,
        replyTo: emailFrom,
        subject: `Fil delt med deg: ${fileName}`,
        html: fileSharedEmail({
          emailFrom,
          fileName,
          message,
          link: `${downloadUrl}${suffix}`,
          directLink: `${downloadUrl}/d${suffix}`,
          expiryDays: Number(expiryDays) || 7,
          hasPassword: Boolean(hasPassword),
        }),
      });
    });

    // Wait for all individual emails to finish sending
    await Promise.all(emailPromises);

    res.status(200).json({ success: true });
  } catch (error) {
    console.error("Feil ved sending av e-post:", error);
    res.status(500).json({ error: 'Kunne ikke sende e-post' });
  }
});

/**
 * Retired. Kept only for emails already sitting in inboxes.
 *
 * This used to email the sender a "downloaded" receipt and then redirect. It
 * fired on the click, which since the landing page arrived means the recipient
 * had merely opened a page — so senders were told files had been collected when
 * they hadn't. Receipts now come from markDownloaded, at the actual download.
 *
 * It stays as a plain redirect so old links keep working, but it no longer
 * sends anything. Old links carry no recipient token, so a download through one
 * still counts; the receipt just won't name who.
 *
 * Safe to delete once every link sent before 1 September 2026 has expired —
 * links last at most 7 days.
 */
app.get('/track-download', (req, res) => {
  const { fileUrl } = req.query;

  // Only ever redirect to our own short links: this takes a URL from the query
  // string, and without the check it would forward anyone anywhere.
  if (!fileUrl || !/^https:\/\/file\.involve\.no\/s\//.test(String(fileUrl))) {
    return res.status(400).type('html').send(
      errorPage({
        title: 'Ugyldig lenke',
        message: 'Lenken mangler informasjon. Be avsenderen om å dele den på nytt.',
      })
    );
  }

  res.redirect(302, String(fileUrl));
});

// --- Landing-page slides --------------------------------------------------

const MEDIA_PREFIX = 'slides/media/';
const MEDIA_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/**
 * Magic bytes, because Content-Type is whatever the uploader claims. These
 * files are served back to browsers, so an SVG or an HTML file mislabelled as
 * an image would be stored XSS on our own domain. Only real raster images pass.
 */
const sniffImage = (buffer) => {
  if (buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP') {
    return 'image/webp';
  }
  return null;
};

/**
 * Serves a slide image.
 *
 * Public and unauthenticated by design — recipients outside Involve have to be
 * able to see them. Keys are random, so this isn't a directory anyone can walk.
 */
app.get('/slides/media/:name', async (req, res) => {
  const name = String(req.params.name);

  // Keys are generated by us; anything else is someone probing.
  if (!/^[A-Za-z0-9_-]{6,64}\.(jpg|png|webp)$/.test(name)) {
    return res.status(404).end();
  }

  try {
    const object = await s3Client.send(
      new GetObjectCommand({ Bucket: DATA_BUCKET, Key: `${MEDIA_PREFIX}${name}` })
    );

    res.set({
      'Content-Type': object.ContentType || 'application/octet-stream',
      // Names are unique per upload, so these never need revalidating.
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'",
    });

    object.Body.pipe(res);
  } catch {
    res.status(404).end();
  }
});

/**
 * Preview one slide as a recipient would see it.
 *
 * Opened in a new tab from the editor, so it can't send an Authorization
 * header and isn't behind the session. That's a deliberate trade: slide content
 * is marketing material that becomes public the moment it's switched on, and
 * the alternative — a signed preview token — is machinery for no real gain.
 * Nothing about a file or a recipient appears here; the details are invented.
 */
app.get('/slides/preview/:id', async (req, res) => {
  const slides = await slideStore.load();
  const slide = slides.find((item) => item.id === req.params.id);

  if (!slide) {
    return res.status(404).type('html').send(
      errorPage({
        title: 'Fant ikke siden',
        message: 'Den er kanskje slettet. Lukk fanen og prøv igjen.',
      })
    );
  }

  res.type('html').send(
    renderWithSlide(
      (active) =>
        landingPage({
          shortId: 'forhandsvisning',
          fileName: 'Eksempelfil_Korr02.pdf',
          fileSize: 24_500_000,
          senderEmail: 'navn@involve.no',
          message: 'Slik ser en melding fra avsenderen ut på denne siden.',
          expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
          slide: active,
        }),
      slide
    )
  );
});

/** The current list, including slides that are switched off. */
app.get('/admin/slides', requireSession, async (req, res) => {
  try {
    const slides = await slideStore.load({ force: true });
    // The editor sends this back when saving, so a save built on a stale copy
    // can be refused rather than quietly overwriting someone else's work.
    res.json({ slides, revision: slideStore.revisionOf(slides) });
  } catch (error) {
    console.error('[slides] read failed:', error);
    res.status(500).json({ error: 'Kunne ikke hente innholdet.' });
  }
});

/**
 * Replaces the whole list.
 *
 * Whole-list rather than per-slide: the editor holds all of them anyway, and
 * one write means no half-applied reorder. With two or three editors a
 * simultaneous save would mean last-one-wins, which for a handful of monthly
 * edits is a fair trade against the complexity of merging.
 */
app.put('/admin/slides', requireSession, async (req, res) => {
  const { slides, revision } = req.body || {};

  if (!Array.isArray(slides)) {
    return res.status(400).json({ error: 'Forventet en liste med sider.' });
  }

  try {
    const saved = await slideStore.save(slides, req.session.email, revision);
    console.log(`[slides] ${req.session.email} saved ${saved.length} slide(s)`);
    res.json({ slides: saved, revision: slideStore.revisionOf(saved) });
  } catch (error) {
    // 409 rather than 500: nothing is broken, the copy being saved is just out
    // of date. The editor turns this into "reload and try again".
    if (error.conflict) {
      console.log(`[slides] ${req.session.email} tried to save a stale list`);
      return res.status(409).json({
        error: 'Noen andre har endret innholdet mens du redigerte. Last inn på nytt og prøv igjen.',
      });
    }

    console.error('[slides] save failed:', error);
    res.status(500).json({ error: 'Kunne ikke lagre innholdet.' });
  }
});

/**
 * Image upload.
 *
 * Posted through the API rather than straight to R2 on a presigned URL: the
 * admin resizes and crops in the browser first, so these arrive a few hundred
 * kilobytes, and going through here avoids configuring CORS on a second bucket
 * — one less piece of console state to get wrong later.
 */
app.post(
  '/admin/slides/media',
  requireSession,
  express.raw({ type: Object.keys(MEDIA_TYPES), limit: '6mb' }),
  async (req, res) => {
    const buffer = req.body;

    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      return res.status(400).json({ error: 'Ingen bildedata mottatt.' });
    }

    const actualType = sniffImage(buffer);
    if (!actualType) {
      return res.status(400).json({ error: 'Filen er ikke et gyldig bilde (JPG, PNG eller WebP).' });
    }

    const name = `${nanoid(16)}.${MEDIA_TYPES[actualType]}`;

    try {
      await s3Client.send(
        new PutObjectCommand({
          Bucket: DATA_BUCKET,
          Key: `${MEDIA_PREFIX}${name}`,
          Body: buffer,
          ContentType: actualType,
        })
      );

      console.log(`[slides] ${req.session.email} uploaded ${name} (${buffer.length} bytes)`);
      res.json({ url: `https://file.involve.no/slides/media/${name}`, name });
    } catch (error) {
      console.error('[slides] upload failed:', error);
      res.status(500).json({ error: 'Kunne ikke laste opp bildet.' });
    }
  }
);

/**
 * Redirect short URLs to the long presigned S3 URLs
 */
/** Reads a short-link record from R2. Returns null if it's gone. */
// --- Counting a download --------------------------------------------------
//
// Two things get this wrong if you count every request to /d.
//
// Mail security (Outlook Safe Links, Proofpoint, Mimecast and friends) fetches
// every URL in an email to check it before the human ever sees it. Chat apps do
// the same to build link previews. Those hits are indistinguishable from a
// person at the HTTP level in the general case, but most identify themselves in
// the user agent, and none of them are triggered by a click.
//
// Browsers also prefetch links they think you're about to follow, and announce
// it in Sec-Purpose.
//
// This is a heuristic and it will never be exact. It is much closer than
// counting everything.
const AUTOMATED_AGENTS =
  /bot|crawl|spider|slurp|preview|scan|fetch|monitor|curl|wget|python-requests|okhttp|go-http|java\/|headless|phantom|proofpoint|mimecast|barracuda|symantec|messagelabs|forcepoint|safelinks|skypeuripreview|slackbot|whatsapp|telegram|discord|facebookexternalhit|twitterbot|linkedinbot/i;

const looksAutomated = (req) => {
  if (req.method === 'HEAD') return true;

  const purpose = `${req.get('sec-purpose') || ''} ${req.get('purpose') || ''} ${req.get('x-purpose') || ''}`;
  if (/prefetch|preview/i.test(purpose)) return true;

  const agent = req.get('user-agent') || '';
  if (!agent) return true; // a browser always sends one
  return AUTOMATED_AGENTS.test(agent);
};

// A single click can produce more than one request — a retry, a reload, the
// browser re-issuing after a redirect. Collapse anything from the same
// recipient on the same link inside this window into one download.
const DOWNLOAD_DEDUPE_MS = 10 * 60 * 1000;
const recentDownloads = new Map(); // key -> timestamp

const alreadyCounted = (shortId, who) => {
  const key = `${shortId}:${who}`;
  const now = Date.now();

  for (const [existing, at] of recentDownloads) {
    if (now - at > DOWNLOAD_DEDUPE_MS) recentDownloads.delete(existing);
  }

  if (recentDownloads.has(key)) return true;
  recentDownloads.set(key, now);
  return false;
};

/**
 * Records the download and, if the sender asked for a receipt, tells them.
 *
 * Always called after the redirect has gone out, so none of it delays the
 * recipient and a failure here can't break a download.
 */
const markDownloaded = async (req, record, shortId) => {
  if (looksAutomated(req)) {
    console.log(`[downloads] ignored automated hit on ${shortId}`);
    return;
  }

  const token = typeof req.query.r === 'string' ? req.query.r : null;
  const who = token || req.get('cf-connecting-ip') || req.ip || 'unknown';
  if (alreadyCounted(shortId, who)) return;

  await recordDownload(record.owner, shortId);

  const notify = record.notify;
  if (!notify?.sender) return;

  try {
    await sendMail({
      from: process.env.MAIL_FROM || 'Drop Involve <filer@involve.no>',
      to: notify.sender,
      subject: `Nedlastingsbekreftelse: ${record.fileName || 'fil'}`,
      html: downloadReceiptEmail({
        fileName: record.fileName || 'fil',
        // Named only when we know which recipient this token was issued to.
        downloader: token ? notify.recipients?.[token] || null : null,
      }),
    });
  } catch (error) {
    console.error('Kunne ikke sende kvittering:', error);
  }
};

const readShortLink = async (shortId) => {
  const record = await readJson(`short-urls/${shortId}.json`);
  if (!record) console.warn(`Short link ${shortId} unavailable`);
  return record;
};

/**
 * The landing page a recipient sees.
 *
 * This used to redirect straight to the file. Showing a branded page first
 * means they can see what they're getting and who from before committing —
 * and it's the only surface where external clients see Involve at all.
 *
 * Nothing is stored per link: the page is rendered from the record in R2.
 */
app.get('/s/:shortId', async (req, res) => {
  const { shortId } = req.params;
  const record = await readShortLink(shortId);

  if (!record) {
    return res.status(404).type('html').send(expiredPage());
  }

  // Viewing the page is not downloading — the count happens on /d below, or
  // when a password is accepted. Otherwise opening the link twice out of
  // curiosity would read as two downloads.
  res.type('html').send(
    renderWithSlide(
      (slide) =>
        landingPage({
          shortId,
          fileName: record.fileName,
          fileSize: record.fileSize,
          senderEmail: record.senderEmail,
          message: record.message,
          expiresAt: record.expiresAt,
          hasPassword: Boolean(record.passwordHash),
          token: typeof req.query.r === 'string' ? req.query.r : null,
          slide,
        }),
      pickSlide(await slideStore.load())
    )
  );
});

/**
 * The direct download, and what the small link in the email points at.
 * Deliberately refuses to serve protected links — otherwise the direct link
 * would be a way around the password.
 */
app.get('/s/:shortId/d', async (req, res) => {
  const { shortId } = req.params;
  const record = await readShortLink(shortId);

  if (!record) {
    return res.status(404).type('html').send(expiredPage());
  }

  if (record.passwordHash) {
    return res.redirect(302, `/s/${encodeURIComponent(shortId)}`);
  }

  res.redirect(302, record.longUrl);
  // After the redirect, so counting never delays the recipient.
  markDownloaded(req, record, shortId);
});

/** Password submitted from the landing page. */
app.post('/s/:shortId', async (req, res) => {
  const { shortId } = req.params;
  const { password } = req.body || {};

  const record = await readShortLink(shortId);
  if (!record) {
    return res.status(404).type('html').send(expiredPage());
  }

  // Loaded once rather than per render: this handler can render the page
  // several times over a wrong password, and re-picking each time would flip
  // the showcase around while someone is typing.
  const slides = await slideStore.load();

  const page = (error, status) =>
    res.status(status).type('html').send(
      renderWithSlide(
        (slide) =>
          landingPage({
            shortId,
            fileName: record.fileName,
            fileSize: record.fileSize,
            senderEmail: record.senderEmail,
            message: record.message,
            expiresAt: record.expiresAt,
            hasPassword: true,
            error,
            token: typeof req.query.r === 'string' ? req.query.r : null,
            slide,
          }),
        pickSlide(slides)
      )
    );

  if (!record.passwordHash) {
    res.redirect(302, record.longUrl);
    markDownloaded(req, record, shortId);
    return;
  }

  if (tooManyAttempts(shortId)) {
    return page('For mange forsøk. Vent litt og prøv igjen.', 429);
  }

  const ok = password && (await verifyPassword(String(password), record.passwordHash));

  if (!ok) {
    return page('Feil passord.', 401);
  }

  res.redirect(302, record.longUrl);
  markDownloaded(req, record, shortId);
});


/**
 * Nothing matched.
 *
 * nginx used to answer unknown paths itself, from a hand-written list of every
 * route. That list was a recurring source of confusion — a new endpoint 404s
 * until someone remembers to add a line — and it was never a security boundary,
 * since every route that needs a session checks for one itself. nginx now
 * forwards everything, so this is what a stray URL gets: a branded page rather
 * than Express's "Cannot GET /whatever", which announces the framework.
 */
app.use((req, res) => {
  if (req.accepts('html')) {
    return res.status(404).type('html').send(
      errorPage({
        title: 'Siden finnes ikke',
        message: 'Sjekk lenken, eller be avsenderen om å dele den på nytt.',
      })
    );
  }
  res.status(404).json({ error: 'Not found' });
});

// Catch-all error handler. Without this, a rejected origin surfaces as an
// Express stack trace — unhelpful to the user and more than we want to reveal.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(`[error] ${req.method} ${req.path}:`, err.message);

  if (res.headersSent) return;

  const wantsHtml = (req.get('accept') || '').includes('text/html');

  if (wantsHtml) {
    return res.status(500).type('html').send(
      errorPage({
        title: 'Noe gikk galt',
        message: 'Prøv igjen, eller kontakt avsenderen hvis problemet vedvarer.',
      })
    );
  }

  return res.status(500).json({ error: 'Uventet feil.' });
});

// Start the server (always goes at the bottom)
app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);

  // Check the mail transport now rather than discovering a bad password the
  // first time somebody asks for a code.
  const mail = await verifyTransport();
  console.log(
    mail.ok
      ? `[mail] transport ready (${mail.detail})`
      : `[mail] TRANSPORT FAILED (${backend}): ${mail.detail}`
  );
});