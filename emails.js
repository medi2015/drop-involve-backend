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

// These are the app's own surfaces, resolved to solid values.
//
// The app layers translucent sand over the dark green — .surface is
// rgba(248,245,236,0.04), .surface-inset is rgba(22,32,34,0.35) on top of that.
// Email clients can't be trusted with rgba, so each is pre-composited here.
// Guessing at them by eye made the email noticeably darker than the app, as if
// it came from somewhere else.
const INK = '#003F46';      // page background, same as body
const CARD = '#0A464D';     // .surface over #003F46
const INSET = '#0E393E';    // .surface-inset over the card
const BORDER = '#22585D';   // .surface border over the card
const SAND = '#F8F5EC';
const MUTED = '#99AFAC';    // text-sand/60 over the card
const FAINT = '#819E9C';    // text-sand/50 over the card
const BRAND = '#F5FF8C';
const INK_DEEP = '#162022';

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
                  <!-- A PNG, not the SVG: Gmail, Outlook and Apple Mail all
                       strip SVG. Many clients also block remote images by
                       default, so the alt text is styled to stand in for it. -->
                  <td>
                    <img src="https://drop.involve.no/involve-logo-white.png"
                         width="118" alt="Involve"
                         style="display:block; border:0; color:${SAND}; font-family:${FONT}; font-size:17px; font-weight:bold;">
                  </td>
                </tr>
              </table>

              ${body}

            </td>
          </tr>
        </table>

        <p style="margin:20px 0 0; font-family:${FONT}; font-size:12px; color:${FAINT};">
          Sendt via <a href="https://involve.no" style="color:${FAINT};">Involve</a>
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
const fileSharedEmail = ({ emailFrom, fileName, message, link, directLink, expiryDays = 7, hasPassword }) =>
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

      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;">
        <tr>
          <td align="center">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td align="center" bgcolor="${BRAND}" style="border-radius:8px;">
                  <a href="${link}" style="display:inline-block; padding:14px 32px; font-family:${FONT}; font-size:15px; font-weight:bold; color:${INK_DEEP}; text-decoration:none;">Last ned filen</a>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>

      ${hasPassword ? `
      <p style="margin:0 0 12px; font-family:${FONT}; font-size:13px; color:${BRAND}; text-align:center;">
        Filen er passordbeskyttet. Passordet sendes ikke på e-post &mdash; ta kontakt
        med avsenderen for å få det.
      </p>` : ''}

      <p style="margin:0 0 14px; font-family:${FONT}; font-size:12px; color:${FAINT}; text-align:center;">
        Lenken slutter å virke etter ${Number(expiryDays)} ${Number(expiryDays) === 1 ? 'dag' : 'dager'}, og filen slettes automatisk.
      </p>

      ${directLink && !hasPassword ? `
      <p style="margin:0; font-family:${FONT}; font-size:12px; text-align:center;">
        <a href="${directLink}" style="color:${SAND};">Hopp over mellomsiden og last ned direkte</a>
      </p>` : ''}
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
