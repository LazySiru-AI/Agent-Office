import { describe, expect, it } from 'vitest';
import type { AssignmentState, LoggedAgentEvent } from '@agent-office/shared';
import { contrastRatio, WCAG_AA_NORMAL_TEXT } from '../theme/status.js';
import { OFFICE } from '../theme/tokens.js';
import { PLATE_DENSITIES, resolvePlateDensity, type PlateDensity } from '../theme/useTheme.js';
import {
  buildSceneFromAssignments,
  formatModelLabel,
  formatToolLine,
  isReadingTool,
  latestToolByAssignment,
  plateLines,
  refineAnimation,
  type SceneContext,
} from './model.js';

/**
 * FR-S10/FR-S11 — what the office says, and whether it can be read.
 *
 * The office gained words in Phase 9, and words have two obligations the
 * pixel art did not: they must be legible, and they must be the same words the
 * screen-reader alternative reads out. Both are tested here rather than left
 * to a look at the screen, because "the model is on the desk now" is exactly
 * the sort of claim that stays true right up until a density is added.
 */

function assignment(
  id: string,
  agentName: string,
  overrides: Partial<AssignmentState> = {},
): AssignmentState {
  return {
    id,
    phaseId: 'phase-1',
    agentName,
    objective: 'do the thing',
    deliverable: `reports/${id}.md`,
    dependsOn: [],
    status: 'working',
    attempts: 1,
    usage: { inputTokens: 0, outputTokens: 0 },
    ...overrides,
  };
}

function toolEvent(assignmentId: string, name: string, ts = 1): LoggedAgentEvent {
  return { ts, event: { t: 'tool', assignmentId, name, summary: 'src/app.ts' } };
}

function context(overrides: Partial<SceneContext> = {}): SceneContext {
  return {
    agentModelByName: new Map(),
    runProvider: undefined,
    toolByAssignment: new Map(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// FR-S11 — the tool refines the working loop, and nothing else
// ---------------------------------------------------------------------------

describe('refineAnimation (FR-S11)', () => {
  it('turns the working loop into `read` for a reading tool', () => {
    expect(refineAnimation('type', 'Read')).toBe('read');
    expect(refineAnimation('type', 'Glob')).toBe('read');
    expect(refineAnimation('type', 'Grep')).toBe('read');
  });

  it('leaves the working loop alone for a writing tool, or none at all', () => {
    expect(refineAnimation('type', 'Write')).toBe('type');
    expect(refineAnimation('type', 'Edit')).toBe('type');
    expect(refineAnimation('type', undefined)).toBe('type');
  });

  it('treats an unrecognised tool as writing rather than guessing', () => {
    // An MCP tool, or a built-in added after this taxonomy was written. Falling
    // through to `type` says "this agent is doing something", which is true of
    // every tool; claiming it reads would be a guess about a name we have
    // never seen.
    expect(refineAnimation('type', 'mcp__something__fetch')).toBe('type');
    expect(isReadingTool('Bash')).toBe(false);
  });

  it('never changes an animation that is not the working loop', () => {
    // The refinement's whole scope. A tool event arriving while a character
    // walks to the Manager must not sit it down at a desk — status owns
    // *behaviour*, the tool owns only which working loop plays.
    for (const animation of ['idle', 'idle_relaxed', 'idle_slumped', 'walk'] as const) {
      expect(refineAnimation(animation, 'Read')).toBe(animation);
      expect(refineAnimation(animation, 'Write')).toBe(animation);
    }
  });
});

describe('latestToolByAssignment', () => {
  it('keeps the most recent tool per assignment', () => {
    const map = latestToolByAssignment([
      toolEvent('a', 'Read', 1),
      toolEvent('b', 'Write', 2),
      toolEvent('a', 'Grep', 3),
    ]);
    expect(map.get('a')).toBe('Grep');
    expect(map.get('b')).toBe('Write');
  });

  it('ignores every event that is not a tool call', () => {
    const map = latestToolByAssignment([
      { ts: 1, event: { t: 'status', assignmentId: 'a', status: 'working' } },
      { ts: 2, event: { t: 'text', assignmentId: 'a', chunk: 'hello' } },
      { ts: 3, event: { t: 'usage', assignmentId: 'a', inputTokens: 5, outputTokens: 5 } },
    ]);
    expect(map.size).toBe(0);
  });
});

describe('the tool only describes the present tense', () => {
  it('drops the current tool once the assignment stops working', () => {
    // A `tool` event is often the LAST thing an assignment emits, and it stays
    // in the log for ever. Without the status guard in `buildSceneFromAssignments`
    // a finished agent would sit under a plate still reading `Grep`, describing
    // work that ended minutes ago — which is worse than saying nothing.
    const toolByAssignment = new Map([['a', 'Grep']]);

    const working = buildSceneFromAssignments(
      [assignment('a', 'code-reviewer', { status: 'working' })],
      context({ toolByAssignment }),
    );
    expect(working.characters[0]?.currentTool).toBe('Grep');
    expect(working.characters[0]?.animation).toBe('read');

    for (const status of ['done', 'failed', 'skipped', 'cancelled', 'reporting'] as const) {
      const scene = buildSceneFromAssignments(
        [assignment('a', 'code-reviewer', { status })],
        context({ toolByAssignment }),
      );
      expect(scene.characters[0]?.currentTool, `${status} should carry no tool`).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// FR-S10 — the facts the office used to make you leave to find
// ---------------------------------------------------------------------------

describe('buildSceneFromAssignments carries the run facts (FR-S10)', () => {
  it("resolves each character's model from the agent roster", () => {
    const scene = buildSceneFromAssignments(
      [assignment('a', 'code-reviewer'), assignment('b', 'tax-advisor')],
      context({
        agentModelByName: new Map([
          ['code-reviewer', 'haiku'],
          ['tax-advisor', undefined],
        ]),
      }),
    );
    expect(scene.characters[0]?.model).toBe('haiku');
    // Declares no model in its frontmatter — distinct from "unknown agent".
    expect(scene.characters[1]?.model).toBeUndefined();
  });

  it('prices a character through costModel, not a second implementation', () => {
    const scene = buildSceneFromAssignments(
      [assignment('a', 'code-reviewer', { usage: { inputTokens: 1_000, outputTokens: 1_000 } })],
      context({ agentModelByName: new Map([['code-reviewer', 'haiku']]) }),
    );
    const character = scene.characters[0];
    expect(character?.usage).toEqual({ inputTokens: 1_000, outputTokens: 1_000 });
    // The exact figure belongs to `pricing.ts` and is asserted there; what
    // matters here is that the office got a real number out of the shared
    // calculation rather than inventing one. The office and the assignment
    // table showing different costs for one run would be the most visible
    // possible version of this project's recurring two-sources defect.
    expect(character?.costUsd).toBeGreaterThan(0);
  });

  it('leaves cost undefined rather than guessing when the model is unknown', () => {
    const scene = buildSceneFromAssignments(
      [assignment('a', 'mystery-agent', { usage: { inputTokens: 500, outputTokens: 500 } })],
      context(),
    );
    expect(scene.characters[0]?.costUsd).toBeUndefined();
  });

  it('defaults to an empty context, so the office still builds with no roster', () => {
    const scene = buildSceneFromAssignments([assignment('a', 'code-reviewer')]);
    expect(scene.characters[0]?.model).toBeUndefined();
    expect(scene.characters[0]?.currentTool).toBeUndefined();
    expect(scene.characters[0]?.animation).toBe('type');
  });
});

describe('plateLines (FR-S10)', () => {
  const view = () =>
    buildSceneFromAssignments(
      [assignment('a', 'code-reviewer', { usage: { inputTokens: 1_200, outputTokens: 300 } })],
      context({
        agentModelByName: new Map([['code-reviewer', 'haiku']]),
        toolByAssignment: new Map([['a', 'Grep']]),
      }),
    ).characters[0];

  it('states only the name at minimal — what the office showed before Phase 9', () => {
    const character = view();
    expect(character && plateLines(character, 'minimal')).toEqual(['code-reviewer']);
  });

  it('states the name, model and current tool at normal', () => {
    const character = view();
    expect(character && plateLines(character, 'normal')).toEqual(['code-reviewer', 'haiku', 'Grep']);
  });

  it('adds tokens and spend at verbose', () => {
    const character = view();
    const lines = character === undefined ? [] : plateLines(character, 'verbose');
    expect(lines.slice(0, 3)).toEqual(['code-reviewer', 'haiku', 'Grep']);
    expect(lines).toContain('1200in/300out');
    expect(lines.some((l) => l.startsWith('$'))).toBe(true);
  });

  it('says "run default" for an agent that declares no model', () => {
    const character = buildSceneFromAssignments([assignment('a', 'code-reviewer')], context())
      .characters[0];
    expect(character && plateLines(character, 'normal')).toEqual(['code-reviewer', 'run default']);
  });

  it('never prints `inherit` as though it were a model', () => {
    // Caught by looking at the running app, not by a test: two of the five
    // agents on screen said `inherit`, which names no model and reads like
    // one. 25 catalog agents declare it and 8 declare nothing — over a fifth
    // of the roster — and both mean the same thing, so both get one label.
    const character = buildSceneFromAssignments(
      [assignment('a', 'architect-reviewer')],
      context({ agentModelByName: new Map([['architect-reviewer', 'inherit']]) }),
    ).characters[0];

    const lines = character === undefined ? [] : plateLines(character, 'normal');
    expect(lines).not.toContain('inherit');
    expect(lines).toEqual(['architect-reviewer', 'run default']);
  });

  it('passes a real model through untouched', () => {
    expect(formatModelLabel('haiku')).toBe('haiku');
    expect(formatModelLabel('sonnet')).toBe('sonnet');
    expect(formatModelLabel(undefined)).toBe('run default');
    expect(formatModelLabel('inherit')).toBe('run default');
  });

  it('never emits an empty line at any density', () => {
    // Callers join this array without filtering it, on the promise that there
    // is nothing to filter.
    const character = view();
    for (const density of PLATE_DENSITIES) {
      const lines = character === undefined ? [] : plateLines(character, density);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(line.trim()).not.toBe('');
    }
  });

  it('starts every density with the agent name', () => {
    // The canvas draws line 0 in the name style and the rest dimmer, and the
    // text alternative reads them in order. Both assume the name comes first.
    const character = view();
    for (const density of PLATE_DENSITIES) {
      const lines = character === undefined ? [] : plateLines(character, density);
      expect(lines[0]).toBe('code-reviewer');
    }
  });

  it('grows monotonically with density', () => {
    // The control promises "more", so a density cannot show strictly fewer
    // facts than a lesser one.
    const character = view();
    if (character === undefined) throw new Error('expected a character');
    const counts = PLATE_DENSITIES.map((d: PlateDensity) => plateLines(character, d).length);
    for (let i = 1; i < counts.length; i += 1) {
      expect(counts[i] ?? 0).toBeGreaterThanOrEqual(counts[i - 1] ?? 0);
    }
  });
});

describe('formatToolLine', () => {
  it('joins the tool and its summary', () => {
    expect(formatToolLine('Read', 'src/app.ts')).toBe('Read src/app.ts');
  });

  it('degrades to the bare tool name when there is no summary', () => {
    expect(formatToolLine('Bash', '')).toBe('Bash');
    expect(formatToolLine('Bash', '   ')).toBe('Bash');
  });
});

describe('resolvePlateDensity', () => {
  it('accepts every real density', () => {
    for (const density of PLATE_DENSITIES) expect(resolvePlateDensity(density)).toBe(density);
  });

  it('falls back to normal for anything unrecognised or absent', () => {
    // `localStorage` is user-writable and survives a version of this app that
    // spelled the densities differently.
    expect(resolvePlateDensity(undefined)).toBe('normal');
    expect(resolvePlateDensity('')).toBe('normal');
    expect(resolvePlateDensity('enormous')).toBe('normal');
  });
});

// ---------------------------------------------------------------------------
// The office's text is text, so it is held to the text contrast bar
// ---------------------------------------------------------------------------

describe('office plate text meets WCAG AA on every ground it lands on', () => {
  // `theme/status.test.ts` grades the DOM chrome exhaustively and has caught
  // real sub-AA pairs twice. The canvas was never in that grid, because until
  // this phase it drew one nameplate and nothing else. FR-S10 put the model,
  // the current tool and the spend on the floor — that is real information in
  // real words, so it is held to the same 4.5:1 as everything else rather than
  // being exempt for living on a canvas.
  //
  // The grounds are the office's own, not the page's: `OFFICE` deliberately
  // does not follow the light theme (a CRT is dark whatever the room is), so
  // these three are the only backdrops plate text ever sits on.
  const GROUNDS = ['background', 'floorLight', 'floorDark'] as const;
  const TEXT = ['nameplate', 'plateDetail'] as const;

  for (const text of TEXT) {
    for (const ground of GROUNDS) {
      it(`OFFICE.${text} on OFFICE.${ground} meets ${WCAG_AA_NORMAL_TEXT}:1`, () => {
        const ratio = contrastRatio(OFFICE[text], OFFICE[ground]);
        expect(
          ratio >= WCAG_AA_NORMAL_TEXT,
          `OFFICE.${text} (${OFFICE[text]}) on OFFICE.${ground} (${OFFICE[ground]}) measured ${ratio.toFixed(2)}:1`,
        ).toBe(true);
      });
    }
  }

  it('keeps the detail lines visibly quieter than the name', () => {
    // The hierarchy is the point, not an accident of two colours both passing:
    // a floor of desks is scanned by name, and the detail is read once the
    // right desk is found. If a retune ever brought them level, the office
    // would still pass the bar above and would have lost the thing that makes
    // it scannable.
    const name = contrastRatio(OFFICE.nameplate, OFFICE.background);
    const detail = contrastRatio(OFFICE.plateDetail, OFFICE.background);
    expect(detail).toBeLessThan(name);
  });
});
