import path from 'node:path';
import {
  estimateCostUsd,
  FREE_MODELS,
  REPORT_BUNDLE_PATH,
  REPORT_HTML_PATH,
  REPORT_PDF_PATH,
  runTotalUsage,
  type AssignmentState,
  type ReportDocument,
  type RosterEntry,
  type RunPlan,
  type RunState,
} from '@agent-office/shared';
import type { Registry } from '../registry/index.js';
import type { AgentProvider } from '../providers/types.js';
import type { RunStore } from '../store/types.js';
import { chooseTheme } from './designer.js';
import { buildMarkdownBundle } from './markdownExport.js';
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
  /**
   * Estimated run cost, when the caller can compute one (NFR-5).
   *
   * An authoritative override: pass this when the caller has tracked the
   * run's actual spend (e.g. per-turn cost from a provider that reports it)
   * and it takes priority over the estimate below. It is optional because
   * the one production caller today (`runner.ts`) does not populate it —
   * that gap is why every cover page used to show "—" regardless of what
   * the run spent. Left optional rather than made required so wiring an
   * authoritative figure in later is a pure addition, not a signature
   * change; until then `produceDeliverable` falls back to
   * {@link estimateRunCostUsd}, so the cover page is never blank for a
   * reason this module could have prevented.
   */
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

/**
 * Which model prices an assignment (NFR-5), mirroring the join
 * `packages/web/src/costModel.ts` performs client-side against the agent
 * roster over the wire — this is the server-side equivalent, reading the
 * same catalog `model:` frontmatter straight from `registry` instead. Kept
 * in step with `costModel.ts`'s `effectiveModelFor` deliberately: a `run.
 * provider` that names a free provider (`scripted`, `none`) prices at zero
 * regardless of the catalog, because those providers call no model at all;
 * every other provider is a provider id, not a pricing key, so it plays no
 * further part.
 *
 * D1: the catalog model is now only the FALLBACK. `assignment.model` — set by
 * `dispatcher.ts` once the deployment's model policy (`providers/
 * modelPolicy.ts`) has clamped the catalog word — is preferred when present,
 * because it is what actually ran. An agent declaring `haiku` under the
 * default sonnet floor has its assignment recorded as `sonnet`; pricing off
 * `registry`'s catalog word alone, as this function used to do
 * unconditionally, priced every one of those 18 vendored agents as `haiku`
 * forever, regardless of what they were actually billed as. Falling back to
 * the catalog word when `assignment.model` is absent is what keeps a
 * `run.json` written before this field existed pricing exactly as it did
 * before — see that field's doc comment in `shared/src/run.ts`.
 */
function modelForAssignment(
  assignment: AssignmentState,
  registry: Registry,
  runProvider: string | undefined,
): string | undefined {
  if (runProvider !== undefined && FREE_MODELS.has(runProvider)) return runProvider;
  return assignment.model ?? registry.byName.get(assignment.agentName)?.model;
}

/**
 * Best-effort whole-run cost (NFR-5), computed from data this module already
 * has to hand — `run.assignments`/`run.provider` and the registry's catalog
 * models — so the cover page has a real figure even on the day nothing in
 * `runner.ts` supplies {@link DeliverableDeps.costUsd} explicitly. This is
 * the fallback referenced in that field's doc comment, not a replacement for
 * it: an authoritative caller-supplied figure (real provider billing, once
 * one exists) should always win over this estimate.
 *
 * `undefined` only when not one priced-token's worth of usage could be
 * costed — e.g. every assignment's agent has an unpriced or missing catalog
 * model. A run that genuinely spent nothing prices at exactly `0`, which
 * `document.ts` renders as "$0.00"; this function only returns `undefined`
 * for genuine unknowns, never as a stand-in for zero. See `document.ts`'s
 * `renderCover` for how the two are told apart on the page.
 */
export function estimateRunCostUsd(run: RunState, registry: Registry): number | undefined {
  let costUsd: number | undefined;

  for (const assignment of run.assignments) {
    const model = modelForAssignment(assignment, registry, run.provider);
    const cost = estimateCostUsd(assignment.usage, model);
    if (cost !== undefined) costUsd = (costUsd ?? 0) + cost;
  }

  // The Manager's own turns (planning, repairs, synthesis) have no agent and
  // therefore no catalog model; they can only be priced when the run's
  // provider is a free one. See `costModel.ts`'s `summariseRunCost` for the
  // client-side twin of this same reasoning.
  if (run.managerUsage !== undefined) {
    const managerCost = estimateCostUsd(run.managerUsage, run.provider);
    if (managerCost !== undefined) costUsd = (costUsd ?? 0) + managerCost;
  }

  return costUsd;
}

/**
 * Doc2: how many characters of an objective the cover page's roster column
 * gets before this function starts cutting.
 *
 * A cover page's roster table is a fixed-width layout meant to be scanned,
 * not read — one line per agent. `shared/src/report.ts`'s `RosterEntry.role`
 * has always documented `role` as "trimmed for the cover"; the code simply
 * never did it, and a multi-sentence objective dumped whole into that column
 * either wrapped the table into unreadable multi-line rows or overflowed it,
 * depending on the renderer. 100 is not derived from a pixel measurement —
 * there is no fixed font or column width to measure against across HTML, PDF
 * and the markdown bundle — it is a "roughly one line at a table's normal
 * type size" budget, generous enough that the large majority of objectives in
 * this codebase's own plans (short, single-sentence, imperative) pass through
 * completely untouched.
 */
const ROSTER_ROLE_MAX_CHARS = 100;

/**
 * Doc2: shorten an assignment's objective for the roster's `role` column.
 *
 * Prefers the objective's first sentence — the boundary a reader would cut at
 * by hand, and one that (unlike a raw character slice) never lands mid-word.
 * Only falls back to a hard character budget when even the first sentence is
 * longer than {@link ROSTER_ROLE_MAX_CHARS}, or when the objective has no
 * terminal punctuation at all; that fallback still cuts on the last whole
 * word inside the budget, and marks the cut with an ellipsis so a reader can
 * tell the roster shortened it rather than the agent having written a
 * fragment.
 */
export function trimRoleForCover(objective: string): string {
  const text = objective.trim();

  const sentenceEnd = /[.!?](?=\s|$)/.exec(text);
  const firstSentence = sentenceEnd !== null ? text.slice(0, sentenceEnd.index + 1) : text;

  if (firstSentence.length <= ROSTER_ROLE_MAX_CHARS) return firstSentence;

  const budget = firstSentence.slice(0, ROSTER_ROLE_MAX_CHARS);
  const lastSpace = budget.lastIndexOf(' ');
  const cut = lastSpace > 0 ? budget.slice(0, lastSpace) : budget;
  return `${cut}…`;
}

/**
 * Doc5: the closed set of catalog category slugs (`categories/` at the repo
 * root), mapped to the label the cover page actually shows.
 *
 * `deliverable.ts` used to render `category` verbatim, so the roster printed
 * `04-quality-security` — the directory slug, numbered prefix and all,
 * because that number encodes nothing about display order the reader needs
 * (categories are not shown in numeric sequence on the cover) and every
 * hyphen is a directory-naming convention, not a word boundary a reader
 * benefits from seeing literally.
 *
 * Kept as an explicit map, not a generic "strip the number and title-case
 * it" transform applied universally, because two of the ten don't survive
 * that mechanically: `quality-security` and `business-product` read as
 * "Quality Security" / "Business Product" with the joining word lost, when
 * what the category actually means is "Quality & Security" / "Business &
 * Product". `formatCategoryLabel` below still has the generic transform, as
 * the fallback for anything not in this list — a category added to
 * `categories/` before this map is updated, or the literal `"unknown"`
 * `buildRoster` substitutes when an agent's category cannot be found at all.
 */
const CATEGORY_LABELS: Record<string, string> = {
  '01-core-development': 'Core Development',
  '02-language-specialists': 'Language Specialists',
  '03-infrastructure': 'Infrastructure',
  '04-quality-security': 'Quality & Security',
  '05-data-ai': 'Data & AI',
  '06-developer-experience': 'Developer Experience',
  '07-specialized-domains': 'Specialized Domains',
  '08-business-product': 'Business & Product',
  '09-meta-orchestration': 'Meta & Orchestration',
  '10-research-analysis': 'Research & Analysis',
};

/** Doc5: display label for a catalog category slug. See {@link CATEGORY_LABELS}. */
export function formatCategoryLabel(category: string): string {
  const known = CATEGORY_LABELS[category];
  if (known !== undefined) return known;

  // Generic fallback: strip a leading numeric prefix (`NN-`) if there is one,
  // then title-case each hyphen-separated word. This is what a slug this map
  // does not (yet) know about degrades to, rather than the raw slug — still
  // readable, even if it lacks a hand-picked joining word like the `&` cases
  // above. `|| category` guards the pathological empty-string input, which
  // would otherwise reduce to an empty label.
  const withoutPrefix = category.replace(/^\d+-/, '');
  const titled = withoutPrefix
    .split('-')
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
  return titled || category;
}

/** One roster row per assignment — including the ones that failed (FR-P4). */
export function buildRoster(run: RunState, registry: Registry): RosterEntry[] {
  return run.assignments.map((assignment) => ({
    agentName: assignment.agentName,
    // A renamed or removed agent must not break the cover page.
    category: formatCategoryLabel(registry.byName.get(assignment.agentName)?.category ?? 'unknown'),
    role: trimRoleForCover(assignment.objective),
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
  // `deps.costUsd` is the authoritative figure, when a caller supplies one;
  // `estimateRunCostUsd` is what stands between the cover page and an
  // unconditional "—" until one does. See both doc comments above.
  const costUsd = deps.costUsd ?? estimateRunCostUsd(run, deps.registry);
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
    ...(costUsd === undefined ? {} : { costUsd }),
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

  // FR-P6. Same document, same moment, so the markdown alternative cannot
  // disagree with the HTML and PDF built beside it. Failing to write it is
  // logged and otherwise ignored, exactly as the HTML above is: an export that
  // could not be written must not fail a run whose report is already on disk.
  try {
    await store.writeReport(run.id, REPORT_BUNDLE_PATH, buildMarkdownBundle(document));
  } catch (error) {
    log(`[${run.id}] could not write the markdown bundle: ${describe(error)}`);
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
