const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const dotenv = require('dotenv');
const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { nanoid } = require('nanoid');
const { sendMail, verifyTransport, backend } = require('./mailer');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

const allowedOrigins = [
  'http://localhost:5173',     // Dev environment
  'http://tauri.localhost',    // Windows compiled .exe
  'tauri://localhost',         // Mac compiled .app
  'https://drop.involve.no'    // Live web version
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
const SESSION_TTL_MS = 30 * 60 * 1000;

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

function issueSessionToken(email) {
  const payload = Buffer.from(
    JSON.stringify({ email, exp: Date.now() + SESSION_TTL_MS })
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
 * Generate a Presigned URL for downloading a file (GET) and shorten it
 */
app.get('/generate-download-url', requireSession, async (req, res) => {
  try {
    const { objectKey, expiresIn } = req.query;

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

    // 3. Save the link mapping as a small JSON file directly into Cloudflare R2
    const uploadData = JSON.stringify({ longUrl });
    const putCommand = new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: `short-urls/${shortId}.json`,
      Body: uploadData,
      ContentType: 'application/json'
    });
    await s3Client.send(putCommand);

    // 4. Return the shortened domain URL back to the client
    const shortUrl = `https://file.involve.no/s/${shortId}`;

    res.json({ downloadUrl: shortUrl });
  } catch (error) {
    console.error('Error generating download URL:', error);
    res.status(500).json({ error: 'Failed to generate download URL' });
  }
});
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
    token: issueSessionToken(email),
    expiresIn: SESSION_TTL_MS / 1000,
  });
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
    return res.status(400).send("Ugyldig lenke.");
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
app.get('/s/:shortId', async (req, res) => {
  const { shortId } = req.params;
  
  try {
    // 1. Fetch the JSON link mapping file from Cloudflare R2
    const command = new GetObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: `short-urls/${shortId}.json`,
    });

    const response = await s3Client.send(command);
    
    // 2. Read and parse the stream data into JSON
    const streamToString = await response.Body.transformToString();
    const { longUrl } = JSON.parse(streamToString);

    // 3. Instantly redirect the browser to the actual file location
    return res.redirect(302, longUrl);

  } catch (error) {
    // If the file isn't found or an error occurs, show the expired page
    console.error('Error fetching short URL from R2:', error);
    return res.status(404).send('<h1>Linken er utløpt eller finnes ikke</h1>');
  }
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