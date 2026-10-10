import path from 'node:path';
import type { ReportDocument, RunState } from '@agent-office/shared';
import { buildAgentReportHtml } from '../reports/agentExport.js';
import { buildRoster } from '../reports/deliverable.js';
import { coerceThemeId } from '../reports/document.js';
import { renderPdf } from '../reports/pdf.js';
import type { Registry } from '../registry/index.js';
import type { RunStore } from '../store/types.js';

/**
 * FR-P6: one agent's report as a PDF, rendered on demand and cached.
 *
 * ## Why on demand rather than at `designing` time
 *
 * The obvious alternative is to render every agent's PDF when the run finishes,
 * beside `report.pdf` and `report.bundle.md`. It was rejected on cost: each
 * render launches headless Chromium, a four-agent run would pay five launches
 * instead of one, and the overwhelming majority of those files would never be
 * opened — the combined PDF is what people download. Rendering the one someone
 * actually asked for spends the same work only when it is wanted.
 *
 * The markdown bundle went the other way for a reason that does not apply here:
 * it is a pure string transform of a document that exists only during the
 * designing step, so producing it later would mean reconstructing that document
 * and risking disagreement with the PDF beside it. A per-agent PDF needs only
 * ONE appendix plus run-level facts, all of which survive on disk in `run.json`
 * and the report file itself.
 *
 * ## Cached beside the markdown
 *
 * The result is written as the sibling of the source: `reports/03-x.md` renders
 * to `reports/03-x.pdf`. That makes a second request a file read, keeps the
 * artifact inside the run directory where `runs:purge` will eventually collect
 * it with everything else, and means the file is discoverable by someone
 * browsing the run rather than living in a temp directory nobody looks in.
 *
 * ## Two requests for the same agent
 *
 * A single in-flight map keyed by run and path. Without it, two clicks a second
 * apart launch two Chromium processes writing the same output file, and the
 * loser's bytes are whatever interleaving produced — this is the same
 * single-flight discipline `dispatcher.ts` applies to concurrent reviewers, for
 * the same reason.
 */

/** Renders in flight, keyed `runId::reports/NN-agent.md`. */
const inFlight = new Map<string, Promise<Buffer>>();

export interface AgentPdfDeps {
  store: RunStore;
  registry: Registry;
  run: RunState;
  /** Run-relative markdown path, already containment-checked by the caller. */
  reportPath: string;
  /** The report's markdown, already read (and thereby path-validated). */
  markdown: string;
}

/**
 * The PDF's path for a given report, as a run-relative path.
 *
 * Derived from the markdown's own path rather than composed from an agent name:
 * the markdown path has already passed the store's containment check, and a
 * sibling with a different extension cannot escape a directory the original did
 * not. Composing a fresh path from a model-supplied agent name would reintroduce
 * exactly the untrusted-input problem NFR-1 exists to prevent.
 */
export function agentPdfPathFor(reportPath: string): string {
  const ext = path.extname(reportPath);
  return ext === '' ? `${reportPath}.pdf` : `${reportPath.slice(0, -ext.length)}.pdf`;
}

/**
 * Read the cached PDF, or render it once and return the bytes.
 *
 * Never renders twice concurrently for the same report. A render failure
 * propagates to the caller — unlike the diagnostics log, this IS the thing the
 * request asked for, so failing quietly with an empty body would be worse than
 * an error naming what went wrong.
 */
export async function readOrRenderAgentPdf(deps: AgentPdfDeps): Promise<Buffer> {
  const { store, registry, run, reportPath, markdown } = deps;
  const pdfPath = agentPdfPathFor(reportPath);

  try {
    return await store.readBinary(run.id, pdfPath);
  } catch {
    // Not rendered yet. Fall through — a missing cache entry is the normal
    // first-request case, not an error worth reporting.
  }

  const key = `${run.id}::${reportPath}`;
  const existing = inFlight.get(key);
  if (existing !== undefined) return existing;

  const rendering = (async (): Promise<Buffer> => {
    const document = documentForOneReport({ registry, run, reportPath, markdown });
    const html = buildAgentReportHtml(document, 0);
    const outputPath = path.join(store.runDir(run.id), pdfPath);

    await renderPdf({ kind: 'html', html }, outputPath);
    return store.readBinary(run.id, pdfPath);
  })().finally(() => {
    inFlight.delete(key);
  });

  inFlight.set(key, rendering);
  return rendering;
}

/**
 * A `ReportDocument` carrying exactly one appendix.
 *
 * `buildAgentReportHtml` reads `runId`, `task`, `generatedAt`, `domain`, `theme`,
 * the appendix and the roster — every one of which survives in `run.json`, so
 * nothing here is invented. `generatedAt` is the RUN's `updatedAt`, not
 * `Date.now()`: the document is a rendering of work that finished at a
 * particular time, and stamping it with "when someone clicked download" would
 * make two downloads of one report disagree about their own date.
 *
 * `synthesisMarkdown` is empty and the appendix list holds one entry, which is
 * the whole point — this document IS one agent's report, not the run's.
 */
function documentForOneReport(input: {
  registry: Registry;
  run: RunState;
  reportPath: string;
  markdown: string;
}): ReportDocument {
  const { registry, run, reportPath, markdown } = input;
  const assignment = run.assignments.find((a) => a.reportPath === reportPath);
  const agentName = assignment?.agentName ?? path.basename(reportPath, path.extname(reportPath));

  return {
    runId: run.id,
    task: run.task,
    generatedAt: run.updatedAt,
    domain: run.plan?.domain ?? 'general',
    // `coerceThemeId` is the same helper `deliverable.ts` uses, so an unknown or
    // absent theme lands on the same fallback the PDF beside it would have used
    // rather than a second opinion invented here.
    theme: coerceThemeId(run.theme),
    rationale: run.designRationale ?? '',
    roster: buildRoster(run, registry),
    synthesisMarkdown: '',
    appendices: [{ agentName, path: reportPath, markdown }],
    totalTokens: assignment?.usage ?? { inputTokens: 0, outputTokens: 0 },
  };
}

