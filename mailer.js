/**
 * Mail transport.
 *
 * Two backends, chosen by environment so the provider can be swapped (or rolled
 * back) without touching call sites:
 *
 *   SMTP_HOST set    -> Google Workspace over SMTP
 *   SMTP_HOST unset  -> Resend (the original provider, kept as a fallback)
 *
 * Google Workspace options, both reached through the same code:
 *
 *   smtp-relay.gmail.com:587  10,000/day, can authenticate by IP so no
 *                             password is stored, and may send as any address
 *                             in the domain. Needs a super-admin to enable.
 *
 *   smtp.gmail.com:587        2,000 recipients/day, app password required,
 *                             and Gmail rewrites From to the authenticated
 *                             mailbox.
 *
 * Every function resolves to { error } rather than throwing, matching what
 * Resend's SDK returns, so callers check one thing regardless of backend.
 */

const nodemailer = require('nodemailer');
const { Resend } = require('resend');

const useSmtp = Boolean(process.env.SMTP_HOST);

let transporter = null;
let resend = null;

if (useSmtp) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    // Port 587 upgrades via STARTTLS, so `secure` stays false and requireTLS
    // forces the upgrade rather than allowing a plaintext session.
    secure: Number(process.env.SMTP_PORT || 587) === 465,
    requireTLS: true,
    // The name announced in EHLO. Nodemailer defaults to os.hostname(), which
    // on this VPS is the bare word "vultr" — not a FQDN. Google's relay accepts
    // that in the plaintext session but rejects it inside TLS with a 421.
    name: process.env.SMTP_EHLO_NAME || 'file.involve.no',

    // Force IPv4 unless told otherwise. Google's relay authenticates by IP,
    // and allowlists are normally IPv4 — but Node will happily connect over
    // IPv6 when the host has it, arriving from an address Google doesn't
    // recognise and getting closed at EHLO with a 421.
    family: Number(process.env.SMTP_FAMILY || 4),

    // Google requires TLS 1.2 or better for relay.
    tls: { minVersion: 'TLSv1.2' },

    // No credentials means the relay is authenticating us by IP address.
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
  });
  console.log(`[mail] using SMTP via ${process.env.SMTP_HOST}`);
} else {
  resend = new Resend(process.env.RESEND_API_KEY);
  console.log('[mail] using Resend');
}

/**
 * @param {{from: string, to: string|string[], replyTo?: string, subject: string, html: string}} message
 * @returns {Promise<{error: Error|null}>}
 */
async function sendMail({ from, to, replyTo, subject, html }) {
  if (useSmtp) {
    try {
      await transporter.sendMail({ from, to, replyTo, subject, html });
      return { error: null };
    } catch (error) {
      return { error };
    }
  }

  const { error } = await resend.emails.send({
    from,
    to: Array.isArray(to) ? to : [to],
    reply_to: replyTo,
    subject,
    html,
  });

  return { error: error || null };
}

/**
 * Proves the transport can actually connect and authenticate. Worth calling at
 * startup: a bad password otherwise only surfaces when a user requests a code.
 */
async function verifyTransport() {
  if (!useSmtp) return { ok: true, detail: 'resend (no connection check)' };

  try {
    await transporter.verify();
    return { ok: true, detail: `smtp ${process.env.SMTP_HOST}` };
  } catch (error) {
    return { ok: false, detail: error.message };
  }
}

module.exports = { sendMail, verifyTransport, backend: useSmtp ? 'smtp' : 'resend' };
