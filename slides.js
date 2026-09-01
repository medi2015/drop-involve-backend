/**
 * The rotating showcase on the recipient landing page.
 *
 * One slide is picked at random per visit, so a recipient opening two links
 * sees two different things. There is deliberately no carousel: the person is
 * here to collect a file, and every extra background image is weight on a page
 * that has to open fast for someone outside Involve.
 *
 * These are placeholders taken from the design mockup. They are replaced by
 * records in R2 once the admin screen exists — see PLACEHOLDER_SLIDES below for
 * the shape each record takes.
 *
 * Fields:
 *   tagline       flat variant only: the agency line, shown instead of a case
 *   kicker        small label above the heading, e.g. "MÅNEDENS CASE"
 *   title         heading
 *   body          paragraph
 *   ctaLabel      button text, e.g. "SE CASET HER"
 *   ctaUrl        where the button goes — an involve.no case page
 *   personName    who to credit
 *   personRole    their title
 *   thumbUrl      square image beside the text
 *   backgroundUrl full-bleed photo behind everything
 *   pageColor     background colour when there is no photo
 *   caseColor     override for the dark card, if a slide needs one
 */

const BRAND = '#F5FF8C';
const INK = '#003F46';

/**
 * Six variants from the mockup. The first is the flat yellow tagline page with
 * no case card; the rest carry one.
 *
 * Images are absent on purpose — inventing photographs of colleagues would be
 * worse than an obvious gap. The layout and type are real; drop images in
 * through the admin and they appear.
 */
const PLACEHOLDER_SLIDES = [
  {
    id: 'tagline',
    pageColor: BRAND,
    tagline:
      'Det lille kommunikasjonshuset for virksomheter som ønsker bredden til et stort byrå – uten kompleksiteten',
  },
  {
    id: 'case-norseman',
    pageColor: INK,
    kicker: 'Månedens case',
    title: 'Ikke for alle',
    body:
      'Norseman er et av verdens tøffeste løp – rått, ubarmhjertig og helt fantastisk å følge på nært hold. Vi jobbet tett med kunden og satte sammen sponsoravtale, følgebiler og eget Range Rover-team, og var på plass gjennom hele løpet.',
    ctaLabel: 'Se caset her',
    ctaUrl: 'https://involve.no',
    personName: 'Celine Sagenes',
    personRole: 'Kreativ leder',
  },
  {
    id: 'innsikt-hjemmekontor',
    pageColor: INK,
    kicker: 'Innsikt',
    title: 'Månedens snækkis',
    body:
      'Hjemmekontor eller ikke hjemmekontor? Nye tall viser at Norge er dønn uenige. Vi tror ikke løsningen er strengere regler, men bedre svar på "hvorfor" – det er der god rådgivning starter.',
    ctaLabel: 'Les mer om saken',
    ctaUrl: 'https://involve.no',
    personName: 'Kjetil Væhle',
    personRole: 'Kommunikasjonsrådgiver',
  },
  {
    id: 'inspirert',
    pageColor: INK,
    kicker: 'Inspirert',
    title: 'Godt håndverk tar tid',
    body:
      'De beste kampanjene ser enkle ut når de er ferdige. Bak enkelheten ligger research, tydelige valg og et team som tør å kutte det som ikke virker.',
    ctaLabel: 'La deg inspirere',
    ctaUrl: 'https://involve.no',
    personName: 'Marita Lindstadhagen',
    personRole: 'Innholdsprodusent',
  },
  {
    id: 'frokostseminar',
    pageColor: INK,
    kicker: 'Frokostseminar',
    title: 'Hva ligger bak suksessen til Fotball-VM?',
    body:
      'Norge tok hele verden med storm i sommerens fotball-VM. Vi inviterer til frokostseminar om hva som faktisk ligger bak – fra lagbygging til historiefortelling. Hør det direkte fra de som var med å skape eventyret.',
    ctaLabel: 'Meld deg på her',
    ctaUrl: 'https://involve.no',
    personName: 'Linn Tidemandsen',
    personRole: 'Byråleder',
  },
  {
    id: 'jobb',
    pageColor: INK,
    kicker: 'Vi vokser',
    title: 'Vil du jobbe med oss?',
    body:
      'Vi ser alltid etter folk som er nysgjerrige, grundige og hyggelige å jobbe med. Har du lyst til å ta en prat, er døra åpen – også når vi ikke har en stilling utlyst.',
    ctaLabel: 'Se ledige stillinger',
    ctaUrl: 'https://involve.no',
    personName: 'Linn Tidemandsen',
    personRole: 'Byråleder',
  },
];

/**
 * Picks one slide for this visit.
 *
 * Returns null rather than throwing if there's nothing to show — the page then
 * renders the download card on a flat brand background, which is a perfectly
 * good page and not an error state.
 */
const pickSlide = (slides = PLACEHOLDER_SLIDES) => {
  try {
    const enabled = (Array.isArray(slides) ? slides : []).filter(
      (slide) => slide && slide.enabled !== false
    );
    if (enabled.length === 0) return null;
    return enabled[Math.floor(Math.random() * enabled.length)];
  } catch (error) {
    console.warn('[slides] could not pick a slide:', error.message);
    return null;
  }
};

/**
 * Renders with a slide, and without one if that fails.
 *
 * /s/:id is the path people outside Involve use to collect their file. A
 * malformed slide record, a bad colour, a missing image — none of that is worth
 * a client being unable to download. So the showcase is attempted, and if
 * anything throws, the same page renders with no slide at all: still branded,
 * still correct, just quieter. The recipient gets their file either way and we
 * get a log line telling us which slide to fix.
 */
const renderWithSlide = (render, slide) => {
  if (slide) {
    try {
      return render(slide);
    } catch (error) {
      console.error(`[slides] "${slide.id || 'unknown'}" failed to render:`, error.message);
    }
  }
  return render(null);
};

module.exports = { PLACEHOLDER_SLIDES, pickSlide, renderWithSlide };
