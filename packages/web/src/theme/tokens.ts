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
 * A CRT is a screen, and a screen is dark whatever the room is. Inverting the
 * office in light mode would also mean regenerating every sprite texture on a
 * theme switch, for a result nobody asked for. The canvas therefore keeps one
 * palette and reads as a monitor sitting in the page — which is the honest
 * reading of what it is.
 */
export const OFFICE = {
  background: '#070a0d',
  floorLight: '#141b24',
  floorDark: '#0f151c',
  wall: '#1a2330',
  desk: '#243040',
  deskEdge: '#2f3d50',
  managerDesk: '#2a3550',
  /** Underside of a desk. Darker than `desk`, so furniture reads as solid. */
  deskLeg: '#18202c',
  nameplate: '#9fb2c4',
  /**
   * The desk plate's secondary lines — model, current tool, spend (FR-S10).
   *
   * Deliberately dimmer than `nameplate`: measured 4.78:1 at worst against the
   * three grounds it lands on (background, and both floor tiles), against
   * `nameplate`'s 7.95:1. Both clear WCAG AA for normal text — this is real
   * information, not decoration, so it is held to the same 4.5:1 bar as the
   * DOM chrome and `sim/officeText.test.ts` enforces it. The gap between the
   * two is what makes a floor of desks scannable by name: the name is what you
   * search for, the detail is what you read once you have found it.
   */
  plateDetail: '#78889b',
  /** Sprite outlines and eyes — near-black, but its own token: an outline that
   *  tracked the backdrop would vanish the moment the backdrop was retuned. */
  outline: '#05070a',
  /** Ruled lines on a carried report page, dimmer than the page itself. */
  paperLine: '#8fa0b2',
  selection: '#2ee6d6',
  /** Cast under a desk whose agent is currently working. */
  workGlow: '#2ee6d6',
  paper: '#d8e3ee',
} as const;

/**
 * Per-agent sprite ramps (FR-S2, FR-U3).
 *
 * Retuned to phosphor hues rather than naturalistic skin and clothing, so the
 * characters read as part of the terminal rather than as pixel people dropped
 * into it. The *structure* is unchanged — `sim/model.ts` still slices a hash
 * across four independent ramps — so this is a palette swap, not a change to
 * sprite generation, exactly as FR-U3 requires.
 *
 * Kept deliberately dimmer than the status hues. A desk full of characters must
 * never out-shout the one badge saying something failed.
 */
export const SPRITE_RAMP = {
  /** Face/hands. Pale phosphor tints, low saturation. */
  skin: ['#cfe3e0', '#b7d4d8', '#c9d2e6', '#a8c4cf', '#bcc9d6'],
  /** Hair. The most varied ramp, since it carries most of the recognisability. */
  hair: ['#2ee6d6', '#a98cff', '#ff8ad2', '#ffb347', '#5fb0ff', '#47e07a'],
  /** Torso. Mid-tone, never fully saturated. */
  shirt: ['#1f6f7a', '#4a3f7a', '#7a3f63', '#6b5320', '#2f5f8a', '#2c6b4a', '#5a3a5f', '#39505f'],
  /** Legs. Darkest ramp, so characters sit on the floor rather than float. */
  trousers: ['#1a2430', '#232b3a', '#1e2a33', '#28242f'],
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
