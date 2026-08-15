const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const dotenv = require('dotenv');
const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
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


// --- Verification codes ---------------------------------------------------
// email -> { code, expiresAt, attempts }
// Still in memory, so a restart clears pending codes. Acceptable because codes
// are short-lived anyway; sessions below are deliberately stateless so an
// in-flight transfer survives a restart.
const verificationCodes = new Map();
const codeRequests = new Map(); // email -> [timestamps]

const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const CODE_REQUEST_WINDOW_MS = 60 * 60 * 1000;
const CODE_REQUEST_MAX = 5;
const CODE_REQUEST_MIN_GAP_MS = 30 * 1000;

// --- Sessions -------------------------------------------------------------
// An HMAC-signed token proving the holder completed the email-code check.
// Stateless on purpose: nothing to store, and it keeps working across restarts
// and across both hosts running this code.
// Email-code sessions are short: the code proves someone read one message.
// Google sessions can be long, because Google enforces its own session policy
// underneath and an account can be disabled centrally.
const SESSION_TTL_MS = 30 * 60 * 1000;
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

// Until this is switched on, unauthenticated requests are allowed through and
// logged. That gives already-installed clients time to update before the rule
// starts being enforced.
const ENFORCE_UPLOAD_AUTH = process.env.ENFORCE_UPLOAD_AUTH === 'true';

const sign = (payload) =>
  crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');

/**
 * @param {object} claims  e.g. { email, sub, name, method }
 * @param {number} ttlMs   how long the session should last
 */
function issueSessionToken(claims, ttlMs = SESSION_TTL_MS) {
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

  if (!ENFORCE_UPLOAD_AUTH) {
    console.warn(`[auth] unauthenticated ${req.method} ${req.path} allowed (grace period)`);
    return next();
  }

  return res.status(401).json({ error: 'Verifisering kreves. Be om en ny kode.' });
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
      ContentDisposition: `attachment; filename="${encodeURIComponent(fileName)}"`
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

    res.json({ downloadUrl: shortUrl, protected: Boolean(password) });
  } catch (error) {
    console.error('Error generating download URL:', error);
    res.status(500).json({ error: 'Failed to generate download URL' });
  }
};

app.get('/generate-download-url', requireSession, generateDownloadUrl);
app.post('/generate-download-url', requireSession, generateDownloadUrl);
/**
 * Request OTP Code
 */
app.post('/request-code', async (req, res) => {
  const { emailFrom } = req.body;

  if (typeof emailFrom !== 'string' || !emailFrom.toLowerCase().endsWith('@involve.no')) {
    return res.status(403).json({ error: 'Kun @involve.no-adresser kan sende filer.' });
  }

  const email = emailFrom.toLowerCase();
  const now = Date.now();

  // Rate limit. Without this anyone can send unlimited mail to any involve.no
  // address through our Resend account.
  const history = (codeRequests.get(email) || []).filter(t => now - t < CODE_REQUEST_WINDOW_MS);

  if (history.length >= CODE_REQUEST_MAX) {
    return res.status(429).json({ error: 'For mange forespørsler. Prøv igjen om en time.' });
  }
  if (history.length && now - history[history.length - 1] < CODE_REQUEST_MIN_GAP_MS) {
    return res.status(429).json({ error: 'Vent litt før du ber om en ny kode.' });
  }

  history.push(now);
  codeRequests.set(email, history);

  // crypto.randomInt, not Math.random — this is a credential.
  const code = crypto.randomInt(100000, 1000000).toString();
  verificationCodes.set(email, { code, expiresAt: now + OTP_TTL_MS, attempts: 0 });

  try {
    // Resend resolves with { data, error } instead of throwing on API errors,
    // so the error field has to be checked explicitly. Without this the server
    // reports success for mail that was never accepted.
    const { error: sendError } = await sendMail({
      from: process.env.MAIL_FROM || 'Drop Involve <filer@involve.no>',
      to: email,
      subject: 'Din verifiseringskode for Drop Involve',
      html: `
        <div style="font-family: sans-serif; padding: 20px;">
          <h2>Din verifiseringskode</h2>
          <p>Bruk koden under for å bekrefte overføringen din:</p>
          <h1 style="letter-spacing: 5px; color: #162022; background: #F5FF8C; padding: 10px; display: inline-block; border-radius: 8px;">${code}</h1>
        </div>
      `
    });

    if (sendError) {
      console.error('[resend] request-code failed:', sendError);
      verificationCodes.delete(email);
      return res.status(502).json({ error: 'Kunne ikke sende kode. Prøv igjen.' });
    }

    res.status(200).json({ success: true });
  } catch (error) {
    console.error(error);
    verificationCodes.delete(email);
    res.status(500).json({ error: 'Kunne ikke sende kode.' });
  }
});
/**
 * Verify OTP Code before upload
 */
app.post('/verify-code', (req, res) => {
  const { emailFrom, otp } = req.body;

  if (typeof emailFrom !== 'string' || typeof otp !== 'string') {
    return res.status(400).json({ error: 'Mangler e-post eller kode.' });
  }

  const email = emailFrom.toLowerCase();
  const entry = verificationCodes.get(email);

  if (!entry || entry.expiresAt < Date.now()) {
    verificationCodes.delete(email);
    return res.status(401).json({ error: 'Koden er utløpt. Be om en ny.' });
  }

  if (entry.attempts >= OTP_MAX_ATTEMPTS) {
    verificationCodes.delete(email);
    return res.status(429).json({ error: 'For mange forsøk. Be om en ny kode.' });
  }

  // Constant-time compare so the response time can't leak the code.
  const provided = Buffer.from(otp);
  const expected = Buffer.from(entry.code);
  const matches =
    provided.length === expected.length && crypto.timingSafeEqual(provided, expected);

  if (!matches) {
    entry.attempts += 1;
    return res.status(401).json({ error: 'Ugyldig eller feil kode.' });
  }

  // Mark verified rather than deleting outright. Clients released before
  // session tokens existed re-send the code to /send-email, so the entry has to
  // survive until it expires. Once ENFORCE_UPLOAD_AUTH is on, only the token
  // below is accepted and this entry stops mattering.
  entry.verified = true;

  return res.status(200).json({
    success: true,
    token: issueSessionToken({ email, method: 'code' }),
    expiresIn: SESSION_TTL_MS / 1000,
  });
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
  const { emailTo, emailFrom, message, downloadUrl, fileName, otp, requireReceipt } = req.body;
  // --- ADD THIS NEW TRACKING LINK ---
  const trackingLink = `https://file.involve.no/track-download?fileUrl=${encodeURIComponent(downloadUrl)}&senderEmail=${encodeURIComponent(emailFrom)}&fileName=${encodeURIComponent(fileName)}`;
  // ----------------------------------

  // A valid session token is proof enough. Older clients don't have one yet, so
  // fall back to the verified code they still send.
  if (!req.session) {
    const entry = verificationCodes.get(String(emailFrom).toLowerCase());
    const stillValid = entry && entry.verified && entry.expiresAt > Date.now() && entry.code === otp;

    if (!stillValid) {
      return res.status(401).json({ error: 'Ugyldig eller utløpt verifiseringskode.' });
    }
  }

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