/**
 * The palette, in one place (FR-U2).
 *
 * The client has two renderers — the DOM and a WebGL canvas — and they cannot
 * share a stylesheet: CSS custom properties are strings the browser resolves,
 * Pixi wants numbers. Before this file the two kept their own copies, and 99
 * hex literals were spread across `styles.css`, `sim/model.ts` and
 * `sim/sprites.ts`. That is precisely how the office and the panels drift into
 * disagreeing about what "working" looks like.
 *
 * So the palette is declared here as data, once, and both consumers derive from
 * it: `applyTheme` writes it onto `:root` as custom properties for the DOM, and
 * `toPixiColour` converts the same values for the canvas. Neither side is
 * allowed a colour of its own — the Phase 8 exit criterion is that no second
 * copy of a colour value exists in the client.
 *
 * ## The direction
 *
 * A dark neon terminal (PLAN.md §2.6). Near-black ground with a slight blue
 * bias rather than pure `#000`, because pure black makes neon accents vibrate
 * against it and gives the glow nothing to sit on. Accents are a small set of
 * phosphor hues, used sparingly: on a dark ground, saturated colour reads as
 * *meaning*, so spending it on decoration leaves nothing for status.
 */

export type ThemeMode = 'dark' | 'light';

/** Every themeable colour in the chrome. Keys become `--ao-<kebab>` variables. */
export interface ThemeTokens {
  bg: string;
  surface: string;
  surfaceRaised: string;
  sunken: string;

  ink: string;
  inkSoft: string;
  inkMute: string;

  /** Hairline dividers between sections. Decoration — carries no information. */
  line: string;
  /**
   * The border of an interactive control — text inputs, selects, textareas and
   * buttons all draw their outline in this.
   *
   * That makes it the *boundary of a UI component*, which WCAG 2.1 §1.4.11
   * requires to clear 3:1 against its adjacent surface, and it did not: at its
   * original `#2c3746` / `#b3bdc8` it measured 1.41–1.90:1 across the four
   * grounds in both themes. It had been filed alongside `line` as decorative,
   * and for a divider that is true; for the edge that tells you where a text
   * field begins it is not — remove it and there is no other cue that the
   * field is there at all. `status.test.ts` now grades it against 3:1 on every
   * ground rather than exempting it.
   */
  lineFirm: string;

  /** The single primary accent. Everything else is status. */
  accent: string;
  accentDim: string;

  /** Semantic status hues — see `status.ts` for the status→token mapping. */
  statusIdle: string;
  statusPlanning: string;
  statusWaiting: string;
  statusActive: string;
  statusFinishing: string;
  statusGood: string;
  statusBad: string;
  statusStopped: string;
}

/**
 * Dark is the designed theme; light is the fallback (FR-U7).
 *
 * The light variant is deliberately restrained rather than a naive inversion —
 * neon on white is illegible, so the accents darken to their ink-safe siblings
 * while keeping the same hue relationships, so status stays recognisable to
 * someone who switches.
 *
 * ## Contrast (FR-U4)
 *
 * Every token that can carry text — `ink`, `inkSoft`, `inkMute`, `accent` and
 * all eight `status*` — clears WCAG AA for normal text (4.5:1) against **all
 * four** ground tokens, not just `bg`. That matters: panels sit on
 * `surfaceRaised` and badges on `sunken`, so `bg` is not the hardest ground a
 * colour actually lands on. In dark the worst case is `surfaceRaised`, in light
 * it is `sunken`, and several values here were retuned specifically to clear
 * those rather than the easier `bg` they were first drawn against.
 * `status.test.ts` enforces the full grid, so a "small" palette tweak that
 * drops a pair below AA fails the build rather than shipping.
 */
export const THEMES: Record<ThemeMode, ThemeTokens> = {
  dark: {
    bg: '#0b0e12',
    surface: '#11161d',
    surfaceRaised: '#161d26',
    sunken: '#070a0d',

    ink: '#d8e3ee',
    inkSoft: '#9fb2c4',
    inkMute: '#8394a8',

    line: '#1e2732',
    lineFirm: '#5b6b80',

    accent: '#2ee6d6',
    accentDim: '#1b8f86',

    statusIdle: '#8394a8',
    statusPlanning: '#a98cff',
    statusWaiting: '#ffb347',
    statusActive: '#2ee6d6',
    statusFinishing: '#5fb0ff',
    statusGood: '#47e07a',
    statusBad: '#ff6470',
    statusStopped: '#82878f',
  },
  light: {
    bg: '#f2f5f8',
    surface: '#ffffff',
    surfaceRaised: '#ffffff',
    sunken: '#e6ebf0',

    ink: '#12181f',
    inkSoft: '#3d4854',
    inkMute: '#55616e',

    line: '#d3dae2',
    lineFirm: '#74828f',

    accent: '#0b665e',
    accentDim: '#08453f',

    statusIdle: '#55616e',
    statusPlanning: '#5b3fb8',
    statusWaiting: '#8a5a08',
    statusActive: '#0b665e',
    statusFinishing: '#1f5fa8',
    statusGood: '#186e37',
    statusBad: '#b32432',
    statusStopped: '#4a5663',
  },
};

/**
 * The office's own palette, which does **not** follow the light theme.
 *
 * ## Why this stopped being a CRT (Phase 10)
 *
 * Phase 8 painted the office in the chrome's own near-blacks on the argument
 * that "a CRT is a screen, and a screen is dark whatever the room is". The
 * argument is sound and the result was wrong, because the office is not a
 * readout of a machine — it is a depiction of a *place*, and a room rendered in
 * four shades of the same near-black reads as a wireframe of an office rather
 * than an office. Everything that makes a room legible at a glance (which
 * surface is floor, which is wall, which is furniture) was carried by two
 * near-identical tile shades and nothing else.
 *
 * So the office now has a room's palette: warm wood underfoot, a cool dark wall
 * behind, and furniture that is a different *material* from both rather than a
 * different brightness of the same one. The values are measured off the
 * reference the direction came from rather than picked by eye — the floor,
 * wall, wood and carpet entries below are literal samples.
 *
 * The chrome is untouched. `THEMES` is still the dark neon terminal of FR-U1,
 * and the office still does not follow the light theme (inverting it would mean
 * regenerating every sprite texture on a theme switch, for a result nobody
 * asked for). What changed is that the canvas is now allowed to look like the
 * thing it depicts instead of like the panels around it. The screens on the
 * desks keep the phosphor green — that is the one place the old identity is
 * actually true, because those genuinely are screens.
 */
export const OFFICE = {
  /** Letterbox around the room, where the floor does not reach. */
  background: '#0b0f15',

  // -- the room's shell ----------------------------------------------------

  /** Wall face. The reference's dark navy, sampled. */
  wall: '#151e28',
  /** The lit band along the top of the wall, where the decor hangs. */
  wallTop: '#28374b',
  /** Skirting board where the wall meets the floor — the room's one hard edge. */
  wallTrim: '#3a4a61',
  /**
   * Floorboards, in two tones laid as a brick bond.
   *
   * They kept their `floorLight`/`floorDark` names through the repaint: the
   * renderer's job ("alternate two floor tones") did not change, only which two.
   */
  floorLight: '#734728',
  floorDark: '#694124',
  /** The seam between two boards. Darker than either, so boards read as laid. */
  floorSeam: '#5c391f',
  /** The rug under the Manager's desk, and the lounge floor. */
  carpet: '#3e6a90',
  carpetDark: '#325474',

  // -- furniture -----------------------------------------------------------

  desk: '#b38856',
  deskEdge: '#8a6540',
  /** Underside of a desk. Darker than `desk`, so furniture reads as solid. */
  deskLeg: '#5c391f',
  /** Grander wood, and the one visual cue that a desk is the Manager's. */
  managerDesk: '#cfa86d',
  managerDeskEdge: '#a07a44',
  /** The chair a seated character sits on. */
  chair: '#4a5663',
  chairDark: '#333c47',
  /** The monitor every desk now carries — the clearest "this is a workstation". */
  monitor: '#d0d0d0',
  monitorDark: '#8b9096',
  screen: '#323232',
  /** The one place the terminal identity is literally true: these are screens. */
  screenGlow: '#7fe0a8',
  /** Potted plants, the reference's most recognisable furnishing. */
  plant: '#215137',
  plantLight: '#2f7a4e',
  plantPot: '#8a4b2f',
  /** Bookshelf carcass, and the spines on it. */
  shelf: '#5c391f',
  shelfBooks: '#b5453f',
  shelfBooksAlt: '#3f6fb5',
  /** Framed art on the wall. */
  frame: '#8a6540',
  /** The lounge couch. */
  couch: '#972651',
  couchLight: '#c25769',

  // -- text and overlays ---------------------------------------------------

  /**
   * The opaque panel every desk plate is printed on.
   *
   * New in Phase 10, and it is a legibility fix rather than decoration. Plate
   * text used to sit directly on the floor, which worked only because the floor
   * was near-black: on the wood below, the old `plateDetail` measured **2.18:1**
   * — well under WCAG AA — and the only ways to fix that without a panel were to
   * lighten the detail lines until they matched the name (destroying the
   * hierarchy that makes a floor of desks scannable) or to abandon the repaint.
   *
   * The panel is drawn **fully opaque**, not tinted: a translucent one would
   * make the true ground a blend of this and whatever board happened to be
   * underneath, and a contrast test against `plateBg` would then be measuring a
   * colour that never actually appears. `scene.test.ts` pins the alpha at 1 for
   * exactly that reason.
   */
  plateBg: '#101823',
  /** Hairline around the plate panel, so it reads as a card and not a hole. */
  plateEdge: '#2b3644',
  nameplate: '#e6edf5',
  /**
   * The desk plate's secondary lines — model, current tool, spend (FR-S10).
   *
   * Deliberately dimmer than `nameplate`: 8.19:1 against the plate panel, to
   * the name's 15.1:1. Both clear WCAG AA for normal text — this is real
   * information, not decoration, so it is held to the same 4.5:1 bar as the DOM
   * chrome and `sim/officeText.test.ts` enforces it. The gap between the two is
   * what makes a floor of desks scannable by name: the name is what you search
   * for, the detail is what you read once you have found the desk.
   */
  plateDetail: '#9fb2c4',
  /** Sprite outlines and pupils. True black, as the reference draws them — and
   *  its own token: an outline that tracked the backdrop would vanish the
   *  moment the backdrop was retuned. */
  outline: '#000000',
  /**
   * The white of a character's eye.
   *
   * A structural detail of "this is a person" rather than part of any agent's
   * identity, so it sits here beside `outline` instead of in `SPRITE_RAMP`. It
   * earns a token of its own because it is the single highest-value pixel pair
   * in the whole sprite: a face drawn with two dark dots reads as a smudge at
   * 16px, and the same face with a light sclera behind a dark pupil reads
   * unmistakably as a face. The reference art spends its contrast the same way.
   *
   * Not `paper`, despite being a near-white: an eye and a sheet of paper have
   * no reason to move together, and aliasing them would mean a future warm-up
   * of the report page silently tinting everybody's eyes.
   */
  eyeWhite: '#f4f6f8',
  /** Ruled lines on a carried report page, dimmer than the page itself. */
  paperLine: '#8a8f99',
  paper: '#e1e3e9',
  selection: '#2ee6d6',
  /** Cast under a desk whose agent is currently working. Warm now rather than
   *  cyan: on a wood floor the old accent read as a spill, not a lamp. */
  workGlow: '#ffc766',
} as const;

/**
 * Per-agent sprite ramps (FR-S2, FR-U3).
 *
 * Phase 8 made these phosphor hues so the characters read as part of the
 * terminal; Phase 10 makes them people, for the same reason the room stopped
 * being a CRT. Cyan hair on a mint face is *distinguishable* — which is all
 * FR-S2 literally asks — but it is not recognisable, and recognisability is the
 * point of deriving appearance from the agent's name at all. A reader is meant
 * to learn "the one with the ginger hair is the reviewer", and that only works
 * if the ramps describe something a person already has a word for.
 *
 * The *structure* is untouched: `sim/model.ts` still slices one hash across
 * four independent ramps, so this remains a palette swap rather than a change
 * to sprite generation, exactly as FR-U3 requires. Only the entry counts moved
 * — hair gains two — and `appearanceFor` reads `.length` rather than a constant,
 * so nothing needed to change alongside it.
 *
 * Still deliberately quieter than the status hues. A desk full of characters
 * must never out-shout the one badge saying something failed, which is why the
 * shirts stay mid-tone and none of these is a saturated red or green.
 */
export const SPRITE_RAMP = {
  /** Face/hands. A real range of skin tones, light to deep. */
  skin: ['#f0cdae', '#e8b891', '#d29a70', '#a9714a', '#75462c'],
  /**
   * Hair. The most varied ramp, since it carries most of the recognisability.
   *
   * The dark entry is `#2e2a33` rather than the near-black it wants to be, and
   * that is deliberate. Phase 10 gave every character a 1px `OFFICE.outline`
   * border, and `outline` is true `#000000` — so a black-haired agent rendered
   * as one undifferentiated dark blob where its head should be, losing the
   * silhouette that is the entire point of having six hair shapes. Dark enough
   * to read as black hair, light enough to survive being outlined in black.
   */
  hair: ['#8a5a2b', '#d9a441', '#2e2a33', '#d8d8d8', '#5c3317', '#a63a2b'],
  /** Torso. Mid-tone, never fully saturated. */
  shirt: ['#2f4a7a', '#2b2b31', '#b2591f', '#93343a', '#c9ccd2', '#5d6570', '#2c6b4a', '#6d3f5f'],
  /** Legs. Darkest ramp, so characters sit on the floor rather than float. */
  trousers: ['#26303f', '#3a2b20', '#3f444d', '#1f1f24'],
} as const;

/** `#2ee6d6` → `0x2ee6d6`, for Pixi. */
export function toPixiColour(hex: string): number {
  const cleaned = hex.replace('#', '');
  const expanded =
    cleaned.length === 3
      ? cleaned
          .split('')
          .map((c) => c + c)
          .join('')
      : cleaned;
  const value = Number.parseInt(expanded, 16);
  // A malformed token must not paint the office black and leave no trace; the
  // magenta is deliberately hideous so it is noticed rather than shipped.
  return Number.isNaN(value) ? 0xff00ff : value;
}

/** `surfaceRaised` → `--ao-surface-raised`. */
export function cssVariableName(token: keyof ThemeTokens): string {
  return `--ao-${token.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

/**
 * Write the palette onto the document root.
 *
 * Custom properties rather than swapping a stylesheet, so a theme change is one
 * repaint and no flash of restyled content — and so the CSS can be written
 * against names instead of values, which is what stops a colour being copied
 * back into it.
 */
export function applyTheme(mode: ThemeMode, root: HTMLElement): void {
  const tokens = THEMES[mode];
  for (const key of Object.keys(tokens) as (keyof ThemeTokens)[]) {
    root.style.setProperty(cssVariableName(key), tokens[key]);
  }
  // Exposed so CSS can branch on the mode for the few things a colour token
  // cannot express (border weights, shadow presence).
  root.dataset['aoTheme'] = mode;
}
