/**
 * Server-rendered pages for recipients.
 *
 * These are the only screens external clients see, and they need to load
 * instantly for someone who has never used Drop before — so they're plain HTML
 * with inline CSS rather than anything that ships a bundle.
 *
 * Palette matches the app: Mørk grønn #003F46, Sand #F8F5EC, Gul #F5FF8C.
 */

/**
 * Escape anything that reaches the page from user input. File names are chosen
 * by the sender, so without this a crafted name would inject markup.
 */
const escapeHtml = (value = '') =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const layout = ({ title, body }) => `<!doctype html>
<html lang="no">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)} · Drop Involve</title>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: #003F46;
    color: #F8F5EC;
    font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .card {
    width: 100%;
    max-width: 420px;
    background: rgba(248, 245, 236, 0.04);
    border: 1px solid rgba(248, 245, 236, 0.10);
    border-radius: 16px;
    padding: 32px;
    text-align: center;
  }
  .mark {
    width: 40px; height: 40px;
    margin: 0 auto 20px;
    border-radius: 6px;
    background: #F5FF8C;
    color: #162022;
    font-size: 24px;
    font-weight: bold;
    line-height: 40px;
  }
  h1 { font-size: 20px; margin: 0 0 8px; }
  p  { font-size: 15px; line-height: 1.6; color: rgba(248,245,236,0.7); margin: 0 0 8px; }
  .file {
    display: block;
    margin: 16px 0 24px;
    padding: 12px 16px;
    background: rgba(22, 32, 34, 0.35);
    border-radius: 8px;
    font-size: 14px;
    word-break: break-all;
  }
  form { margin-top: 20px; }
  input[type="password"] {
    width: 100%;
    padding: 12px 14px;
    border-radius: 8px;
    border: 1px solid rgba(248, 245, 236, 0.15);
    background: rgba(248, 245, 236, 0.06);
    color: #F8F5EC;
    font-size: 15px;
    font-family: inherit;
  }
  input[type="password"]:focus { outline: none; border-color: rgba(245,255,140,0.55); }
  button {
    width: 100%;
    margin-top: 12px;
    padding: 12px 16px;
    border: 0;
    border-radius: 8px;
    background: #F5FF8C;
    color: #162022;
    font-size: 15px;
    font-weight: 500;
    font-family: inherit;
    cursor: pointer;
  }
  button:hover { background: #e8f27f; }
  .error {
    margin-top: 16px;
    font-size: 14px;
    color: #F8B4B4;
  }
  .foot {
    margin-top: 28px;
    font-size: 13px;
    color: rgba(248,245,236,0.4);
  }
  .foot a { color: inherit; }
</style>
</head>
<body>
  <div class="card">
    <div class="mark">I</div>
    ${body}
    <p class="foot"><a href="https://involve.no">involve.no</a></p>
  </div>
</body>
</html>`;

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

/** Asks for the password set by the sender. */
const passwordPage = ({ shortId, fileName, error }) =>
  layout({
    title: 'Passordbeskyttet fil',
    body: `
      <h1>Denne filen er beskyttet</h1>
      <p>Avsenderen har satt et passord. Du skal ha fått det på en annen måte enn i e-posten.</p>
      ${fileName ? `<span class="file">${escapeHtml(fileName)}</span>` : ''}
      <form method="POST" action="/s/${encodeURIComponent(shortId)}">
        <input type="password" name="password" placeholder="Passord" autocomplete="off" autofocus required>
        <button type="submit">Åpne filen</button>
      </form>
      ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
    `,
  });

/** Anything else that goes wrong. */
const errorPage = ({ title = 'Noe gikk galt', message = 'Prøv igjen senere.' }) =>
  layout({
    title,
    body: `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`,
  });

module.exports = { expiredPage, passwordPage, errorPage, escapeHtml };
