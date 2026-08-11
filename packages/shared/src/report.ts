import { z } from 'zod';

/**
 * The report/PDF contract (PLAN.md Phase 5, FR-P1–FR-P5).
 *
 * Three things live here because both sides need them and neither owns them:
 * the closed set of themes, the designer step's output shape, and the metadata
 * a cover page is built from.
 *
 * The theme set is deliberately closed. FR-P2 asks a *model* to choose a theme,
 * and a model asked to name a theme will eventually invent one — "corporate
 * modern", "clean minimal" — so the choice is validated against this union and
 * falls back rather than propagating a name no stylesheet exists for. That is
 * the same discipline `RunPlanSchema` applies to agent names (FR-M3), for the
 * same reason.
 */

export const REPORT_THEME_IDS = ['engineering', 'legal', 'financial', 'research'] as const;

export const ReportThemeIdSchema = z.enum(REPORT_THEME_IDS);
export type ReportThemeId = (typeof REPORT_THEME_IDS)[number];

/**
 * What each theme is *for*, in the designer's own prompt.
 *
 * Kept next to the ids rather than inside the server's theme module because the
 * designer prompt and the stylesheet must describe the same thing. Splitting
 * them is how a theme comes to be chosen for reasons its styling does not
 * reflect.
 */
export const REPORT_THEME_BRIEFS: Record<ReportThemeId, string> = {
  engineering:
    'Software, infrastructure, security and technical review work. Monospaced code, dense tables, terse captions.',
  legal:
    'Contracts, compliance, regulatory and policy work. Serif body, numbered clauses, generous margins, formal register.',
  financial:
    'Tax, accounting, valuation and risk work. Tabular figures, aligned numerals, restrained rules and totals.',
  research:
    'Investigation, literature review, market and product research. Readable long-form prose, pull quotes, clear source lists.',
};

/**
 * The designer agent's structured output (FR-P2).
 *
 * `rationale` is not decoration: it is shown to the user beside the download, so
 * a wrong-looking theme can be understood rather than merely disliked. It is
 * also the only signal for whether the designer reasoned or guessed.
 */
export const DesignChoiceSchema = z.object({
  themeId: ReportThemeIdSchema,
  rationale: z.string().min(1).max(2_000),
});

export type DesignChoice = z.infer<typeof DesignChoiceSchema>;

/** One line of the cover page's team roster (FR-P4). */
export const RosterEntrySchema = z.object({
  agentName: z.string().min(1),
  /** The agent's own catalog category, e.g. `08-business-product`. */
  category: z.string(),
  /** This assignment's objective, trimmed for the cover. */
  role: z.string(),
  status: z.string(),
});

export type RosterEntry = z.infer<typeof RosterEntrySchema>;

/**
 * Everything the document builder needs, gathered before any HTML exists.
 *
 * A single input object rather than a pile of parameters, so the assembly step
 * is a pure function of it — which is what lets the whole document be tested
 * without a run, a store or a browser.
 */
export const ReportDocumentSchema = z.object({
  runId: z.string().min(1),
  task: z.string(),
  /** Epoch ms; rendered on the cover. */
  generatedAt: z.number().int().nonnegative(),
  domain: z.string(),
  theme: ReportThemeIdSchema,
  rationale: z.string().optional(),
  roster: z.array(RosterEntrySchema),
  /** The Manager's synthesis, as markdown. */
  synthesisMarkdown: z.string(),
  /** Per-agent appendices, in dispatch order. */
  appendices: z.array(
    z.object({
      agentName: z.string().min(1),
      path: z.string(),
      markdown: z.string(),
    }),
  ),
  /** Rendered on the cover for NFR-5 visibility. */
  totalTokens: z.object({ inputTokens: z.number(), outputTokens: z.number() }),
  costUsd: z.number().optional(),
});

export type ReportDocument = z.infer<typeof ReportDocumentSchema>;

/** Where the PDF is written, run-relative. Mirrors `SYNTHESIS_REPORT_PATH`. */
export const REPORT_PDF_PATH = 'report.pdf';
/** The themed HTML is kept beside it — it is what the PDF was made from. */
export const REPORT_HTML_PATH = 'report.html';
