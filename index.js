const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { nanoid } = require('nanoid');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
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

/**
 * Generate a Presigned URL for uploading a file (PUT)
 */
app.post('/generate-upload-url', async (req, res) => {
  try {
    const { fileName, contentType } = req.body;

    if (!fileName || !contentType) {
      return res.status(400).json({ error: 'fileName and contentType are required' });
    }

    // Create a unique key for the object
    const fileExtension = fileName.split('.').pop();
    const objectKey = `${nanoid()}.${fileExtension}`;

    const command = new PutObjectCommand({
      Bucket: "get-involve",
      Key: objectKey, // FIXED: Using the objectKey generated above
      ContentType: contentType, // FIXED: Matching the frontend data
      ContentDisposition: `attachment; filename="${fileName}"`
    });

    const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });

    res.json({
      uploadUrl: uploadUrl, // FIXED: Changed from 'url'
      objectKey: objectKey,
    });
  } catch (error) {
    console.error('Error generating upload URL:', error);
    res.status(500).json({ error: 'Failed to generate upload URL' });
  }
});

/**
 * Generate a Presigned URL for downloading a file (GET)
 * Expects { objectKey } in query
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

    // Default to 1 hour, or use provided expiresIn (capped at 7 days for S3 compatibility)
    let expirySeconds = parseInt(expiresIn) || 3600;
    const MAX_EXPIRY = 7 * 24 * 60 * 60; // 7 days
    if (expirySeconds > MAX_EXPIRY) {
      expirySeconds = MAX_EXPIRY;
    }

    const url = await getSignedUrl(s3Client, command, { expiresIn: expirySeconds });

    res.json({ downloadUrl: url });
  } catch (error) {
    console.error('Error generating download URL:', error);
    res.status(500).json({ error: 'Failed to generate download URL' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

// New endpoint for sending emails
app.post('/send-email', async (req, res) => {
  const { emailTo, emailFrom, message, downloadUrl, fileName } = req.body;

  try {
    const data = await resend.emails.send({
      // IMPORTANT: This 'from' must be an email on your verified domain
      from: 'Drop Involve <filer@involve.no>',
      to: [emailTo],
      reply_to: emailFrom, // This makes it look like it's "from" the user
      subject: `Fil delt med deg: ${fileName}`,
      html: `
        <div style="font-family: sans-serif; line-height: 1.5;">
          <h2>Du har mottatt en fil</h2>
          <p><strong>Fra:</strong> ${emailFrom}</p>
          <p><strong>Melding:</strong> ${message || 'Ingen melding vedlagt.'}</p>
          <hr />
          <p><a href="${downloadUrl}" style="background: #f4fe8b; color: black; padding: 10px 20px; border-radius: 5px; text-decoration: none; font-weight: bold;">Last ned filen her</a></p>
          <p style="font-size: 12px; color: #666;">Filen er tilgjengelig via Drop Involve.</p>
        </div>
      `,
    });

    res.status(200).json(data);
  } catch (error) {
    console.error('Email error:', error);
    res.status(500).json({ error: 'Kunne ikke sende e-post' });
  }
});