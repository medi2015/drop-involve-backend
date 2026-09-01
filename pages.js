/**
 * Server-rendered pages for recipients.
 *
 * These are the only screens external clients see, and they need to load
 * instantly for someone who has never used Drop before — so they're plain HTML
 * with inline CSS rather than anything that ships a bundle.
 *
 * Nothing is stored per link. Each page is rendered on demand from the link's
 * record in R2, which is why a thousand links doesn't mean a thousand files.
 *
 * Palette matches the app: Mørk grønn #003F46, Sand #F8F5EC, Gul #F5FF8C.
 */

/**
 * Escape anything that reaches the page from user input. File names and
 * messages are chosen by the sender, so without this a crafted one would
 * inject markup.
 */
const escapeHtml = (value = '') =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

// Inlined rather than linked: no extra request, no hosting, and it stays sharp
// on any screen. Tinted to sand rather than pure white, which reads as pasted
// on against the green.
const LOGO = `<svg viewBox="0 0 1080 286" width="180" role="img" aria-label="Involve" xmlns="http://www.w3.org/2000/svg" style="height:auto;display:inline-block;">
<g fill="#F8F5EC">
<polygon points="440.7 86 392.4 86 345.3 198.2 298.8 86 250.6 86 335.7 279.1 355.6 279.1 440.7 86"/>
<polygon points="892.5 86 843.6 86 796.6 198.2 750.1 86 701.2 86 786.9 279.1 806.8 279.1 892.5 86"/>
<path d="M528.6,82.9c-50.9,0-92,29.4-92,99.3s41.1,99.3,92,99.3,92-29.4,92-99.3-41.1-99.3-92-99.3ZM528.6,244.8c-26.4,0-47.2-18.4-47.2-62.5s21.5-62.5,47.2-62.5,47.2,18.4,47.2,62.5-21.5,62.5-47.2,62.5Z"/>
<path d="M176.7,82.3c-22.7,0-41.7,7.4-54,21.5l-8-17.8h-32.5v192.5h44.8v-139.2c4.9-6.1,20.2-19,39.9-19s38.6,13.5,38.6,47.8v111h44.8v-124.5c0-34.3-20.2-72.3-73.6-72.3Z"/>
<rect x="5.7" y="15.5" width="46.6" height="263"/>
<path d="M686.2,4.4l-44.8,11v223.8c0,28.2,10.4,42.3,30.7,42.3s29.4-8.6,35.6-20.2c-5.5-1.8-21.5-6.7-21.5-42.3V4.4Z"/>
<path d="M987.2,83c-51.2-1.9-78.1,27.5-89.7,53.1-11.6,25.6-18.7,84,15.3,119,40.8,42,123.2,26.2,140.2,6.1l-17.1-34.2c-21.4,21.4-65.5,20.9-85.4,3.1-17.3-15.6-15.9-35.4-15.9-35.4h136.7c5.1-10.4,15.2-108-84.2-111.6ZM986,119c47.6,0,46.1,41.5,46.1,41.5h-95.5s5.5-41.5,50-41.5h-.6Z"/>
</g></svg>`;

const formatBytes = (bytes) => {
  const size = Number(bytes);
  if (!size || Number.isNaN(size)) return '';
  const units = ['B', 'kB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(size) / Math.log(1024)), units.length - 1);
  const value = size / Math.pow(1024, i);
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
};

const formatDate = (timestamp) => {
  if (!timestamp) return '';
  try {
    return new Date(Number(timestamp)).toLocaleDateString('no-NO', {
      day: 'numeric', month: 'long', year: 'numeric',
    });
  } catch {
    return '';
  }
};

/** Rough file kind from the extension, purely so the page reads naturally. */
const describeType = (fileName = '') => {
  const ext = String(fileName).split('.').pop().toLowerCase();
  const kinds = {
    pdf: 'PDF', zip: 'ZIP-arkiv', rar: 'RAR-arkiv',
    doc: 'Word', docx: 'Word', xls: 'Excel', xlsx: 'Excel',
    ppt: 'PowerPoint', pptx: 'PowerPoint',
    jpg: 'Bilde', jpeg: 'Bilde', png: 'Bilde', gif: 'Bilde', webp: 'Bilde', heic: 'Bilde',
    mp4: 'Video', mov: 'Video', avi: 'Video', mkv: 'Video',
    mp3: 'Lyd', wav: 'Lyd', aac: 'Lyd', m4a: 'Lyd',
    ai: 'Illustrator', psd: 'Photoshop', indd: 'InDesign',
  };
  return kinds[ext] || '';
};

const layout = ({ title, body, wide }) => `<!doctype html>
<html lang="no">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="dark">
<title>Drop Involve${title ? ` – ${escapeHtml(title)}` : ''}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 32px 16px;
    background: #003F46;
    color: #F8F5EC;
    font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .card {
    width: 100%;
    max-width: ${wide ? '520px' : '440px'};
    background: #0A464D;
    border: 1px solid #22585D;
    border-radius: 18px;
    padding: 40px 38px;
    text-align: center;
  }
  .wordmark { margin-bottom: 6px; }
  .service {
    margin: 0 0 30px;
    font-size: 13px;
    letter-spacing: 0.06em;
    color: #819E9C;
  }
  h1 { font-size: 23px; margin: 0 0 10px; font-weight: bold; }
  p  { font-size: 15px; line-height: 1.65; color: #B1C1BC; margin: 0 0 8px; }
  .from { color: #F8F5EC; font-size: 18px; font-weight: 500; margin: 0 0 26px; }
  .label { font-size: 14px; margin: 0 0 6px; color: #B1C1BC; }
  .panel {
    background: #0E393E;
    border-radius: 10px;
    padding: 22px;
    margin-bottom: 26px;
    text-align: left;
  }
  .filename {
    margin: 0 0 3px;
    font-size: 17px;
    font-weight: 500;
    color: #F8F5EC;
    word-break: break-word;
  }
  .meta { margin: 0; font-size: 13px; color: #99AFAC; }
  .message {
    margin: 16px 0 0;
    font-size: 15px;
    color: #F8F5EC;
    line-height: 1.6;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .message-label { margin: 18px 0 6px; font-size: 13px; color: #B1C1BC; }
  .btn {
    display: block;
    width: 100%;
    padding: 17px 20px;
    border: 0;
    border-radius: 8px;
    background: #F5FF8C;
    color: #162022;
    font-family: inherit;
    font-size: 16px;
    font-weight: bold;
    text-decoration: none;
    cursor: pointer;
  }
  .btn:hover { background: #E8F27F; }
  input[type="password"] {
    width: 100%;
    padding: 12px 14px;
    margin-bottom: 10px;
    border-radius: 8px;
    border: 1px solid rgba(248, 245, 236, 0.15);
    background: rgba(248, 245, 236, 0.06);
    color: #F8F5EC;
    font-family: inherit;
    font-size: 15px;
  }
  input[type="password"]:focus { outline: none; border-color: rgba(245,255,140,0.55); }
  .fine { margin: 18px 0 0; font-size: 13px; line-height: 1.6; color: #99AFAC; }
  .error { margin: 16px 0 0; font-size: 14px; color: #F8B4B4; }
  .foot { margin: 26px 0 0; font-size: 13px; color: rgba(248,245,236,0.4); }
  .foot a { color: inherit; }
</style>
</head>
<body>
  <div class="card">
    <div class="wordmark">${LOGO}</div>
    <p class="service">DROP.INVOLVE.NO</p>
    ${body}
    <p class="foot"><a href="https://involve.no">involve.no</a></p>
  </div>
</body>
</html>`;

/**
 * The page a recipient lands on. Replaces the bare redirect so there's a
 * branded, explanatory step before the download — they can see what they're
 * getting and who from before committing to it.
 */
const landingPage = ({
  shortId, fileName, fileSize, senderEmail, message, expiresAt, hasPassword, error, token,
}) => {
  const type = describeType(fileName);
  const size = formatBytes(fileSize);
  const meta = [size, type].filter(Boolean).join(' · ');
  const expiry = formatDate(expiresAt);

  // Identifies which recipient this is, so the download receipt can name them.
  // Carried from the emailed link through to the download, since the receipt is
  // now sent from the download rather than from opening this page.
  const ref = token ? `?r=${encodeURIComponent(token)}` : '';

  return layout({
    title: fileName ? `${fileName}` : 'Fil klar for nedlasting',
    wide: true,
    body: `
      ${senderEmail ? `
        <p class="label">Du har fått en fil fra</p>
        <p class="from">${escapeHtml(senderEmail)}</p>
      ` : `
        <h1>Du har fått en fil</h1>
      `}

      <div class="panel">
        <p class="filename">${escapeHtml(fileName || 'Ukjent filnavn')}</p>
        ${meta ? `<p class="meta">${escapeHtml(meta)}</p>` : ''}
        ${message ? `
          <p class="message-label">Melding</p>
          <p class="message">${escapeHtml(message)}</p>
        ` : ''}
      </div>

      ${hasPassword ? `
        <form method="POST" action="/s/${encodeURIComponent(shortId)}${ref}">
          <input type="password" name="password" placeholder="Passord" autocomplete="off" autofocus required>
          <button class="btn" type="submit">Åpne og last ned</button>
        </form>
        <p class="fine">Avsenderen har satt et passord. Du skal ha fått det på en
        annen måte enn i e-posten.</p>
      ` : `
        <a class="btn" href="/s/${encodeURIComponent(shortId)}/d${ref}">Last ned filen</a>
      `}

      ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}

      ${expiry ? `<p class="fine">Lenken utløper ${escapeHtml(expiry)}<br>Filen slettes automatisk etterpå</p>` : ''}
    `,
  });
};

/** Link expired, deleted, or never existed. Deliberately doesn't distinguish. */
const expiredPage = () =>
  layout({
    title: 'Lenken er utløpt',
    body: `
      <h1>Lenken er utløpt</h1>
      <p>Filer på Drop slettes automatisk etter en tid, og lenken virker derfor ikke lenger.</p>
      <p>Ta kontakt med avsenderen for å få en ny lenke.</p>
    `,
  });

/** Anything else that goes wrong. */
const errorPage = ({ title = 'Noe gikk galt', message = 'Prøv igjen senere.' }) =>
  layout({
    title,
    body: `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`,
  });

module.exports = { landingPage, expiredPage, errorPage, escapeHtml, formatBytes };
