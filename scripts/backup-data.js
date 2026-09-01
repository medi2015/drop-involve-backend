/**
 * Nightly backup of everything that can't be regenerated.
 *
 * R2 has no object versioning — Cloudflare offers lifecycle rules, bucket locks
 * and storage classes, but nothing that keeps a previous copy of an overwritten
 * object. Bucket locks would block overwrites entirely, which breaks history and
 * contacts because those are rewritten on every send. So the only protection
 * against a bad write or a mistaken delete is a copy somewhere else.
 *
 * What's backed up:
 *   users/       transfer history, contacts, session revocation markers
 *   short-urls/  live download links
 *   index/       email -> account lookup
 *   slides/      landing page content and its images
 *
 * Uploaded files are deliberately *not* backed up. They expire after 8 days by
 * design, they're large, and the sender still has the original.
 *
 * Writes a dated tarball and prunes old ones. Small enough that a month of
 * nightly snapshots is a few megabytes.
 *
 *   node scripts/backup-data.js
 */
require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { S3Client, ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');

const BUCKET = process.env.R2_DATA_BUCKET || process.env.R2_BUCKET_NAME;
const DEST = process.env.BACKUP_DIR || '/var/backups/drop-involve';
const KEEP_DAYS = Number(process.env.BACKUP_KEEP_DAYS || 30);
const PREFIXES = ['users/', 'short-urls/', 'index/', 'slides/'];

if (!BUCKET) {
  console.error('R2_DATA_BUCKET (or R2_BUCKET_NAME) must be set.');
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
      new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ContinuationToken: token })
    );
    for (const object of page.Contents || []) keys.push(object.Key);
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);

  return keys;
};

/** Old snapshots, removed by age rather than count so a gap can't hide one. */
const prune = () => {
  const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
  let removed = 0;

  for (const name of fs.readdirSync(DEST)) {
    if (!/^drop-data-\d{4}-\d{2}-\d{2}\.tar\.gz$/.test(name)) continue;
    const file = path.join(DEST, name);
    if (fs.statSync(file).mtimeMs < cutoff) {
      fs.unlinkSync(file);
      removed += 1;
    }
  }

  return removed;
};

(async () => {
  const stamp = new Date().toISOString().slice(0, 10);
  const staging = path.join(DEST, `staging-${stamp}`);

  fs.mkdirSync(staging, { recursive: true });

  let count = 0;
  let bytes = 0;

  try {
    for (const prefix of PREFIXES) {
      for (const key of await listAll(prefix)) {
        const target = path.join(staging, key);
        fs.mkdirSync(path.dirname(target), { recursive: true });

        const object = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
        const body = Buffer.from(await object.Body.transformToByteArray());

        fs.writeFileSync(target, body);
        count += 1;
        bytes += body.length;
      }
    }

    if (count === 0) {
      // Better to fail loudly than to write an empty archive over a good one.
      throw new Error('nothing found to back up — check credentials and bucket name');
    }

    const archive = path.join(DEST, `drop-data-${stamp}.tar.gz`);
    execFileSync('tar', ['-czf', archive, '-C', staging, '.']);

    const size = fs.statSync(archive).size;
    const pruned = prune();

    console.log(
      `[backup] ${count} object(s), ${Math.round(bytes / 1024)} kB -> ` +
      `${archive} (${Math.round(size / 1024)} kB), pruned ${pruned}`
    );
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error('[backup] failed:', error.message);
  process.exit(1);
});
