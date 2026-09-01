const { escapeHtml } = require('./pages');

/**
 * Emails sent to recipients.
 *
 * Follows the same design as the landing page: sand card on dark green, white
 * inner panel for the file details, yellow download button with a notched icon
 * chip, Involve wordmark alongside.
 *
 * Email rendering is stuck in about 2005: inline styles only, tables for
 * layout, solid colours rather than rgba, and no reliance on <style> blocks
 * because Outlook and Gmail strip or mangle them. Everything here is written to
 * that constraint rather than to how the app is built.
 *
 * Two deliberate departures from the mockup:
 *
 * - Desktop Outlook renders through Word and ignores border-radius, so the card
 *   is square there. Faking it with VML is fragile and a well-known source of
 *   broken layouts; everywhere else gets the rounded design.
 * - The wordmark sits beside the card as in the mockup, using a two-column
 *   table. Below ~600px a media query stacks them, which most clients honour;
 *   the ones that don't simply scale the whole message down to fit, which is
 *   what they already do with any fixed-width email.
 *
 * Neue Haas Grotesk can't be used: clients strip @font-face, so body text falls
 * back to Helvetica and Arial. The monospace details survive, because every
 * client has *some* monospace font and the generic keyword resolves to it.
 */

const INK = '#003F46';       // Mørk grønn — page background
const SAND = '#F8F5EC';      // Sand — the card
const WHITE = '#FFFFFF';     // The inner panel
const BRAND = '#F5FF8C';     // Gul — the button
const INK_DEEP = '#162022';  // Sort — button text
const MUTED = '#4E7276';     // Labels and fine print, on sand
const SAND_DIM = '#9FB3B0';  // Fine print on the green background

const SANS = "'Helvetica Neue', Helvetica, Arial, sans-serif";
const MONO = "'Andale Mono', Consolas, 'Courier New', monospace";

/** Newlines only survive if turned into markup. Escaped first. */
const paragraphs = (text) => escapeHtml(text).replace(/\r?\n/g, '<br>');

const label = (text) => `
  <p style="margin:0 0 4px; font-family:${MONO}; font-size:11px; letter-spacing:0.08em; text-transform:uppercase; color:${MUTED};">${escapeHtml(text)}</p>`;

const layout = ({ preheader, body }) => `<!doctype html>
<html lang="no">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<style>
  /* The only rule that isn't inline. Clients that strip this get the desktop
     layout scaled to fit, which is what they do with any fixed-width email
     anyway — so the stacking is an improvement, never a dependency. */
  @media only screen and (max-width: 600px) {
    .col       { display: block !important; width: 100% !important; }
    .wordmark  { padding: 24px 0 0 0 !important; text-align: right !important; }
    .wordmark img { margin-left: auto !important; width: 130px !important; }
  }
</style>
</head>
<body style="margin:0; padding:0; background-color:${INK};">
  <!-- Shown in the inbox preview line, hidden in the message itself. -->
  <div style="display:none; max-height:0; overflow:hidden; opacity:0;">${escapeHtml(preheader)}</div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${INK};">
    <tr>
      <td align="center" style="padding:36px 16px 44px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:640px;">
          ${body}
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

/**
 * The card and the wordmark, side by side.
 *
 * The wordmark cell is bottom-aligned so the logo sits on the card's baseline
 * rather than floating beside its middle — that alignment is what makes the
 * mockup read as one composition instead of two separate objects.
 */
const cardWithWordmark = (card) => `
  <tr>
    <td>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td class="col" width="430" valign="top" style="width:430px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr><td style="background-color:${SAND}; border-radius:16px; padding:28px 26px 26px;">${card}</td></tr>
            </table>
          </td>

          <td class="col wordmark" valign="bottom" align="right" style="padding:0 0 6px 26px;">
            <img src="https://drop.involve.no/involve-wordmark-sand.png"
                 width="165" alt="Involve"
                 style="display:block; border:0; margin-left:auto; color:${SAND}; font-family:${SANS}; font-size:22px; font-weight:bold;">
          </td>
        </tr>
      </table>
    </td>
  </tr>`;

/** The main "someone sent you a file" email. */
const fileSharedEmail = ({ emailFrom, fileName, message, link, directLink, expiryDays = 7, hasPassword }) =>
  layout({
    preheader: `${fileName} — klar for nedlasting`,
    body: `
      ${cardWithWordmark(`
          <p style="margin:0 0 4px; font-family:${SANS}; font-size:15px; color:${INK};">Du har mottatt en fil fra:</p>
          <p style="margin:0 0 20px; font-family:${SANS}; font-size:21px; font-weight:bold; color:${INK}; word-break:break-word;">
            <a href="mailto:${escapeHtml(emailFrom)}" style="color:${INK}; text-decoration:none;">${escapeHtml(emailFrom)}</a>
          </p>

          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${WHITE}; border-radius:10px;">
            <tr>
              <td style="padding:20px 20px 22px;">
                ${label('Filnavn')}
                <p style="margin:0 0 ${message ? '18px' : '0'}; font-family:${SANS}; font-size:16px; color:${INK}; word-break:break-word;">${escapeHtml(fileName)}</p>
                ${message ? `
                  ${label('Melding')}
                  <p style="margin:0; font-family:${SANS}; font-size:15px; line-height:1.55; color:${INK};">${paragraphs(message)}</p>
                ` : ''}
              </td>
            </tr>
          </table>

          <!-- Button and icon chip, split by a notch as in the design. Two
               cells with a spacer rather than a gap, which Outlook ignores. -->
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:22px;">
            <tr>
              <td align="center" bgcolor="${BRAND}" style="border-radius:10px;">
                <a href="${link}" style="display:block; padding:19px 12px; font-family:${MONO}; font-size:15px; letter-spacing:0.06em; text-transform:uppercase; color:${INK_DEEP}; text-decoration:none;">Last ned filen</a>
              </td>
              <td width="5" style="font-size:0; line-height:0;">&nbsp;</td>
              <td width="62" align="center" bgcolor="${BRAND}" style="border-radius:10px;">
                <a href="${link}" style="display:block; padding:18px 0;">
                  <img src="https://drop.involve.no/download-icon.png" width="20" height="20" alt="" style="display:block; margin:0 auto; border:0;">
                </a>
              </td>
            </tr>
          </table>

          ${hasPassword ? `
          <p style="margin:16px 0 0; font-family:${SANS}; font-size:12.5px; line-height:1.5; color:${MUTED};">
            Filen er passordbeskyttet. Passordet sendes ikke på e-post &mdash; ta
            kontakt med avsenderen for å få det.
          </p>` : ''}

          <p style="margin:16px 0 0; font-family:${SANS}; font-size:12.5px; line-height:1.5; color:${MUTED};">
            Lenken slutter å fungere etter ${Number(expiryDays)} ${Number(expiryDays) === 1 ? 'dag' : 'dager'}.
            Ta kontakt med avsender dersom du trenger en ny overføring.
          </p>
      `)}

      ${directLink && !hasPassword ? `
      <tr>
        <!-- Left-aligned to the card's edge rather than centred under the full
             width, where it floated between the card and the wordmark with no
             relationship to either. -->
        <td align="left" style="padding:20px 0 0 2px;">
          <a href="${directLink}" style="font-family:${SANS}; font-size:12px; color:${SAND_DIM};">Hopp over landingsside og last ned direkte</a>
        </td>
      </tr>` : ''}
    `,
  });

/** Sent back to the sender when their file is collected. */
const downloadReceiptEmail = ({ fileName, downloader }) =>
  layout({
    preheader: `${fileName} er lastet ned`,
    body: `
      ${cardWithWordmark(`
          <p style="margin:0 0 20px; font-family:${SANS}; font-size:21px; font-weight:bold; color:${INK};">Filen er lastet ned</p>

          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${WHITE}; border-radius:10px;">
            <tr>
              <td style="padding:20px;">
                ${label('Filnavn')}
                <p style="margin:0 0 ${downloader ? '18px' : '0'}; font-family:${SANS}; font-size:16px; color:${INK}; word-break:break-word;">${escapeHtml(fileName)}</p>
                ${downloader ? `
                  ${label('Lastet ned av')}
                  <p style="margin:0; font-family:${SANS}; font-size:16px; color:${INK};">${escapeHtml(downloader)}</p>
                ` : ''}
              </td>
            </tr>
          </table>
      `)}
    `,
  });

module.exports = { fileSharedEmail, downloadReceiptEmail };
