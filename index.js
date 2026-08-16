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
const { expiredPage, passwordPage, errorPage } = require('./pages');

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
  try {
    const response = await s3Client.send(
      new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: historyKey(sub) })
    );
    const parsed = JSON.parse(await response.Body.transformToString());
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return []; // no history yet
  }
};

const writeHistory = async (sub, entries) => {
  await s3Client.send(
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: historyKey(sub),
      Body: JSON.stringify(entries.slice(0, HISTORY_LIMIT)),
      ContentType: 'application/json',
    })
  );
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

const sign = (payload) =>
  crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');

/**
 * @param {object} claims  e.g. { email, sub, name, method }
 * @param {number} ttlMs   how long the session should last
 */
function issueSessionToken(claims, ttlMs) {
  const payload = Buffer.from(
    JSON.stringify({ ...claims, exp: Date.now() + ttlMs })
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

function requireSession(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const session = token ? verifySessionToken(token) : null;

  if (session) {
    req.session = session;
    return next();
  }

  return res.status(401).json({ error: 'Du må logge inn på nytt.' });
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
      Bucket: process.env.R2_BUCKET_NAME,
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
    const { objectKey, expiresIn, password, fileName } = source || {};

    if (!objectKey) {
      return res.status(400).json({ error: 'objectKey is required' });
    }

    const command = new GetObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
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
    const record = { longUrl };

    if (password) {
      if (String(password).length < MIN_LINK_PASSWORD_LENGTH) {
        return res.status(400).json({
          error: `Passordet må ha minst ${MIN_LINK_PASSWORD_LENGTH} tegn.`,
        });
      }
      record.passwordHash = await hashPassword(String(password));
      // Shown on the prompt so the recipient knows what they're unlocking.
      if (fileName) record.fileName = String(fileName).slice(0, 200);
    }

    const putCommand = new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: `short-urls/${shortId}.json`,
      Body: JSON.stringify(record),
      ContentType: 'application/json'
    });
    await s3Client.send(putCommand);

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
        Bucket: process.env.R2_BUCKET_NAME,
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
            Bucket: process.env.R2_BUCKET_NAME,
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
        Bucket: process.env.R2_BUCKET_NAME,
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
        Bucket: process.env.R2_BUCKET_NAME,
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
    const remove = async (Key) => {
      try {
        await s3Client.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key }));
      } catch (error) {
        console.warn(`[revoke] could not delete ${Key}:`, error.name);
      }
    };

    await remove(`short-urls/${shortId}.json`);
    if (entry.objectKey) await remove(entry.objectKey);

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
  const { emailTo, message, downloadUrl, fileName, requireReceipt } = req.body;
  // The sender is whoever is signed in — not whatever the client claims.
  const emailFrom = req.session.email;
  // --- ADD THIS NEW TRACKING LINK ---
  const trackingLink = `https://file.involve.no/track-download?fileUrl=${encodeURIComponent(downloadUrl)}&senderEmail=${encodeURIComponent(emailFrom)}&fileName=${encodeURIComponent(fileName)}`;
  // ----------------------------------

  // UPDATED: Bulletproof splitting for multiple emails (handles spaces, commas, and semicolons)
  const recipientList = emailTo
    .split(/[,;\s]+/)
    .map(email => email.trim())
    .filter(email => email.includes('@'));

  try {
    // Loop through each recipient to give them a personalized email
    const emailPromises = recipientList.map(recipientEmail => {

      // Determine which link to give them based on the checkbox
      const finalLink = requireReceipt
        ? `https://file.involve.no/track-download?fileUrl=${encodeURIComponent(downloadUrl)}&senderEmail=${encodeURIComponent(emailFrom)}&fileName=${encodeURIComponent(fileName)}&downloader=${encodeURIComponent(recipientEmail)}`
        : downloadUrl;

return sendMail({
        from: `DROP.INVOLVE.NO <${emailFrom}>`,
        to: recipientEmail,
        replyTo: emailFrom,
        subject: `Fil delt med deg: ${fileName}`,
        html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f4f4f5; padding: 40px 20px; color: #171717;">
          <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.05);">
            <div style="padding: 40px; text-align: center;">
              <h1 style="font-size: 24px; font-weight: 600; margin: 0 0 8px 0; color: #171717;">Drop.Involve</h1>
              <p style="color: #737373; font-size: 14px; margin: 0 0 32px 0;">En fil har blitt delt med deg</p>

              <div style="background-color: #fafafa; border-radius: 8px; padding: 24px; text-align: left; margin-bottom: 32px; border: 1px solid #e5e5e5;">
                <p style="margin: 0 0 12px 0; font-size: 14px;"><strong style="color: #171717;">Fra:</strong> <span style="color: #525252;">${emailFrom}</span></p>
                <p style="margin: 0 0 12px 0; font-size: 14px;"><strong style="color: #171717;">Filnavn:</strong> <span style="color: #525252;">${fileName}</span></p>
                <p style="margin: 0; font-size: 14px; line-height: 1.6;"><strong style="color: #171717;">Melding:</strong><br/><span style="color: #525252;">${message || 'Ingen melding vedlagt.'}</span></p>
              </div>

              <a href="${finalLink}" style="display: inline-block; background-color: #171717; color: #ffffff; padding: 14px 32px; border-radius: 6px; text-decoration: none; font-weight: 500; font-size: 16px;">
                Last ned fil
              </a>
              
              <p style="color: #a3a3a3; font-size: 12px; margin-top: 32px; margin-bottom: 0;">Filen slettes automatisk etter 7 dager.</p>
            </div>
          </div>
        </div>
        `,
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
 * Track Download & Redirect
 */
app.get('/track-download', async (req, res) => {
  const { fileUrl, senderEmail, fileName } = req.query;

  if (!fileUrl || !senderEmail) {
    return res.status(400).type('html').send(
      errorPage({
        title: 'Ugyldig lenke',
        message: 'Lenken mangler informasjon. Be avsenderen om å dele den på nytt.',
      })
    );
  }

  // 1. Instantly redirect the user to the actual Cloudflare file so they don't wait
  res.redirect(fileUrl);

  // 2. Send the receipt email to the sender in the background
  try {
    await sendMail({
      from: process.env.MAIL_FROM || 'Drop Involve <filer@involve.no>',
      to: senderEmail,
      subject: `Nedlastingsbekreftelse: ${fileName}`,
      html: `
        <div style="font-family: sans-serif; padding: 20px; color: #333;">
          <h2 style="color: #c4d600;">Suksess! 🎉</h2>
          <p>Mottakeren har akkurat lastet ned filen din:</p>
          <p><b>${fileName}</b></p>
          <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;" />
          <p style="font-size: 12px; color: #888;">Drop Involve - Sikre filoverføringer</p>
        </div>
      `
    });
  } catch (err) {
    console.error("Kunne ikke sende kvittering:", err);
  }
});

/**
 * Redirect short URLs to the long presigned S3 URLs
 */
/** Reads a short-link record from R2. Returns null if it's gone. */
const readShortLink = async (shortId) => {
  try {
    const response = await s3Client.send(
      new GetObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: `short-urls/${shortId}.json`,
      })
    );
    return JSON.parse(await response.Body.transformToString());
  } catch (error) {
    console.error(`Short link ${shortId} unavailable:`, error.name);
    return null;
  }
};

app.get('/s/:shortId', async (req, res) => {
  const { shortId } = req.params;
  const record = await readShortLink(shortId);

  if (!record) {
    return res.status(404).type('html').send(expiredPage());
  }

  // Protected links show a prompt instead of redirecting. The presigned URL
  // is never sent to the browser until the password checks out.
  if (record.passwordHash) {
    return res.type('html').send(
      passwordPage({ shortId, fileName: record.fileName })
    );
  }

  return res.redirect(302, record.longUrl);
});

app.post('/s/:shortId', async (req, res) => {
  const { shortId } = req.params;
  const { password } = req.body || {};

  const record = await readShortLink(shortId);
  if (!record) {
    return res.status(404).type('html').send(expiredPage());
  }

  if (!record.passwordHash) {
    return res.redirect(302, record.longUrl);
  }

  if (tooManyAttempts(shortId)) {
    return res.status(429).type('html').send(
      passwordPage({
        shortId,
        fileName: record.fileName,
        error: 'For mange forsøk. Vent litt og prøv igjen.',
      })
    );
  }

  const ok = password && (await verifyPassword(String(password), record.passwordHash));

  if (!ok) {
    return res.status(401).type('html').send(
      passwordPage({
        shortId,
        fileName: record.fileName,
        error: 'Feil passord.',
      })
    );
  }

  return res.redirect(302, record.longUrl);
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