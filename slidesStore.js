/**
 * Where the landing-page slides live.
 *
 * One JSON object in the data bucket holding the whole list, not one object per
 * slide. There are five or six of them, edited a few times a month, and read on
 * every download page — so a single small read that can be cached beats a
 * listing plus N gets.
 *
 * The data bucket has no lifecycle rule. Putting these in the file bucket would
 * have them silently deleted after 8 days, which is the bug that prompted the
 * split in the first place.
 */

const SLIDES_KEY = 'slides/index.json';

// Read on every landing-page view, so it can't hit R2 each time. A minute is
// long enough to matter and short enough that an editor doesn't sit wondering
// whether their change took.
const CACHE_MS = 60 * 1000;

// Caps, so a paste accident can't produce a 40 MB JSON object that then has to
// be read on every download page.
const LIMITS = {
  slides: 40,
  kicker: 60,
  title: 120,
  body: 1200,
  ctaLabel: 40,
  ctaUrl: 500,
  personName: 80,
  personRole: 80,
  tagline: 400,
  url: 500,
  colour: 32,
  id: 64,
};

const text = (value, max) =>
  typeof value === 'string' ? value.trim().slice(0, max) : '';

/**
 * Normalises whatever the admin screen sent into the shape the page expects.
 *
 * Deliberately allow-list rather than pass-through: the page inlines several of
 * these values into a style attribute, and an unexpected field arriving intact
 * is how that becomes someone else's problem later.
 */
const cleanSlide = (raw = {}, index = 0) => ({
  id: text(raw.id, LIMITS.id) || `slide-${index + 1}`,
  enabled: raw.enabled !== false,

  tagline: text(raw.tagline, LIMITS.tagline),

  kicker: text(raw.kicker, LIMITS.kicker),
  title: text(raw.title, LIMITS.title),
  body: text(raw.body, LIMITS.body),
  ctaLabel: text(raw.ctaLabel, LIMITS.ctaLabel),
  ctaUrl: text(raw.ctaUrl, LIMITS.ctaUrl),
  personName: text(raw.personName, LIMITS.personName),
  personRole: text(raw.personRole, LIMITS.personRole),

  backgroundUrl: text(raw.backgroundUrl, LIMITS.url),
  thumbUrl: text(raw.thumbUrl, LIMITS.url),

  // Colours are validated again at render time — this only bounds the length.
  pageColor: text(raw.pageColor, LIMITS.colour),
  caseColor: text(raw.caseColor, LIMITS.colour),
  ctaColor: text(raw.ctaColor, LIMITS.colour),
  caseTextColor: text(raw.caseTextColor, LIMITS.colour),
  taglineColor: text(raw.taglineColor, LIMITS.colour),
  caseOpacity:
    Number.isFinite(Number(raw.caseOpacity))
      ? Math.min(Math.max(Number(raw.caseOpacity), 0), 1)
      : undefined,

  updatedAt: Date.now(),
  updatedBy: text(raw.updatedBy, 120),
});

const createSlideStore = ({ readJson, writeJson, fallback = [] }) => {
  let cache = null;      // { slides, at }
  let configured = null; // whether an index exists at all

  /**
   * Until someone saves for the first time there is no index, and an empty
   * landing page would look broken rather than intentional — so the built-in
   * placeholders stand in. Once an index exists it is authoritative, including
   * when it's an empty list: deleting every slide has to mean no slides, not a
   * resurrection of the defaults.
   */
  const load = async ({ force = false } = {}) => {
    if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.slides;

    let slides;
    try {
      const stored = await readJson(SLIDES_KEY);
      configured = Array.isArray(stored);
      slides = configured ? stored.map((slide, i) => cleanSlide(slide, i)) : fallback;
    } catch (error) {
      console.warn('[slides] could not read, using last known list:', error.message);
      slides = cache?.slides || fallback;
    }

    cache = { slides, at: Date.now() };
    return slides;
  };

  const save = async (rawSlides, editor) => {
    if (!Array.isArray(rawSlides)) throw new Error('slides must be an array');

    const slides = rawSlides
      .slice(0, LIMITS.slides)
      .map((slide, i) => cleanSlide({ ...slide, updatedBy: editor }, i));

    await writeJson(SLIDES_KEY, slides);
    cache = { slides, at: Date.now() };
    configured = true;
    return slides;
  };

  return { load, save, isConfigured: () => configured };
};

module.exports = { createSlideStore, cleanSlide, SLIDES_KEY };
