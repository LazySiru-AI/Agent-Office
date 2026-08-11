import path from 'node:path';
import {
  REPORT_HTML_PATH,
  REPORT_PDF_PATH,
  runTotalUsage,
  type ReportDocument,
  type RosterEntry,
  type RunPlan,
  type RunState,
} from '@agent-office/shared';
import type { Registry } from '../registry/index.js';
import type { AgentProvider } from '../providers/types.js';
import type { RunStore } from '../store/types.js';
import { chooseTheme } from './designer.js';
import { buildReportHtml, coerceThemeId } from './document.js';
import { renderPdf } from './pdf.js';

/**
 * The `designing` step, end to end (FR-P2 → FR-P5).
 *
 * Kept out of `runner.ts` because the runner's job is the state machine, and
 * this is a pipeline: choose a theme, assemble a document, write themed HTML,
 * print it. The runner calls one function and records the result.
 *
 * **Nothing in here may fail the run.** By the time this executes the agents
 * have already run and the synthesis is already written to disk — the expensive,
 * irreplaceable part is done. A missing browser or an unlucky designer turn is a
 * missing *attachment*, not a failed run, so every step degrades and reports
 * rather than throwing (NFR-8). The one exception is cancellation, which the
 * caller must see.
 */

export interface DeliverableDeps {
  run: RunState;
  plan: RunPlan;
  registry: Registry;
  provider: AgentProvider;
  store: RunStore;
  /** The Manager's synthesis markdown, already written to disk. */
  synthesisMarkdown: string;
  /** Per-assignment reports, in plan order. */
  appendices: readonly { agentName: string; path: string; markdown: string }[];
  signal: AbortSignal;
  logger?: (line: string) => void;
  /** Estimated run cost, when the caller can compute one (NFR-5). */
  costUsd?: number;
}

export interface DeliverableResult {
  theme: string;
  rationale: string;
  /** Run-relative, set only when the file was actually written. */
  htmlPath?: string;
  pdfPath?: string;
  /** Why there is no PDF, when there isn't one. Shown to the user, not thrown. */
  pdfError?: string;
}

/** One roster row per assignment — including the ones that failed (FR-P4). */
export function buildRoster(run: RunState, registry: Registry): RosterEntry[] {
  return run.assignments.map((assignment) => ({
    agentName: assignment.agentName,
    // A renamed or removed agent must not break the cover page.
    category: registry.byName.get(assignment.agentName)?.category ?? 'unknown',
    role: assignment.objective,
    status: assignment.status,
  }));
}

export async function produceDeliverable(deps: DeliverableDeps): Promise<DeliverableResult> {
  const log = deps.logger ?? ((): void => undefined);
  const { run, plan, store } = deps;

  // 1. Theme. `chooseTheme` already falls back rather than throwing, except on
  //    abort — which must propagate, because a cancelled run should stop.
  const choice = await chooseTheme({
    registry: deps.registry,
    provider: deps.provider,
    task: run.task,
    domain: plan.domain,
    reportStyle: plan.reportStyle,
    synthesisMarkdown: deps.synthesisMarkdown,
    signal: deps.signal,
    ...(deps.logger === undefined ? {} : { logger: deps.logger }),
  });

  log(`[${run.id}] theme: ${choice.themeId}`);

  // 2. Assemble. Pure, and therefore the one step that cannot fail for
  //    environmental reasons.
  const usage = runTotalUsage(run);
  const document: ReportDocument = {
    runId: run.id,
    task: run.task,
    generatedAt: Date.now(),
    domain: plan.domain,
    theme: coerceThemeId(choice.themeId),
    rationale: choice.rationale,
    roster: buildRoster(run, deps.registry),
    synthesisMarkdown: deps.synthesisMarkdown,
    appendices: [...deps.appendices],
    totalTokens: usage,
    ...(deps.costUsd === undefined ? {} : { costUsd: deps.costUsd }),
  };

  const html = buildReportHtml(document);

  const result: DeliverableResult = {
    theme: choice.themeId,
    rationale: choice.rationale,
  };

  // 3. Write the HTML. Kept beside the PDF deliberately: it is what the PDF was
  //    made from, so a styling complaint can be investigated without re-running
  //    anything, and it is a usable fallback when no browser exists.
  try {
    await store.writeReport(run.id, REPORT_HTML_PATH, html);
    result.htmlPath = REPORT_HTML_PATH;
  } catch (error) {
    log(`[${run.id}] could not write themed HTML: ${describe(error)}`);
  }

  // 4. Print. The only step that needs a browser, and the only one likely to be
  //    unavailable on a given machine.
  try {
    const outputPath = path.join(store.runDir(run.id), REPORT_PDF_PATH);
    const rendered = await renderPdf({ kind: 'html', html }, outputPath);
    result.pdfPath = REPORT_PDF_PATH;
    log(`[${run.id}] pdf: ${String(rendered.bytes)} bytes`);
  } catch (error) {
    // The reports survive; only the attachment is missing. Recorded on the run
    // so the UI can say why rather than showing an unexplained absence.
    result.pdfError = describe(error);
    log(`[${run.id}] no pdf: ${result.pdfError}`);
  }

  return result;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
