/**
 * Copies metadata out of the expiring file bucket into the data bucket.
 *
 * Why: the file bucket's 8-day lifecycle rule has a blank prefix, so it deletes
 * everything, not just uploaded files. Session revocation markers, history,
 * contacts and the email index were all being removed after 8 days.
 *
 * This copies rather than moves. The originals stay where they are and age out
 * on their own, and the server reads the data bucket first with a fallback to
 * the old one, so nothing breaks part-way through.
 *
 * Safe to run more than once — it overwrites with the same content.
 *
 *   node scripts/migrate-metadata.js          # show what would be copied
 *   node scripts/migrate-metadata.js --apply  # actually copy
 */
require('dotenv').config();

const {
  S3Client,
  ListObjectsV2Command,
  CopyObjectCommand,
} = require('@aws-sdk/client-s3');

const FILE_BUCKET = process.env.R2_BUCKET_NAME;
const DATA_BUCKET = process.env.R2_DATA_BUCKET;

// Everything that isn't an uploaded file. Uploaded files sit at the bucket
// root with no prefix, which is exactly why the lifecycle rule couldn't be
// scoped around them.
const PREFIXES = ['users/', 'short-urls/', 'index/'];

const apply = process.argv.includes('--apply');

if (!FILE_BUCKET || !DATA_BUCKET) {
  console.error('R2_BUCKET_NAME and R2_DATA_BUCKET must both be set in .env');
  process.exit(1);
}

if (FILE_BUCKET === DATA_BUCKET) {
  console.error('R2_DATA_BUCKET is the same as R2_BUCKET_NAME — nothing to migrate.');
  process.exit(1);
}

const useExplicitEndpoint = Boolean(process.env.R2_ENDPOINT);

const s3 = new S3Client({
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

const listAll = async (prefix) => {
  const keys = [];
  let token;

  do {
    const page = await s3.send(
      new ListObjectsV2Command({
        Bucket: FILE_BUCKET,
        Prefix: prefix,
        ContinuationToken: token,
      })
    );
    for (const object of page.Contents || []) keys.push(object.Key);
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);

  return keys;
};

(async () => {
  console.log(`${apply ? 'Copying' : 'Would copy'} from ${FILE_BUCKET} to ${DATA_BUCKET}\n`);

  let total = 0;
  let failed = 0;

  for (const prefix of PREFIXES) {
    const keys = await listAll(prefix);
    console.log(`${prefix.padEnd(14)} ${keys.length} object(s)`);

    for (const key of keys) {
      if (!apply) continue;

      try {
        await s3.send(
          new CopyObjectCommand({
            Bucket: DATA_BUCKET,
            Key: key,
            CopySource: `${FILE_BUCKET}/${encodeURIComponent(key).replace(/%2F/g, '/')}`,
          })
        );
        total += 1;
      } catch (error) {
        failed += 1;
        console.error(`  failed: ${key} — ${error.name}: ${error.message}`);
      }
    }
  }

  if (!apply) {
    console.log('\nDry run. Re-run with --apply to copy.');
    return;
  }

  console.log(`\nCopied ${total} object(s), ${failed} failure(s).`);
  if (failed) process.exitCode = 1;
})().catch((error) => {
  console.error('Migration failed:', error);
  process.exit(1);
});
