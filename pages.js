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
 * Layout follows Filnedlasting_Involve_Mehdi.pdf: the download card pinned
 * left, an optional case card to its right over a full-bleed background, and
 * the Involve wordmark oversized and bleeding off the bottom. One slide is
 * chosen at random per visit — see slides.js.
 *
 * On phones the case card is dropped entirely and the page falls back to the
 * flat yellow variant, which is the first page of the PDF.
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

// Involve brand palette. Defaults only — every one of these can be overridden
// per slide from the admin, so a slide can be tuned to its own photograph
// without a deploy.
const INK = '#003F46';       // Mørk grønn
const INK_DEEP = '#162022';  // Sort
const SAND = '#F8F5EC';      // Sand
const BRAND = '#F5FF8C';     // Gul
const CASE_CARD = '#0B1416'; // The dark case panel
const CASE_OPACITY = 0.75;   // Lets the background photograph read through it
const CTA_COLOR = '#003F48'; // The "Se caset her" button

/**
 * Colours and image URLs from slides end up inside a style attribute, so they
 * have to be constrained. Without this, a value containing a quote breaks out
 * of the attribute and can inject markup. Slides are written by staff rather
 * than the public, but "only our own people can edit it" is not a reason to
 * build an injection hole.
 */
const safeColor = (value, fallback) => {
  const text = String(value ?? '').trim();
  const ok =
    /^#[0-9a-f]{3,8}$/i.test(text) ||
    /^rgba?\(\s*[\d.\s,%]+\)$/i.test(text) ||
    /^[a-z]{3,20}$/i.test(text); // named colours
  return ok ? text : fallback;
};

/**
 * Single quotes survive encodeURI, and url('…') is quoted — so escape them.
 * Only http and https: without the scheme check a CTA of `javascript:alert(1)`
 * would run when a recipient clicked it.
 */
const safeUrl = (value) => {
  const text = String(value ?? '').trim();
  if (!/^https?:\/\//i.test(text)) return '';
  return encodeURI(text).replace(/'/g, '%27');
};

/**
 * Hex to rgba, so a slide colour can be given a transparency without the
 * person editing it having to think in rgba. Falls back to the input untouched
 * if it isn't a plain hex, which lets someone paste an rgba() string directly.
 */
const withAlpha = (hex, alpha) => {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!match) return hex;

  let value = match[1];
  if (value.length === 3) value = value.split('').map((c) => c + c).join('');

  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  const a = Math.min(Math.max(Number(alpha), 0), 1);

  return `rgba(${r}, ${g}, ${b}, ${Number.isFinite(a) ? a : 1})`;
};

// The wordmark, inlined: no extra request, sharp at any size. Drawn at the
// bottom of the page at a size that deliberately runs off the edge.
const WORDMARK = `<svg viewBox="0 0 1080 286" role="img" aria-label="Involve" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMinYMax meet">
<g fill="#062022">
<polygon points="440.7 86 392.4 86 345.3 198.2 298.8 86 250.6 86 335.7 279.1 355.6 279.1 440.7 86"/>
<polygon points="892.5 86 843.6 86 796.6 198.2 750.1 86 701.2 86 786.9 279.1 806.8 279.1 892.5 86"/>
<path d="M528.6,82.9c-50.9,0-92,29.4-92,99.3s41.1,99.3,92,99.3,92-29.4,92-99.3-41.1-99.3-92-99.3ZM528.6,244.8c-26.4,0-47.2-18.4-47.2-62.5s21.5-62.5,47.2-62.5,47.2,18.4,47.2,62.5-21.5,62.5-47.2,62.5Z"/>
<path d="M176.7,82.3c-22.7,0-41.7,7.4-54,21.5l-8-17.8h-32.5v192.5h44.8v-139.2c4.9-6.1,20.2-19,39.9-19s38.6,13.5,38.6,47.8v111h44.8v-124.5c0-34.3-20.2-72.3-73.6-72.3Z"/>
<rect x="5.7" y="15.5" width="46.6" height="263"/>
<path d="M686.2,4.4l-44.8,11v223.8c0,28.2,10.4,42.3,30.7,42.3s29.4-8.6,35.6-20.2c-5.5-1.8-21.5-6.7-21.5-42.3V4.4Z"/>
<path d="M987.2,83c-51.2-1.9-78.1,27.5-89.7,53.1-11.6,25.6-18.7,84,15.3,119,40.8,42,123.2,26.2,140.2,6.1l-17.1-34.2c-21.4,21.4-65.5,20.9-85.4,3.1-17.3-15.6-15.9-35.4-15.9-35.4h136.7c5.1-10.4,15.2-108-84.2-111.6ZM986,119c47.6,0,46.1,41.5,46.1,41.5h-95.5s5.5-41.5,50-41.5h-.6Z"/>
</g></svg>`;

const DOWNLOAD_ICON = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;

const CHEVRON_LEFT = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"/></svg>`;
const CHEVRON_RIGHT = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>`;

const isLightColor = (hex) => {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!match) return false;
  let val = match[1];
  if (val.length === 3) val = val.split('').map((c) => c + c).join('');
  const r = parseInt(val.slice(0, 2), 16);
  const g = parseInt(val.slice(2, 4), 16);
  const b = parseInt(val.slice(4, 6), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 > 160;
};

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

// Involve's own Adobe Fonts kit, the same one involve.no uses.
//
// Kit lnt3nfg carries neue-haas-grotesk-text (400/700 plus italics),
// neue-haas-grotesk-display and andale-mono-mt-pro (400 only). There is no
// weight 500 in it, so nothing here asks for one — a browser fakes a missing
// weight by smearing the outlines, which on a display face is visible.
//
// Adobe's terms don't allow self-hosting these files, so this is a third-party
// request on a page that has to open fast for people outside Involve. Preconnect
// covers most of that cost. The stack falls back to Helvetica if Adobe is
// unreachable, which is a duller page rather than a broken one.
//
// No domain configuration is needed: Adobe web projects work on any host, and
// any number of them. (Typekit required a domain allowlist; Adobe removed it.)
const FONTS = `
<link rel="preconnect" href="https://use.typekit.net" crossorigin>
<link rel="preconnect" href="https://p.typekit.net" crossorigin>
<link rel="stylesheet" href="https://use.typekit.net/lnt3nfg.css">`;

const CSS = `
  *, *::before, *::after { box-sizing: border-box; }

  :root {
    --ink: ${INK};
    --ink-deep: ${INK_DEEP};
    --sand: ${SAND};
    --brand: ${BRAND};
    --case: ${CASE_CARD};
    --sans: "neue-haas-grotesk-text", "Helvetica Neue", Helvetica, Arial, sans-serif;
    --display: "neue-haas-grotesk-display", "neue-haas-grotesk-text", "Helvetica Neue", Helvetica, Arial, sans-serif;
    --mono: "andale-mono-mt-pro", "Andale Mono", ui-monospace, Menlo, Consolas, monospace;
  }

  html, body { height: 100%; }

  body {
    margin: 0;
    min-height: 100%;
    background: var(--stage-bg, ${INK});
    color: ${INK_DEEP};
    font-family: var(--sans);
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }

  /* The background photo. A separate layer rather than a body background so it
     can be dimmed without tinting the cards sitting on top of it. */
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 0;
    background-size: cover;
    background-position: center;
    background-repeat: no-repeat;
  }
  .backdrop::after {
    content: "";
    position: absolute;
    inset: 0;
    background: rgba(0, 32, 36, 0.28);
  }

  .stage {
    position: relative;
    z-index: 1;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    padding: 48px clamp(20px, 5vw, 88px) 0;
  }

  .panels {
    flex: 1;
    display: flex;
    align-items: flex-start;
    gap: clamp(20px, 3vw, 40px);
    flex-wrap: nowrap;
  }

  /* --- The download card -------------------------------------------------- */

  .card {
    width: 100%;
    max-width: 420px;
    flex: 0 0 auto;
    background: ${SAND};
    border-radius: 20px;
    padding: 30px 32px 32px;
    color: ${INK};
  }

  .eyebrow {
    margin: 0 0 40px;
    font-family: var(--mono);
    font-size: 13px;
    letter-spacing: 0.02em;
    color: ${INK};
  }

  .from-label { margin: 0 0 4px; font-size: 15px; color: ${INK}; }
  .from {
    margin: 0 0 22px;
    font-size: 21px;
    font-weight: 700;
    color: ${INK};
    word-break: break-word;
  }

  .details {
    background: #FFFFFF;
    border-radius: 12px;
    padding: 22px 24px;
    margin-bottom: 22px;
  }

  .field-label {
    margin: 0 0 4px;
    font-family: var(--mono);
    font-size: 12px;
    letter-spacing: 0.04em;
    color: ${INK};
    opacity: 0.75;
  }

  .filename {
    margin: 0 0 18px;
    font-size: 16px;
    font-weight: 700;
    color: ${INK};
    word-break: break-word;
  }

  .message {
    margin: 0;
    font-size: 15px;
    line-height: 1.5;
    color: ${INK};
    white-space: pre-wrap;
    word-break: break-word;
  }

  /* Button and its icon chip, split by a notch as in the design. */
  .action { display: flex; gap: 4px; }

  .btn {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 19px 20px;
    border: 0;
    border-radius: 10px;
    background: ${BRAND};
    color: ${INK_DEEP};
    font-family: var(--mono);
    font-size: 15px;
    font-weight: 400;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    text-decoration: none;
    cursor: pointer;
  }

  .btn-icon {
    flex: 0 0 62px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 10px;
    background: ${BRAND};
    color: ${INK_DEEP};
  }

  .btn:hover, .action:hover .btn-icon { background: #E9F47D; }

  input[type="password"] {
    width: 100%;
    padding: 15px 16px;
    margin-bottom: 10px;
    border-radius: 10px;
    border: 1px solid rgba(0, 63, 70, 0.25);
    background: #FFFFFF;
    color: ${INK};
    font-family: var(--sans);
    font-size: 15px;
  }
  input[type="password"]:focus { outline: 2px solid ${INK}; outline-offset: -2px; }

  .fine {
    margin: 16px 0 0;
    font-size: 13px;
    line-height: 1.5;
    color: rgba(0, 63, 70, 0.75);
  }
  .error {
    margin: 14px 0 0;
    font-size: 14px;
    font-weight: 700;
    color: #A4161A;
  }

  /* --- The case card ------------------------------------------------------ */

  .case {
    display: flex;
    gap: 0;
    max-width: 660px;
    /* Translucent by default so the photograph behind still reads through. */
    background: var(--case-bg, ${withAlpha(CASE_CARD, CASE_OPACITY)});
    border-radius: 16px;
    overflow: hidden;
    color: var(--case-text, ${SAND});
  }

  .case-media { flex: 0 0 42%; padding: 22px; display: flex; flex-direction: column; justify-content: space-between; gap: 16px; }

  .case-thumb {
    width: 100%;
    aspect-ratio: 1 / 1;
    border-radius: 8px;
    background: ${INK};
    background-size: cover;
    background-position: center;
  }

  /* Slide card CTA button and icon chip, split by a notch matching the download action. */
  .case-cta {
    display: flex;
    gap: 4px;
    text-decoration: none;
    margin-top: auto;
  }
  .case-cta:hover { filter: brightness(1.25); }

  .case-cta span:first-child,
  .case-cta-label {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    text-align: center;
    padding: 13px 14px;
    border-radius: 8px;
    background: var(--cta-bg, ${CTA_COLOR});
    color: ${BRAND};
    font-family: var(--mono);
    font-size: 12.5px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .case-cta span:last-child,
  .case-cta-icon {
    flex: 0 0 44px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 8px;
    background: var(--cta-bg, ${CTA_COLOR});
    color: ${BRAND};
    font-family: var(--mono);
    font-size: 24px;
    line-height: 1;
  }

  .case-body { flex: 1; padding: 24px 26px 22px 14px; display: flex; flex-direction: column; justify-content: space-between; }
  .case-content { display: flex; flex-direction: column; }

  .case-kicker {
    margin: 0 0 10px;
    font-family: var(--mono);
    font-size: 12px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--kicker-color, rgba(248, 245, 236, 0.85));
  }

  .case-title { margin: 0 0 12px; font-size: 20px; font-weight: 700; line-height: 1.25; }
  .case-text  { margin: 0; font-size: 14.5px; line-height: 1.55; opacity: 0.92; }

  .case-byline { margin-top: auto; padding-top: 14px; display: flex; flex-direction: column; gap: 3px; }
  .case-name  { margin: 0; font-size: 15px; font-weight: 700; line-height: 1.25; }
  .case-role  {
    margin: 0;
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    opacity: 0.85;
  }

  /* --- Tagline variant (the flat yellow page) ----------------------------- */

  .tagline {
    max-width: 540px;
    margin: -6px 0 0;
    font-family: var(--display);
    font-size: clamp(38px, 3.2vw, 46px);
    font-weight: 400;
    line-height: 1.12;
    letter-spacing: -0.015em;
    color: var(--tagline-color, ${INK});
    white-space: normal;
    overflow: visible;
    text-overflow: clip;
  }

  /* --- Wordmark ----------------------------------------------------------- */

  .wordmark {
    position: relative;
    margin: 40px 0 0;
    margin-left: clamp(-20px, -2vw, 0px);
    height: clamp(120px, 19vw, 260px);
    color: #062022;
    opacity: 1;
    pointer-events: none;
  }
  .wordmark svg { height: 100%; width: auto; display: block; fill: #062022; }

  /* --- Carousel & Indicator Dots ------------------------------------------ */

  .carousel-area {
    flex: 1;
    max-width: 660px;
    display: flex;
    flex-direction: column;
  }

  .carousel-slides {
    position: relative;
    width: 100%;
    min-height: 400px;
  }

  .carousel-slide {
    width: 100%;
    min-height: 400px;
    display: flex;
    flex-direction: column;
    transition: opacity 0.25s ease;
  }

  .carousel-slide:not(.active) {
    display: none;
    opacity: 0;
  }

  .carousel-slide.active {
    display: flex;
    opacity: 1;
  }

  .carousel-slide .case {
    flex: 1;
    width: 100%;
    min-height: 400px;
  }

  /* Text-only / statement slide layout */
  .carousel-slide.slide-text {
    justify-content: center;
  }

  .carousel-slide .tagline,
  .slide-text .tagline {
    flex: 1;
    display: flex;
    align-items: center;
    max-width: 540px;
    margin: 0;
    min-height: 400px;
    font-family: var(--display);
    font-size: clamp(38px, 3.2vw, 46px);
    font-weight: 400;
    line-height: 1.12;
    letter-spacing: -0.015em;
    color: var(--tagline-color, ${INK});
    white-space: normal;
    overflow: visible;
    text-overflow: clip;
  }

  .carousel-nav {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    margin-top: 18px;
    padding-left: 2px;
  }

  .carousel-arrow {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: transparent;
    color: var(--nav-color, ${BRAND});
    cursor: pointer;
    opacity: 0.65;
    transition: opacity 0.15s ease, transform 0.15s ease;
  }

  .carousel-arrow:hover {
    opacity: 1;
    transform: scale(1.15);
  }

  .carousel-dots {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .carousel-dot {
    width: 8px;
    height: 8px;
    border-radius: 4px;
    border: 1.5px solid var(--nav-color, ${BRAND});
    background: transparent;
    padding: 0;
    cursor: pointer;
    position: relative;
    opacity: 0.55;
    transition: width 0.25s cubic-bezier(0.4, 0, 0.2, 1),
                background 0.2s ease,
                border-color 0.2s ease,
                opacity 0.2s ease;
  }

  /* Extended hit target for touch accessibility */
  .carousel-dot::before {
    content: "";
    position: absolute;
    inset: -8px;
  }

  .carousel-dot:hover {
    opacity: 0.9;
    transform: scale(1.15);
  }

  .carousel-dot.active {
    width: 24px;
    height: 8px;
    background: var(--nav-color, ${BRAND});
    border-color: var(--nav-color, ${BRAND});
    opacity: 1;
    cursor: default;
    transform: none;
  }

  @media (max-width: 900px) {
    /* The case card is dropped on phones rather than stacked: it's promotional,
       and the person is here to collect a file. The page falls back to the flat
       yellow variant so there's no background photo to download either. */
    .backdrop { display: none; }
    body { background: ${BRAND}; }
    .case, .tagline, .carousel-area { display: none; }
    .stage { padding: 28px 20px 0; }
    .panels { display: block; }
    .card { max-width: none; }
    .wordmark { color: #062022; opacity: 1; height: clamp(90px, 26vw, 150px); }
  }

  @media (prefers-reduced-motion: reduce) {
    * { transition: none !important; animation: none !important; }
  }
`;

const CAROUSEL_SCRIPT = `
<script>
(function() {
  var area = document.querySelector('.carousel-area');
  if (!area) return;
  var slides = area.querySelectorAll('.carousel-slide');
  var dots = area.querySelectorAll('.carousel-dot');
  if (slides.length <= 1) return;

  var prevBtn = area.querySelector('.carousel-prev');
  var nextBtn = area.querySelector('.carousel-next');
  var backdrop = document.querySelector('.backdrop');
  var current = 0;

  function show(index) {
    if (index < 0 || index >= slides.length || index === current) return;
    slides[current].classList.remove('active');
    slides[current].style.display = 'none';
    if (dots[current]) {
      dots[current].classList.remove('active');
      dots[current].removeAttribute('aria-current');
    }

    current = index;
    var next = slides[current];
    next.style.display = 'flex';
    void next.offsetWidth;
    next.classList.add('active');
    if (dots[current]) {
      dots[current].classList.add('active');
      dots[current].setAttribute('aria-current', 'true');
    }

    var bg = next.getAttribute('data-bg');
    if (bg) {
      if (!backdrop) {
        backdrop = document.createElement('div');
        backdrop.className = 'backdrop';
        document.body.insertBefore(backdrop, document.body.firstChild);
      }
      backdrop.style.backgroundImage = "url('" + bg + "')";
      backdrop.style.display = 'block';
    } else if (backdrop) {
      backdrop.style.display = 'none';
    }

    var pageColor = next.getAttribute('data-page-color');
    if (pageColor) document.body.style.setProperty('--stage-bg', pageColor);
    var caseColor = next.getAttribute('data-case-color');
    if (caseColor) document.body.style.setProperty('--case-bg', caseColor);
    var ctaBg = next.getAttribute('data-cta-bg');
    if (ctaBg) document.body.style.setProperty('--cta-bg', ctaBg);
    var caseText = next.getAttribute('data-case-text');
    if (caseText) document.body.style.setProperty('--case-text', caseText);
    var kickerColor = next.getAttribute('data-kicker-color');
    if (kickerColor) document.body.style.setProperty('--kicker-color', kickerColor);
    var taglineColor = next.getAttribute('data-tagline-color');
    if (taglineColor) document.body.style.setProperty('--tagline-color', taglineColor);
    var navColor = next.getAttribute('data-nav-color');
    if (navColor) document.body.style.setProperty('--nav-color', navColor);
  }

  dots.forEach(function(dot, i) {
    dot.addEventListener('click', function() { show(i); });
  });

  if (prevBtn) {
    prevBtn.addEventListener('click', function() {
      show((current - 1 + slides.length) % slides.length);
    });
  }

  if (nextBtn) {
    nextBtn.addEventListener('click', function() {
      show((current + 1) % slides.length);
    });
  }

  document.addEventListener('keydown', function(e) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
    if (e.key === 'ArrowRight') show((current + 1) % slides.length);
    if (e.key === 'ArrowLeft') show((current - 1 + slides.length) % slides.length);
  });

  var startX = 0;
  area.addEventListener('touchstart', function(e) {
    if (e.changedTouches && e.changedTouches[0]) startX = e.changedTouches[0].screenX;
  }, {passive: true});

  area.addEventListener('touchend', function(e) {
    if (!e.changedTouches || !e.changedTouches[0]) return;
    var diff = e.changedTouches[0].screenX - startX;
    if (diff < -40) show((current + 1) % slides.length);
    if (diff > 40) show((current - 1 + slides.length) % slides.length);
  }, {passive: true});
})();
</script>`;

/**
 * @param {object} slide  see slides.js — may be null, in which case the page
 *                        falls back to the flat yellow tagline variant.
 */
const layout = ({ title, body, slide, navColor = BRAND, hasCarousel = false }) => {
  const background = slide?.backgroundUrl
    ? `<div class="backdrop" style="background-image:url('${safeUrl(slide.backgroundUrl)}')"></div>`
    : '';

  // Every colour is overridable per slide, so a slide can be tuned to its own
  // photograph without a deploy. Anything left unset falls back to the brand
  // default in the stylesheet.
  const opacity = Number(slide?.caseOpacity);
  const stageStyle = [
    `--stage-bg:${safeColor(slide?.pageColor, BRAND)}`,
    `--case-bg:${withAlpha(
      safeColor(slide?.caseColor, CASE_CARD),
      Number.isFinite(opacity) ? opacity : CASE_OPACITY
    )}`,
    `--cta-bg:${safeColor(slide?.ctaColor, CTA_COLOR)}`,
    `--case-text:${safeColor(slide?.caseTextColor, SAND)}`,
    `--kicker-color:${safeColor(slide?.kickerColor || slide?.tagColor, '')}`,
    `--tagline-color:${safeColor(slide?.taglineColor, INK)}`,
    `--nav-color:${navColor}`,
  ].filter(Boolean).join(';');

  return `<!doctype html>
<html lang="no">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="light">
<title>Drop Involve${title ? ` – ${escapeHtml(title)}` : ''}</title>
${FONTS}
<style>${CSS}</style>
</head>
<body style="${stageStyle}">
  ${background}
  <div class="stage">
    <div class="panels">
      ${body}
    </div>
    <div class="wordmark">${WORDMARK}</div>
  </div>
  ${hasCarousel ? CAROUSEL_SCRIPT : ''}
</body>
</html>`;
};

/** The right-hand promotional card. Omitted when there's no slide to show. */
const caseCard = (slide) => {
  if (!slide || !slide.title) return '';

  const thumb = slide.thumbUrl
    ? `style="background-image:url('${safeUrl(slide.thumbUrl)}')"`
    : '';

  return `
    <div class="case">
      <div class="case-media">
        <div class="case-thumb" ${thumb}></div>
        ${slide.ctaUrl ? `
          <a class="case-cta" href="${safeUrl(slide.ctaUrl)}" target="_blank" rel="noopener noreferrer">
            <span class="case-cta-label">${escapeHtml(slide.ctaLabel || 'Les mer')}</span>
            <span class="case-cta-icon" aria-hidden="true">+</span>
          </a>
        ` : ''}
      </div>
      <div class="case-body">
        <div class="case-content">
          ${slide.kicker ? `<p class="case-kicker"${slide.kickerColor || slide.tagColor ? ` style="color:${safeColor(slide.kickerColor || slide.tagColor, '')};"` : ''}>${escapeHtml(slide.kicker)}</p>` : ''}
          <h2 class="case-title">${escapeHtml(slide.title)}</h2>
          <p class="case-text">${escapeHtml(slide.body || '')}</p>
        </div>
        ${slide.personName || slide.personRole ? `
          <div class="case-byline">
            ${slide.personName ? `<p class="case-name">${escapeHtml(slide.personName)}</p>` : ''}
            ${slide.personRole ? `<p class="case-role">${escapeHtml(slide.personRole)}</p>` : ''}
          </div>
        ` : ''}
      </div>
    </div>`;
};

/**
 * The page a recipient lands on. Replaces the bare redirect so there's a
 * branded, explanatory step before the download — they can see what they're
 * getting and who from before committing to it.
 */
const landingPage = ({
  shortId, fileName, fileSize, senderEmail, message, expiresAt, hasPassword, error, token, slide, slides,
}) => {
  const type = describeType(fileName);
  const size = formatBytes(fileSize);
  const meta = [size, type].filter(Boolean).join(' · ');
  const expiry = formatDate(expiresAt);

  // Identifies which recipient this is, so the download receipt can name them.
  // Carried from the emailed link through to the download, since the receipt is
  // now sent from the download rather than from opening this page.
  const ref = token ? `?r=${encodeURIComponent(token)}` : '';

  const card = `
    <div class="card">
      <p class="eyebrow">DROP.INVOLVE.NO</p>

      ${senderEmail ? `
        <p class="from-label">Du har mottatt en fil fra:</p>
        <p class="from">${escapeHtml(senderEmail)}</p>
      ` : `
        <p class="from">Du har mottatt en fil</p>
      `}

      <div class="details">
        <p class="field-label">FILNAVN</p>
        <p class="filename">${escapeHtml(fileName || 'Ukjent filnavn')}</p>
        ${meta ? `<p class="field-label">STØRRELSE</p><p class="filename">${escapeHtml(meta)}</p>` : ''}
        ${message ? `
          <p class="field-label">MELDING</p>
          <p class="message">${escapeHtml(message)}</p>
        ` : ''}
      </div>

      ${hasPassword ? `
        <form method="POST" action="/s/${encodeURIComponent(shortId)}${ref}">
          <input type="password" name="password" placeholder="Passord" autocomplete="off" autofocus required>
          <div class="action">
            <button class="btn" type="submit">Åpne og last ned</button>
            <span class="btn-icon">${DOWNLOAD_ICON}</span>
          </div>
        </form>
        <p class="fine">Avsenderen har satt et passord. Du skal ha fått det på en
        annen måte enn i e-posten.</p>
      ` : `
        <div class="action">
          <a class="btn" href="/s/${encodeURIComponent(shortId)}/d${ref}">Last ned filen</a>
          <a class="btn-icon" href="/s/${encodeURIComponent(shortId)}/d${ref}" aria-hidden="true" tabindex="-1">${DOWNLOAD_ICON}</a>
        </div>
      `}

      ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
      ${expiry ? `<p class="fine">Lenken utløper ${escapeHtml(expiry)}. Filen slettes automatisk etterpå.</p>` : ''}
    </div>`;

  const slideList = Array.isArray(slides) && slides.length > 0
    ? slides
    : (slide ? [slide] : []);

  let right = '';
  if (slideList.length === 1) {
    const s = slideList[0];
    right = s.tagline ? `<p class="tagline">${escapeHtml(s.tagline)}</p>` : caseCard(s);
  } else if (slideList.length > 1) {
    const slideItems = slideList.map((s, index) => {
      const content = s.tagline
        ? `<p class="tagline">${escapeHtml(s.tagline)}</p>`
        : caseCard(s);
      const opacity = Number(s.caseOpacity);
      const isLight = !s.backgroundUrl && isLightColor(s.pageColor || (s.tagline ? BRAND : INK));
      const navColor = isLight ? '#062022' : BRAND;

      return `
        <div class="carousel-slide ${index === 0 ? 'active' : ''} ${s.tagline ? 'slide-text' : 'slide-card'}"
          data-index="${index}"
          data-bg="${safeUrl(s.backgroundUrl)}"
          data-page-color="${safeColor(s.pageColor, BRAND)}"
          data-case-color="${withAlpha(
            safeColor(s.caseColor, CASE_CARD),
            Number.isFinite(opacity) ? opacity : CASE_OPACITY
          )}"
          data-cta-bg="${safeColor(s.ctaColor, CTA_COLOR)}"
          data-case-text="${safeColor(s.caseTextColor, SAND)}"
          data-kicker-color="${safeColor(s.kickerColor || s.tagColor, '')}"
          data-tagline-color="${safeColor(s.taglineColor, INK)}"
          data-nav-color="${navColor}"
          ${index === 0 ? '' : 'style="display:none;"'}
        >
          ${content}
        </div>`;
    }).join('');

    const nav = `
      <nav class="carousel-nav" aria-label="Slide-navigasjon">
        <button type="button" class="carousel-arrow carousel-prev" aria-label="Forrige slide" title="Forrige slide">
          ${CHEVRON_LEFT}
        </button>
        <div class="carousel-dots">
          ${slideList.map((_, index) => `
            <button type="button" class="carousel-dot ${index === 0 ? 'active' : ''}" data-index="${index}" aria-label="Slide ${index + 1}" ${index === 0 ? 'aria-current="true"' : ''}></button>
          `).join('')}
        </div>
        <button type="button" class="carousel-arrow carousel-next" aria-label="Neste slide" title="Neste slide">
          ${CHEVRON_RIGHT}
        </button>
      </nav>`;

    right = `
      <div class="carousel-area">
        <div class="carousel-slides">
          ${slideItems}
        </div>
        ${nav}
      </div>`;
  }

  const initialSlide = slideList[0] || null;
  const initialIsLight = !initialSlide?.backgroundUrl && isLightColor(initialSlide?.pageColor || (initialSlide?.tagline ? BRAND : INK));
  const initialNavColor = initialIsLight ? '#062022' : BRAND;

  return layout({
    title: fileName || 'Fil klar for nedlasting',
    slide: initialSlide,
    navColor: initialNavColor,
    hasCarousel: slideList.length > 1,
    body: `${card}${right}`,
  });
};

/** Link expired, deleted, or never existed. Deliberately doesn't distinguish. */
const expiredPage = () =>
  layout({
    title: 'Lenken er utløpt',
    body: `
      <div class="card">
        <p class="eyebrow">DROP.INVOLVE.NO</p>
        <p class="from">Lenken er utløpt</p>
        <div class="details">
          <p class="message">Filer på Drop slettes automatisk etter en tid, og lenken virker derfor ikke lenger.

Ta kontakt med avsenderen for å få en ny lenke.</p>
        </div>
      </div>`,
  });

/** Anything else that goes wrong. */
const errorPage = ({ title = 'Noe gikk galt', message = 'Prøv igjen senere.' }) =>
  layout({
    title,
    body: `
      <div class="card">
        <p class="eyebrow">DROP.INVOLVE.NO</p>
        <p class="from">${escapeHtml(title)}</p>
        <div class="details"><p class="message">${escapeHtml(message)}</p></div>
      </div>`,
  });

module.exports = { landingPage, expiredPage, errorPage, escapeHtml, formatBytes };
