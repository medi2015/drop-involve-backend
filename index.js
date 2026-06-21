const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { nanoid } = require('nanoid');
const { Resend } = require('resend');

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
const s3Client = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const resend = new Resend(process.env.RESEND_API_KEY);

// Temporarily store verification codes in memory
const verificationCodes = new Map();

/**
 * Generate a Presigned URL for uploading a file (PUT)
 */
app.post('/generate-upload-url', async (req, res) => {
  try {
    const { fileName, contentType } = req.body;

    if (!fileName || !contentType) {
      return res.status(400).json({ error: 'fileName and contentType are required' });
    }

    const fileExtension = fileName.split('.').pop();
    const objectKey = `${nanoid()}.${fileExtension}`;

    const command = new PutObjectCommand({
      Bucket: "get-involve",
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
app.get('/generate-download-url', async (req, res) => {
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
    const shortUrl = `http://80.240.25.105:5000/s/${shortId}`;

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

  if (!emailFrom.toLowerCase().endsWith('@involve.no')) {
    return res.status(403).json({ error: 'Kun @involve.no-adresser kan sende filer.' });
  }

  const code = Math.floor(100000 + Math.random() * 900000).toString();
  verificationCodes.set(emailFrom, code);

  try {
    await resend.emails.send({
      from: 'Drop Involve <filer@involve.no>',
      to: [emailFrom],
      subject: 'Din verifiseringskode for Drop Involve',
      html: `
        <div style="font-family: sans-serif; padding: 20px;">
          <h2>Din verifiseringskode</h2>
          <p>Bruk koden under for å bekrefte overføringen din:</p>
          <h1 style="letter-spacing: 5px; color: #000; background: #f4fe8b; padding: 10px; display: inline-block; border-radius: 8px;">${code}</h1>
        </div>
      `
    });
    res.status(200).json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Kunne ikke sende kode.' });
  }
});
/**
 * Verify OTP Code before upload
 */
app.post('/verify-code', (req, res) => {
  const { emailFrom, otp } = req.body;
  if (verificationCodes.get(emailFrom) === otp) {
    return res.status(200).json({ success: true });
  }
  return res.status(401).json({ error: 'Ugyldig eller feil kode.' });
});
/**
 * Send the final email with the download link
 */
app.post('/send-email', async (req, res) => {
  const { emailTo, emailFrom, message, downloadUrl, fileName, otp, requireReceipt } = req.body;
  // --- ADD THIS NEW TRACKING LINK ---
  const trackingLink = `http://80.240.25.105:5000/track-download?fileUrl=${encodeURIComponent(downloadUrl)}&senderEmail=${encodeURIComponent(emailFrom)}&fileName=${encodeURIComponent(fileName)}`;
  // ----------------------------------
  // Verify the OTP code
  if (verificationCodes.get(emailFrom) !== otp) {
    return res.status(401).json({ error: 'Ugyldig eller utløpt verifiseringskode.' });
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
        ? `http://80.240.25.105:5000/track-download?fileUrl=${encodeURIComponent(downloadUrl)}&senderEmail=${encodeURIComponent(emailFrom)}&fileName=${encodeURIComponent(fileName)}&downloader=${encodeURIComponent(recipientEmail)}`
        : downloadUrl;

      return resend.emails.send({
        from: `Drop Involve <${emailFrom}>`,
        to: recipientEmail, // Sends individually to this specific person
        reply_to: emailFrom,
        subject: `Fil delt med deg: ${fileName}`,
        html: `
        <div style="font-family: system-ui, -apple-system, sans-serif; background-color: #111; padding: 40px 20px; color: #fff;">
          <div style="max-width: 600px; margin: 0 auto; background-color: #0a0a0a; border: 1px solid #333; border-radius: 16px; overflow: hidden;">
            <div style="padding: 40px; text-align: center;">
              
              <h1 style="color: #fff; font-size: 28px; margin-top: 0; margin-bottom: 8px; letter-spacing: -1px;">Drop.Involve.no</h1>
              <p style="color: #888; font-size: 14px; margin-top: 0; margin-bottom: 32px;">Sikre, raske og pålitelige filoverføringer</p>
              
              <div style="background-color: #1a1a1a; border-radius: 12px; padding: 24px; text-align: left; margin-bottom: 40px; border: 1px solid #222;">
                <p style="margin: 0 0 12px 0; color: #ccc;"><strong style="color: #fff;">Fra:</strong> ${emailFrom}</p>
                <p style="margin: 0; color: #ccc; line-height: 1.6;"><strong style="color: #fff;">Melding:</strong><br/>${message || 'Ingen melding vedlagt.'}</p>
              </div>

              <a href="${finalLink}" style="display: inline-block; background-color: #d9f949; color: #000; padding: 18px 40px; border-radius: 50px; text-decoration: none; font-weight: bold; font-size: 18px;">
                Last ned filen her
              </a>
              
              <p style="color: #555; font-size: 12px; margin-top: 40px; margin-bottom: 0;">Filen slettes automatisk etter 7 dager</p>
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
    await resend.emails.send({
      from: 'Drop Involve <filer@involve.no>',
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
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});