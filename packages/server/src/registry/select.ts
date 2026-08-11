import type { AgentDef } from '@agent-office/shared';
import type { Registry } from './index.js';

/**
 * FR-R4: pre-filter the roster to the top ~40 candidates for a task, so the
 * Manager's planning prompt (FR-R3) stays small — and, more importantly, so the
 * Manager is shown the *right* specialists rather than 154 of them in no
 * particular order. `selectCandidates` feeds `PlanningPromptOptions.candidateAgents`
 * in `orchestrator/manager.ts`.
 *
 * Ranking is BM25 (Robertson/Sparck Jones), the standard term-weighting scheme
 * for exactly this problem: rank documents (here, agents) against a short
 * free-text query (here, the task) using term frequency, inverse document
 * frequency and document-length normalisation. It needs no training data and
 * no embeddings — appropriate for 154 documents that will be re-scored fresh
 * on every task.
 */

/** Default candidate count (FR-R4: "top ~40"). */
export const DEFAULT_CANDIDATE_LIMIT = 40;

// ---------------------------------------------------------------------------
// BM25 tuning
// ---------------------------------------------------------------------------

/**
 * Term-frequency saturation. Okapi BM25's k1 controls how much a *repeated*
 * occurrence of a query term keeps adding to the score: at k1=0 a single hit is
 * worth as much as a hundred; as k1 grows, extra occurrences keep mattering for
 * longer. 1.2 is the value BM25 is conventionally deployed with (Robertson et
 * al.) and there is no task-specific reason to depart from it — these
 * documents are one or two sentences long, so saturation rarely even binds.
 */
const BM25_K1 = 1.2;

/**
 * Document-length normalisation. b=0 ignores document length entirely; b=1
 * penalises long documents in direct proportion to how far they exceed the
 * corpus average. 0.75 is, again, the conventional default. It matters here
 * because agent descriptions vary genuinely in length (some are one clause,
 * some enumerate half a dozen use cases) and an unnormalised score would just
 * reward verbosity.
 */
const BM25_B = 0.75;

/**
 * Per-field weight, implemented by counting a field's tokens that many times
 * over when building an agent's term frequencies. This is a deliberately
 * simple stand-in for full BM25F (which would track per-field length
 * normalisation separately) — the roster only has three short fields, and
 * "count `name` three times" is legible in a way a second normalisation
 * constant per field would not be.
 *
 * `name` outweighs `description` and `category`: FR-R4 exists so an agent
 * literally called `tax-advisor` wins a tax query even in the (common) case
 * where its description talks about "corporate structuring" rather than
 * repeating the word "tax".
 */
const NAME_FIELD_WEIGHT = 3;
const DESCRIPTION_FIELD_WEIGHT = 1;
const CATEGORY_FIELD_WEIGHT = 1;

// ---------------------------------------------------------------------------
// Tokenisation
// ---------------------------------------------------------------------------

/**
 * Closed-class English glue words only — articles, prepositions and
 * conjunctions that carry no domain signal in *any* task. Deliberately short:
 * this catalog's own descriptions are written imperatively ("Use this agent
 * when…"), and words like "when" or "use" could plausibly be meaningful in a
 * future task (e.g. a scheduling or tooling query), so they are left in
 * rather than guessed at. BM25's own idf term already suppresses words that
 * appear in nearly every document (see {@link idf}); this list exists only to
 * stop the obviously noisy ones from cluttering `CandidateScore.matched`.
 */
const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'but',
  'by',
  'for',
  'from',
  'in',
  'into',
  'is',
  'it',
  'of',
  'on',
  'or',
  'that',
  'the',
  'to',
  'with',
]);

/**
 * Fold a regular English plural onto its singular, and nothing else.
 *
 * This exists because of a measured failure, not on principle. The Phase 6
 * routing matrix asked for help with a "payments service" and BM25 ranked
 * `payment-integration` — by a distance the most relevant agent in the catalog
 * — at exactly zero, because the task says *payments* and the agent says
 * *payment*. A single trailing `s` hid it completely. Literal-token matching
 * has no notion that those are the same word.
 *
 * Deliberately not a real stemmer. Porter would also fold `-ing`, `-ed`, `-ate`
 * and more, and in a corpus this small each extra rule collapses distinctions
 * that are load-bearing: `testing` and `test`, `generated` and `generate`,
 * `compliance` and `comply`. Plurals are the one case where the two forms
 * always mean the same thing, so it is the one case worth folding. The
 * `-ss`/`-us`/`-is` guards keep `compliance`… `analysis`, `status` and `access`
 * from being mangled into nonsense.
 */
function singularise(token: string): string {
  if (token.length <= 3) return token;
  if (/(?:ss|us|is)$/.test(token)) return token;
  if (/ies$/.test(token)) return `${token.slice(0, -3)}y`;
  if (/(?:ch|sh|x|z|s)es$/.test(token)) return token.slice(0, -2);
  if (/s$/.test(token)) return token.slice(0, -1);
  return token;
}

/**
 * Lowercase, split on anything that is not a Unicode letter or digit, drop
 * stopwords, fold plurals. `\p{L}`/`\p{N}` (rather than `\w`) is what keeps
 * this from throwing or silently mangling non-Latin task text — `\w` is
 * ASCII-only.
 *
 * `tax-advisor` -> `["tax", "advisor"]`; `payments` -> `["payment"]`.
 *
 * Stopwords are removed *before* singularising, so a stopword list written in
 * plural form would not silently stop matching.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0 && !STOPWORDS.has(token))
    .map(singularise);
}

// ---------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------

interface AgentDocument {
  agent: AgentDef;
  /** term -> weighted count (per {@link NAME_FIELD_WEIGHT} etc). Drives the score. */
  termFrequency: ReadonlyMap<string, number>;
  /** term -> whether it appears at all, unweighted. Drives df and `matched`. */
  presentTerms: ReadonlySet<string>;
  /** Sum of weighted term frequencies; BM25's "document length". */
  length: number;
}

function buildDocument(agent: AgentDef): AgentDocument {
  const termFrequency = new Map<string, number>();
  const presentTerms = new Set<string>();

  const addField = (text: string, weight: number): void => {
    for (const token of tokenize(text)) {
      presentTerms.add(token);
      termFrequency.set(token, (termFrequency.get(token) ?? 0) + weight);
    }
  };

  // Deliberately NOT indexing `systemPrompt`: it runs to thousands of words of
  // largely generic professional-persona prose per agent (see PLAN.md's note
  // that 154 *descriptions* alone already run 8-11k tokens — bodies are far
  // larger again), and almost all of it is boilerplate shared across agents in
  // the same category ("You are a senior X with expertise in..."). Indexing it
  // would let that shared boilerplate dominate term frequencies and drown the
  // few words that actually distinguish one agent from another — the opposite
  // of what FR-R4 is for. `name`, `description` and `category` are exactly the
  // fields the Manager itself reads off the roster digest (FR-R3) to choose a
  // team, so scoring against them is also scoring against what the Manager
  // actually sees.
  addField(agent.name, NAME_FIELD_WEIGHT);
  addField(agent.description, DESCRIPTION_FIELD_WEIGHT);
  addField(agent.category, CATEGORY_FIELD_WEIGHT);

  let length = 0;
  for (const count of termFrequency.values()) length += count;

  return { agent, termFrequency, presentTerms, length };
}

function documentFrequency(documents: readonly AgentDocument[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const doc of documents) {
    for (const term of doc.presentTerms) {
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  }
  return df;
}

/**
 * Okapi BM25 idf, using the "+1 inside the log" variant rather than the
 * original Robertson-Sparck Jones formula. The original can go negative for a
 * term that appears in more than half the corpus, which would let a common
 * word actively *punish* an agent for matching it; `1 + ...` floors idf at a
 * small positive number instead, so a ubiquitous term just stops mattering
 * rather than starting to hurt.
 */
function idf(term: string, df: ReadonlyMap<string, number>, totalDocs: number): number {
  const docFrequency = df.get(term) ?? 0;
  return Math.log(1 + (totalDocs - docFrequency + 0.5) / (docFrequency + 0.5));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CandidateScore {
  agent: AgentDef;
  score: number;
  /** Which query terms actually matched this agent, for explainability. */
  matched: string[];
}

/**
 * Rank every agent in the registry against `task` by BM25, best first.
 *
 * Deterministic: identical inputs always produce an identical array, and tied
 * scores break on `agent.name` ascending rather than depending on input order
 * or engine sort behaviour. This matters beyond tidiness — a task that matches
 * no term in the corpus (rare in practice, but exactly what a "zzzz qqqq" style
 * nonsense query produces) scores every agent 0, and the name tie-break is what
 * turns that into a stable default ordering instead of an arbitrary one. That
 * ordering is deliberately alphabetical rather than, say, registry/file order,
 * so it is obviously a fallback rather than something that looks meaningful.
 *
 * Never returns an empty array for a non-empty registry, for the same reason:
 * every agent gets a score (possibly 0) and a place in the output.
 */
export function rankCandidates(registry: Registry, task: string): CandidateScore[] {
  const documents = registry.agents.map(buildDocument);
  const totalDocs = documents.length;
  if (totalDocs === 0) return [];

  const df = documentFrequency(documents);
  const totalLength = documents.reduce((sum, doc) => sum + doc.length, 0);
  // Guard divide-by-zero: only reachable if every document tokenised to
  // nothing, which cannot happen for a real registry (`name` is non-empty by
  // AgentDefSchema), but a synthetic fixture in a test could still hit it.
  const avgLength = totalLength / totalDocs || 1;

  // De-duplicated: BM25's term-frequency saturation lives in the *document*
  // side of the formula. Repeating a query term does not entitle it to be
  // counted twice — a task that says "tax tax tax" should not outscore one
  // that says "tax" once.
  const queryTerms = [...new Set(tokenize(task))];

  const scored: CandidateScore[] = documents.map((doc) => {
    let score = 0;
    const matched: string[] = [];

    for (const term of queryTerms) {
      const frequency = doc.termFrequency.get(term) ?? 0;
      if (frequency === 0) continue;

      matched.push(term);
      const termIdf = idf(term, df, totalDocs);
      const lengthNorm = 1 - BM25_B + (BM25_B * doc.length) / avgLength;
      score += (termIdf * (frequency * (BM25_K1 + 1))) / (frequency + BM25_K1 * lengthNorm);
    }

    return { agent: doc.agent, score, matched };
  });

  return scored.sort(
    (a, b) => b.score - a.score || a.agent.name.localeCompare(b.agent.name, 'en'),
  );
}

/**
 * The top `limit` agent names by BM25 score, best first — this is the shape
 * `PlanningPromptOptions.candidateAgents` (`orchestrator/manager.ts`) wants.
 *
 * `limit` beyond the roster size is clamped by `Array.prototype.slice`, which
 * simply returns everything it has — no special-casing needed, and it means a
 * 200-agent future catalog with `limit: 40` and a 30-agent test fixture with
 * `limit: 40` both do the obviously-correct thing. A non-positive `limit` is
 * rejected outright rather than silently clamped to some default: silently
 * returning, say, all 154 agents for `limit: 0` would defeat the entire point
 * of FR-R4 without ever telling the caller.
 */
export function selectCandidates(
  registry: Registry,
  task: string,
  options: { limit?: number } = {},
): string[] {
  const limit = options.limit ?? DEFAULT_CANDIDATE_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`selectCandidates: limit must be a positive integer, got ${limit}.`);
  }

  return rankCandidates(registry, task)
    .slice(0, limit)
    .map((candidate) => candidate.agent.name);
}
