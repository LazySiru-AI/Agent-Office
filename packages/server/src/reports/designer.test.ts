import { describe, expect, it } from 'vitest';
import type { AgentDef, AgentEvent } from '@agent-office/shared';
import { REPORT_THEME_IDS } from '@agent-office/shared';
import { buildRegistry, type Registry } from '../registry/index.js';
import { ScriptedProvider, type ScriptedProviderOptions } from '../providers/scripted.js';
import type { AgentProvider, AgentRunRequest, ProviderAvailability, ProviderId } from '../providers/types.js';
import {
  DEFAULT_FALLBACK_THEME,
  DEFAULT_MAX_REPAIR_ATTEMPTS,
  DESIGNER_ASSIGNMENT_ID,
  DESIGNER_SOURCE_AGENT,
  DesignerAbortedError,
  MissingDesignerSourceAgentError,
  buildDesignerSystemPrompt,
  buildDesignerUserPrompt,
  chooseTheme,
  fallbackThemeForDomain,
} from './designer.js';

// ---------------------------------------------------------------------------
// Fixtures — hermetic, like manager.test.ts: the real catalog is 154 agents and
// loading it would couple every assertion here to whatever the repo happens to
// contain that week.
// ---------------------------------------------------------------------------

function agent(name: string, category: string, systemPrompt: string): AgentDef {
  return {
    name,
    description: `${name} does things.`,
    tools: ['Read', 'Grep'],
    category,
    filePath: `categories/${category}/${name}.md`,
    systemPrompt,
  };
}

const UI_DESIGNER = agent(
  DESIGNER_SOURCE_AGENT,
  '01-core-development',
  'UI-DESIGNER-BODY: pick the visual language that fits the audience and the content.',
);

function testRegistry(agents: AgentDef[] = [UI_DESIGNER]): Registry {
  return buildRegistry(agents);
}

const TASK = 'Add rate limiting to the public API and confirm it is safe to ship.';
const DOMAIN = 'software';
const REPORT_STYLE = 'engineering';
const SYNTHESIS = '# Rate limiting\n\n## Summary\n\nShip it behind a flag. Token bucket, Redis-backed.';

const VALID_CHOICE_JSON = JSON.stringify({
  themeId: 'engineering',
  rationale: 'The synthesis is a terse technical write-up about an API change.',
});

/** A response naming a theme that does not, and will never, exist. */
const HALLUCINATED_CHOICE_JSON = JSON.stringify({
  themeId: 'corporate-modern',
  rationale: 'This reads like a corporate deck.',
});

/** Structurally valid JSON, but missing the required `rationale`. */
const SCHEMA_INVALID_CHOICE_JSON = JSON.stringify({ themeId: 'engineering' });

function silentLogger(): { log: (message: string) => void; messages: string[] } {
  const messages: string[] = [];
  return { log: (message: string) => void messages.push(message), messages };
}

function liveSignal(): AbortSignal {
  return new AbortController().signal;
}

/**
 * Mirrors `sequencedProvider` in manager.test.ts: `onRequest` fires before the
 * response is resolved, so a queue can script a *sequence* of designer turns
 * across repair attempts (whose assignment id stays constant).
 */
function sequencedProvider(texts: string[]): ScriptedProvider {
  const queue = [...texts];
  const byAssignment: Record<string, { text: string }> = {};
  const options: ScriptedProviderOptions = {
    byAssignment,
    onRequest: (request) => {
      byAssignment[request.assignmentId] = {
        text: queue.shift() ?? 'THE SCRIPT RAN OUT OF RESPONSES',
      };
    },
  };
  return new ScriptedProvider(options);
}

/** A provider whose `run()` throws synchronously, to exercise the non-fatal-event failure path too. */
class ThrowingProvider implements AgentProvider {
  readonly id: ProviderId = 'scripted';
  calls = 0;

  async isAvailable(): Promise<ProviderAvailability> {
    return { ok: true };
  }

  async *run(_request: AgentRunRequest): AsyncIterable<AgentEvent> {
    this.calls += 1;
    await Promise.resolve();
    throw new Error('the process could not be spawned');
  }
}

// ---------------------------------------------------------------------------
// buildDesignerSystemPrompt
// ---------------------------------------------------------------------------

describe('buildDesignerSystemPrompt', () => {
  it('composes the ui-designer persona plus an output contract', () => {
    const prompt = buildDesignerSystemPrompt(testRegistry());

    expect(prompt).toContain('UI-DESIGNER-BODY');
    expect(prompt).toContain(`Source persona: ${DESIGNER_SOURCE_AGENT}`);
    expect(prompt).toContain('Output contract');
    expect(prompt).toContain(REPORT_THEME_IDS.join(', '));
  });

  it('throws MissingDesignerSourceAgentError when the source agent is absent', () => {
    const registry = testRegistry([]);

    let caught: unknown;
    try {
      buildDesignerSystemPrompt(registry);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(MissingDesignerSourceAgentError);
    expect((caught as Error).message).toContain(DESIGNER_SOURCE_AGENT);
  });
});

// ---------------------------------------------------------------------------
// buildDesignerUserPrompt — trimming (NFR-5, FR-M8)
// ---------------------------------------------------------------------------

describe('buildDesignerUserPrompt', () => {
  it('includes the task, domain, reportStyle and theme briefs', () => {
    const prompt = buildDesignerUserPrompt(TASK, DOMAIN, REPORT_STYLE, SYNTHESIS);

    expect(prompt).toContain(TASK);
    expect(prompt).toContain(`domain: ${DOMAIN}`);
    expect(prompt).toContain(`reportStyle hint: ${REPORT_STYLE}`);
    expect(prompt).toContain(SYNTHESIS);
    for (const id of REPORT_THEME_IDS) {
      expect(prompt).toContain(`\`${id}\``);
    }
  });

  it('leaves a short synthesis untouched', () => {
    const prompt = buildDesignerUserPrompt(TASK, DOMAIN, REPORT_STYLE, SYNTHESIS, {
      maxSynthesisChars: 10_000,
    });
    expect(prompt).not.toContain('[TRUNCATED BY AGENT OFFICE:');
  });

  it('caps a very long synthesis with a visible marker instead of sending it whole', () => {
    const long = `${'A'.repeat(40)}TAILMARKER${'B'.repeat(50)}`;
    expect(long).toHaveLength(100);

    const prompt = buildDesignerUserPrompt(TASK, DOMAIN, REPORT_STYLE, long, {
      maxSynthesisChars: 40,
    });

    expect(prompt).toContain('A'.repeat(40));
    expect(prompt).not.toContain('TAILMARKER');
    expect(prompt).toContain('[TRUNCATED BY AGENT OFFICE: 60 of 100 characters omitted.');
  });

  it('defaults to DEFAULT_MAX_SYNTHESIS_CHARS when no cap is supplied', () => {
    const long = 'x'.repeat(20_000);
    const prompt = buildDesignerUserPrompt(TASK, DOMAIN, REPORT_STYLE, long);
    expect(prompt).toContain('[TRUNCATED BY AGENT OFFICE:');
    // The prompt is bounded, not merely marked — the raw text past the cap must be gone.
    expect(prompt.length).toBeLessThan(long.length);
  });
});

// ---------------------------------------------------------------------------
// fallbackThemeForDomain — the domain -> theme mapping (NFR-8)
// ---------------------------------------------------------------------------

describe('fallbackThemeForDomain', () => {
  it('maps known domains to the expected theme', () => {
    expect(fallbackThemeForDomain('software', '')).toBe('engineering');
    expect(fallbackThemeForDomain('legal', '')).toBe('legal');
    expect(fallbackThemeForDomain('tax', '')).toBe('financial');
    expect(fallbackThemeForDomain('finance', '')).toBe('financial');
    expect(fallbackThemeForDomain('research', '')).toBe('research');
    expect(fallbackThemeForDomain('product', '')).toBe('research');
  });

  it('prefers the reportStyle hint over the domain when both are informative', () => {
    // A "tax" domain whose reportStyle explicitly says "legal-memo" should defer
    // to the more specific hint, exactly as the Manager intended reportStyle to work.
    expect(fallbackThemeForDomain('tax', 'legal-memo')).toBe('legal');
  });

  it('matches keyword-bearing reportStyle hints, not just exact theme ids', () => {
    expect(fallbackThemeForDomain('unknown', 'research-brief')).toBe('research');
    expect(fallbackThemeForDomain('unknown', 'financial-summary')).toBe('financial');
  });

  it('falls back to the default theme for a wholly unknown domain and reportStyle', () => {
    expect(fallbackThemeForDomain('astrology', 'freeform')).toBe(DEFAULT_FALLBACK_THEME);
    expect(fallbackThemeForDomain('', '')).toBe(DEFAULT_FALLBACK_THEME);
  });

  it('is case-insensitive and tolerant of surrounding whitespace', () => {
    expect(fallbackThemeForDomain('  LEGAL  ', '')).toBe('legal');
    expect(fallbackThemeForDomain('Software', '')).toBe('engineering');
  });
});

// ---------------------------------------------------------------------------
// chooseTheme (FR-P2, FR-M2/FR-M3 discipline, NFR-8 degradation)
// ---------------------------------------------------------------------------

describe('chooseTheme', () => {
  it('returns a valid model choice as-is, on the first attempt', async () => {
    const provider = new ScriptedProvider({
      byAssignment: { [DESIGNER_ASSIGNMENT_ID]: { text: VALID_CHOICE_JSON } },
    });

    const choice = await chooseTheme({
      registry: testRegistry(),
      provider,
      task: TASK,
      domain: DOMAIN,
      reportStyle: REPORT_STYLE,
      synthesisMarkdown: SYNTHESIS,
      signal: liveSignal(),
    });

    expect(choice.themeId).toBe('engineering');
    expect(choice.rationale).toBe(
      'The synthesis is a terse technical write-up about an API change.',
    );
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.assignmentId).toBe(DESIGNER_ASSIGNMENT_ID);
    expect(provider.requests[0]?.allowedTools).toEqual([]);
  });

  it('accepts a choice wrapped in prose and a fence (reuses the manager JSON extractor)', async () => {
    const wrapped = ['Here you go:', '', '```json', VALID_CHOICE_JSON, '```'].join('\n');
    const provider = new ScriptedProvider({
      byAssignment: { [DESIGNER_ASSIGNMENT_ID]: { text: wrapped } },
    });

    const choice = await chooseTheme({
      registry: testRegistry(),
      provider,
      task: TASK,
      domain: DOMAIN,
      reportStyle: REPORT_STYLE,
      synthesisMarkdown: SYNTHESIS,
      signal: liveSignal(),
    });

    expect(choice.themeId).toBe('engineering');
    expect(provider.requests).toHaveLength(1);
  });

  it('repairs after a hallucinated theme id and, once corrected, returns the closed-set value', async () => {
    const provider = sequencedProvider([HALLUCINATED_CHOICE_JSON, VALID_CHOICE_JSON]);
    const logger = silentLogger();

    const choice = await chooseTheme({
      registry: testRegistry(),
      provider,
      task: TASK,
      domain: DOMAIN,
      reportStyle: REPORT_STYLE,
      synthesisMarkdown: SYNTHESIS,
      signal: liveSignal(),
      logger: logger.log,
    });

    expect(choice.themeId).toBe('engineering');
    expect(REPORT_THEME_IDS).toContain(choice.themeId);
    expect(provider.requests).toHaveLength(2);

    const repairPrompt = provider.requests[1]?.task ?? '';
    expect(repairPrompt).toContain('Repair required');
    expect(repairPrompt).toContain('corporate-modern');
    expect(repairPrompt).toContain('The ONLY legal values for "themeId"');
    expect(logger.messages[0]).toContain('rejected (schema)');
  });

  it('never propagates an invented theme id: exhausting repairs falls back instead', async () => {
    // Every attempt names the same invented theme, so the repair budget is
    // exhausted without ever producing a valid choice.
    const provider = sequencedProvider([
      HALLUCINATED_CHOICE_JSON,
      HALLUCINATED_CHOICE_JSON,
      HALLUCINATED_CHOICE_JSON,
    ]);
    const logger = silentLogger();

    const choice = await chooseTheme({
      registry: testRegistry(),
      provider,
      task: TASK,
      domain: DOMAIN,
      reportStyle: REPORT_STYLE,
      synthesisMarkdown: SYNTHESIS,
      signal: liveSignal(),
      logger: logger.log,
    });

    // The fallback must be one of the real themes, never "corporate-modern".
    expect(REPORT_THEME_IDS).toContain(choice.themeId);
    expect(choice.themeId).toBe(fallbackThemeForDomain(DOMAIN, REPORT_STYLE));
    expect(choice.rationale).toContain('Fallback theme');
    expect(provider.requests).toHaveLength(DEFAULT_MAX_REPAIR_ATTEMPTS + 1);
    expect(logger.messages.some((m) => m.includes('falling back'))).toBe(true);
  });

  it('repairs after schema-invalid output (missing rationale), then succeeds', async () => {
    const provider = sequencedProvider([SCHEMA_INVALID_CHOICE_JSON, VALID_CHOICE_JSON]);
    const logger = silentLogger();
    const events: AgentEvent[] = [];

    const choice = await chooseTheme({
      registry: testRegistry(),
      provider,
      task: TASK,
      domain: DOMAIN,
      reportStyle: REPORT_STYLE,
      synthesisMarkdown: SYNTHESIS,
      signal: liveSignal(),
      logger: logger.log,
      onEvent: (event) => void events.push(event),
    });

    expect(choice.themeId).toBe('engineering');
    expect(provider.requests).toHaveLength(2);
    expect(events.filter((e) => e.t === 'error' && !e.fatal)).toHaveLength(1);
  });

  it('repairs after unparseable prose with no JSON at all', async () => {
    const provider = sequencedProvider(['I refuse to pick a theme.', VALID_CHOICE_JSON]);
    const logger = silentLogger();

    const choice = await chooseTheme({
      registry: testRegistry(),
      provider,
      task: TASK,
      domain: DOMAIN,
      reportStyle: REPORT_STYLE,
      synthesisMarkdown: SYNTHESIS,
      signal: liveSignal(),
      logger: logger.log,
    });

    expect(choice.themeId).toBe('engineering');
    expect(logger.messages[0]).toContain('rejected (unparseable)');
  });

  it('falls back without failing the run when the source agent is missing, and calls no model', async () => {
    const provider = new ScriptedProvider({
      byAssignment: { [DESIGNER_ASSIGNMENT_ID]: { text: VALID_CHOICE_JSON } },
    });

    const choice = await chooseTheme({
      registry: testRegistry([]), // no ui-designer agent
      provider,
      task: TASK,
      domain: 'legal',
      reportStyle: 'legal-memo',
      synthesisMarkdown: SYNTHESIS,
      signal: liveSignal(),
    });

    expect(choice.themeId).toBe('legal');
    expect(choice.rationale).toContain('Fallback theme');
    expect(provider.requests).toHaveLength(0);
  });

  it('falls back on a fatal provider error and does not consume the repair budget', async () => {
    const provider = new ScriptedProvider({
      byAssignment: { [DESIGNER_ASSIGNMENT_ID]: { failWith: 'CLI exited with code 1' } },
    });
    const logger = silentLogger();

    const choice = await chooseTheme({
      registry: testRegistry(),
      provider,
      task: TASK,
      domain: 'tax',
      reportStyle: 'financial',
      synthesisMarkdown: SYNTHESIS,
      signal: liveSignal(),
      logger: logger.log,
    });

    expect(choice.themeId).toBe('financial');
    expect(choice.rationale).toContain('Fallback theme');
    // Exactly one call: a fatal provider error is not a repair case, so no
    // repair-retry attempts were spent trying to fix something the model
    // cannot fix.
    expect(provider.requests).toHaveLength(1);
    expect(logger.messages.some((m) => m.includes('provider error'))).toBe(true);
  });

  it('falls back when the provider throws synchronously, without spending the repair budget', async () => {
    const provider = new ThrowingProvider();

    const choice = await chooseTheme({
      registry: testRegistry(),
      provider,
      task: TASK,
      domain: 'research',
      reportStyle: 'research-brief',
      synthesisMarkdown: SYNTHESIS,
      signal: liveSignal(),
    });

    expect(choice.themeId).toBe('research');
    expect(choice.rationale).toContain('Fallback theme');
    expect(provider.calls).toBe(1);
  });

  it('states plainly in the rationale that a model choice, not a fallback, was used', async () => {
    const provider = new ScriptedProvider({
      byAssignment: { [DESIGNER_ASSIGNMENT_ID]: { text: VALID_CHOICE_JSON } },
    });

    const choice = await chooseTheme({
      registry: testRegistry(),
      provider,
      task: TASK,
      domain: DOMAIN,
      reportStyle: REPORT_STYLE,
      synthesisMarkdown: SYNTHESIS,
      signal: liveSignal(),
    });

    expect(choice.rationale).not.toContain('Fallback theme');
  });

  it('throws without calling the provider when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const provider = new ScriptedProvider({
      byAssignment: { [DESIGNER_ASSIGNMENT_ID]: { text: VALID_CHOICE_JSON } },
    });

    await expect(
      chooseTheme({
        registry: testRegistry(),
        provider,
        task: TASK,
        domain: DOMAIN,
        reportStyle: REPORT_STYLE,
        synthesisMarkdown: SYNTHESIS,
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(DesignerAbortedError);

    expect(provider.requests).toHaveLength(0);
  });

  it('honours an abort that happens mid-flight, rather than falling back', async () => {
    const controller = new AbortController();
    const provider = new ScriptedProvider({
      byAssignment: { [DESIGNER_ASSIGNMENT_ID]: { hang: true } },
      onRequest: () => controller.abort(),
    });

    await expect(
      chooseTheme({
        registry: testRegistry(),
        provider,
        task: TASK,
        domain: DOMAIN,
        reportStyle: REPORT_STYLE,
        synthesisMarkdown: SYNTHESIS,
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(DesignerAbortedError);

    // One request was made (it was in flight when the abort happened) and no
    // repair turn followed it.
    expect(provider.requests).toHaveLength(1);
  });

  it('rejects a nonsensical repair budget', async () => {
    await expect(
      chooseTheme({
        registry: testRegistry(),
        provider: new ScriptedProvider(),
        task: TASK,
        domain: DOMAIN,
        reportStyle: REPORT_STYLE,
        synthesisMarkdown: SYNTHESIS,
        signal: liveSignal(),
        maxRepairAttempts: -1,
      }),
    ).rejects.toThrow(/non-negative integer/);
  });

  it('honours maxRepairAttempts: 0 as a single attempt before falling back', async () => {
    const provider = sequencedProvider([HALLUCINATED_CHOICE_JSON, VALID_CHOICE_JSON]);

    const choice = await chooseTheme({
      registry: testRegistry(),
      provider,
      task: TASK,
      domain: DOMAIN,
      reportStyle: REPORT_STYLE,
      synthesisMarkdown: SYNTHESIS,
      signal: liveSignal(),
      maxRepairAttempts: 0,
    });

    expect(provider.requests).toHaveLength(1);
    expect(choice.rationale).toContain('Fallback theme');
  });

  it('sends the composed persona as the system prompt', async () => {
    const provider = new ScriptedProvider({
      byAssignment: { [DESIGNER_ASSIGNMENT_ID]: { text: VALID_CHOICE_JSON } },
    });

    await chooseTheme({
      registry: testRegistry(),
      provider,
      task: TASK,
      domain: DOMAIN,
      reportStyle: REPORT_STYLE,
      synthesisMarkdown: SYNTHESIS,
      signal: liveSignal(),
    });

    expect(provider.requests[0]?.systemPrompt).toContain('UI-DESIGNER-BODY');
    expect(provider.requests[0]?.task).toContain(TASK);
    expect(provider.requests[0]?.task).toContain(SYNTHESIS);
  });

  it('applies maxSynthesisChars to the prompt actually sent to the provider', async () => {
    const provider = new ScriptedProvider({
      byAssignment: { [DESIGNER_ASSIGNMENT_ID]: { text: VALID_CHOICE_JSON } },
    });
    const long = `${'A'.repeat(20)}TAILMARKER`;

    await chooseTheme({
      registry: testRegistry(),
      provider,
      task: TASK,
      domain: DOMAIN,
      reportStyle: REPORT_STYLE,
      synthesisMarkdown: long,
      signal: liveSignal(),
      maxSynthesisChars: 20,
    });

    expect(provider.requests[0]?.task).toContain('[TRUNCATED BY AGENT OFFICE:');
    expect(provider.requests[0]?.task).not.toContain('TAILMARKER');
  });

  it('forwards every provider event to onEvent, stamped with the designer assignment id', async () => {
    const provider = new ScriptedProvider({
      byAssignment: {
        [DESIGNER_ASSIGNMENT_ID]: {
          text: VALID_CHOICE_JSON,
          toolCalls: [{ name: 'Read', summary: 'Read the synthesis' }],
          usage: { inputTokens: 5, outputTokens: 7 },
        },
      },
    });
    const events: AgentEvent[] = [];

    await chooseTheme({
      registry: testRegistry(),
      provider,
      task: TASK,
      domain: DOMAIN,
      reportStyle: REPORT_STYLE,
      synthesisMarkdown: SYNTHESIS,
      signal: liveSignal(),
      onEvent: (event) => void events.push(event),
    });

    expect(events.map((event) => event.t)).toEqual(['tool', 'usage', 'text']);
    expect(events.every((event) => event.assignmentId === DESIGNER_ASSIGNMENT_ID)).toBe(true);
  });
});
