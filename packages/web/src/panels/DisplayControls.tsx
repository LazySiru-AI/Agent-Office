import type {
  MotionPreference,
  PlateDensity,
  ResolvedMotion,
  ThemePreference,
} from '../theme/useTheme.js';
import type { ThemeMode } from '../theme/tokens.js';

/**
 * Theme mode (FR-U7) and motion (FR-U5) controls, in one small panel.
 *
 * Deliberately unstyled, matching the rest of this codebase's panels
 * (`ReplayControls.tsx`, `RunHeader.tsx`) — plain semantic HTML, no
 * component library, no colour or layout of its own. The `display-controls`
 * class is the only styling hook, left for the CSS agent.
 *
 * Props mirror `UseThemeResult` (`../theme/useTheme.ts`) rather than taking
 * the hook result wholesale, following this codebase's existing panel
 * convention (see `ReplayControlsProps`) of individually named props plus
 * `on*` callbacks — it keeps this component renderable/testable without
 * the hook itself.
 *
 * Accessibility: every control is a real `<button>`, grouped under a
 * `role="group"` with its own `aria-label` (there is no visually-hidden
 * utility class in this deliberately-unstyled UI, so a legend-less group
 * label is the accessible equivalent of the labelled `<fieldset>`s used
 * elsewhere). Each button reports its selected state via `aria-pressed`,
 * matching `App.tsx`'s existing office/table view toggle.
 */
export interface DisplayControlsProps {
  themePreference: ThemePreference;
  resolvedTheme: ThemeMode;
  onThemePreferenceChange: (preference: ThemePreference) => void;

  motionPreference: MotionPreference;
  resolvedMotion: ResolvedMotion;
  onMotionPreferenceChange: (preference: MotionPreference) => void;

  /** How much each office desk plate states (FR-S10). */
  plateDensity: PlateDensity;
  onPlateDensityChange: (density: PlateDensity) => void;
}

const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
  { value: 'system', label: 'System' },
];

const MOTION_OPTIONS: { value: MotionPreference; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'off', label: 'Off' },
];

/**
 * Labelled by what each shows rather than by its internal name, because
 * "normal" tells a reader nothing about what they will get. The order matches
 * `PLATE_DENSITIES` — least to most.
 */
const DENSITY_OPTIONS: { value: PlateDensity; label: string; hint: string }[] = [
  { value: 'minimal', label: 'Name', hint: 'agent name only' },
  { value: 'normal', label: '+ Model', hint: 'name, model, and the current tool' },
  { value: 'verbose', label: '+ Cost', hint: 'adds tokens and estimated spend' },
];

export function DisplayControls({
  themePreference,
  resolvedTheme,
  onThemePreferenceChange,
  motionPreference,
  resolvedMotion,
  onMotionPreferenceChange,
  plateDensity,
  onPlateDensityChange,
}: DisplayControlsProps): JSX.Element {
  return (
    <div className="display-controls">
      <div role="group" aria-label="Theme" className="display-controls-group">
        <span className="display-controls-label">
          Theme{themePreference === 'system' && ` (currently ${resolvedTheme})`}
        </span>
        {THEME_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={themePreference === option.value}
            onClick={() => onThemePreferenceChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>

      <div role="group" aria-label="Motion" className="display-controls-group">
        <span className="display-controls-label">
          Motion{motionPreference === 'auto' && ` (currently ${resolvedMotion})`}
        </span>
        {MOTION_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={motionPreference === option.value}
            onClick={() => onMotionPreferenceChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>

      <div role="group" aria-label="Office desk plates" className="display-controls-group">
        <span className="display-controls-label">Desk plates</span>
        {DENSITY_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={plateDensity === option.value}
            /* The hint is the accessible description, not a `title`: a
               tooltip on a control is not announced and does not survive a
               keyboard-only path, and "+ Model" alone does not say what will
               appear. */
            aria-label={`${option.label} — ${option.hint}`}
            onClick={() => onPlateDensityChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}
