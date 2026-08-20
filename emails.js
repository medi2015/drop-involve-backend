const { escapeHtml } = require('./pages');

/**
 * Emails sent to recipients.
 *
 * Email rendering is stuck in about 2005: inline styles only, tables for
 * layout, solid colours rather than rgba, and no reliance on <style> blocks
 * because Outlook and Gmail strip or mangle them. Everything here is written
 * to that constraint rather than to how the app itself is built.
 *
 * Palette matches the app: Mørk grønn #003F46, Sand #F8F5EC, Gul #F5FF8C.
 */

const INK = '#003F46';
const CARD = '#00343A';
const INSET = '#002A2F';
const SAND = '#F8F5EC';
const MUTED = '#9FB0AD';
const BRAND = '#F5FF8C';
const INK_DEEP = '#162022';
const BORDER = '#0C4B53';

const FONT = "'Helvetica Neue', Helvetica, Arial, sans-serif";

/** Newlines only survive if turned into markup. Escaped first. */
const paragraphs = (text) =>
  escapeHtml(text).replace(/\r?\n/g, '<br>');

const layout = ({ preheader, body }) => `<!doctype html>
<html lang="no">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
</head>
<body style="margin:0; padding:0; background-color:${INK};">
  <!-- Shown in the inbox preview line, hidden in the message itself. -->
  <div style="display:none; max-height:0; overflow:hidden; opacity:0;">${escapeHtml(preheader)}</div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${INK}; padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px; background-color:${CARD}; border:1px solid ${BORDER}; border-radius:16px;">
          <tr>
            <td style="padding:32px;">

              <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:24px;">
                <tr>
                  <td style="background-color:${BRAND}; width:32px; height:32px; border-radius:6px; text-align:center; font-family:${FONT}; font-size:19px; font-weight:bold; color:${INK_DEEP};">I</td>
                  <td style="padding-left:10px; font-family:${FONT}; font-size:15px; font-weight:bold; color:${SAND}; letter-spacing:0.02em;">drop.involve.no</td>
                </tr>
              </table>

              ${body}

            </td>
          </tr>
        </table>

        <p style="margin:20px 0 0; font-family:${FONT}; font-size:12px; color:${MUTED};">
          Sendt via <a href="https://involve.no" style="color:${MUTED};">Involve</a>
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`;

const detailRow = (label, value) => `
  <tr>
    <td style="padding:0 0 10px 0; font-family:${FONT}; font-size:14px; color:${MUTED}; white-space:nowrap; vertical-align:top;">${escapeHtml(label)}</td>
    <td style="padding:0 0 10px 12px; font-family:${FONT}; font-size:14px; color:${SAND}; word-break:break-word;">${value}</td>
  </tr>`;

/** The main "someone sent you a file" email. */
const fileSharedEmail = ({ emailFrom, fileName, message, link, expiryDays = 7, hasPassword }) =>
  layout({
    preheader: `${fileName} — klar for nedlasting`,
    body: `
      <h1 style="margin:0 0 6px; font-family:${FONT}; font-size:20px; font-weight:bold; color:${SAND};">Du har fått en fil</h1>
      <p style="margin:0 0 24px; font-family:${FONT}; font-size:14px; color:${MUTED};">Filen ligger klar og kan lastes ned med knappen under.</p>

      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${INSET}; border-radius:10px; padding:18px; margin-bottom:24px;">
        <tr><td style="padding:18px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            ${detailRow('Fra', `<a href="mailto:${escapeHtml(emailFrom)}" style="color:${BRAND}; text-decoration:none;">${escapeHtml(emailFrom)}</a>`)}
            ${detailRow('Fil', escapeHtml(fileName))}
            ${message ? detailRow('Melding', paragraphs(message)) : ''}
          </table>
        </td></tr>
      </table>

      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;">
        <tr>
          <td align="center" bgcolor="${BRAND}" style="border-radius:8px;">
            <a href="${link}" style="display:inline-block; padding:14px 32px; font-family:${FONT}; font-size:15px; font-weight:bold; color:${INK_DEEP}; text-decoration:none;">Last ned filen</a>
          </td>
        </tr>
      </table>

      ${hasPassword ? `
      <p style="margin:0 0 12px; font-family:${FONT}; font-size:13px; color:${BRAND};">
        Filen er passordbeskyttet. Avsenderen sender passordet separat.
      </p>` : ''}

      <p style="margin:0; font-family:${FONT}; font-size:12px; color:${MUTED};">
        Lenken slutter å virke etter ${Number(expiryDays)} dager, og filen slettes automatisk.
      </p>
    `,
  });

/** Sent back to the sender when their file is collected. */
const downloadReceiptEmail = ({ fileName, downloader }) =>
  layout({
    preheader: `${fileName} er lastet ned`,
    body: `
      <h1 style="margin:0 0 6px; font-family:${FONT}; font-size:20px; font-weight:bold; color:${SAND};">Filen er lastet ned</h1>
      <p style="margin:0 0 24px; font-family:${FONT}; font-size:14px; color:${MUTED};">Mottakeren har hentet filen du sendte.</p>

      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${INSET}; border-radius:10px;">
        <tr><td style="padding:18px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            ${detailRow('Fil', escapeHtml(fileName))}
            ${downloader ? detailRow('Lastet ned av', escapeHtml(downloader)) : ''}
          </table>
        </td></tr>
      </table>
    `,
  });

module.exports = { fileSharedEmail, downloadReceiptEmail };
