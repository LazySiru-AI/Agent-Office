/**
 * The floor and ceiling on which model an agent may actually run.
 *
 * ## Why a deployment-level policy and not a catalog edit
 *
 * The vendored catalog declares `model:` per agent — 105 `sonnet`, 25
 * `inherit`, 18 `haiku`, and 8 that say nothing. Those words are the *author's*
 * opinion about how hard each agent's job is, written against a different
 * deployment's cost tolerance and a model line-up that has since moved on. The
 * catalog is vendored, so editing 18 files to raise the cheap ones would be a
 * change that the next catalog refresh silently reverts, in a way nobody would
 * notice until a report came back thin.
 *
 * A policy applied at dispatch survives a catalog refresh, is stated in one
 * place, and — because it clamps rather than overwrites — leaves the agent's own
 * declaration intact for anyone reading the file to see what its author intended.
 *
 * ## Default: sonnet floor, opus ceiling
 *
 * `haiku` is not accepted for assignment work. An assignment here is a
 * specialist reading real code or documents and writing a report another agent
 * or a person will act on; the cheapest tier is the wrong tool for that, and the
 * saving is not worth a weak report that costs a re-run. The ceiling is `opus`
 * because there is nothing above it — it exists so the range is stated at both
 * ends rather than implied, and so raising the ceiling later is an edit to one
 * constant.
 *
 * ## What it deliberately does NOT touch
 *
 * - **`inherit`** passes through unchanged. It means "use whatever this
 *   deployment's engine defaults to", which is an explicit deference to the
 *   operator, and this policy is the operator's own instrument — clamping it
 *   would be the policy overriding the person who set the policy. The honest
 *   limit is worth stating: if a deployment's own default is a cheap model, 25
 *   `inherit` agents will run on it, and nothing here can see that.
 * - **An unrecognised word** passes through unchanged, for the same reason
 *   `pricing.ts` refuses to guess: a `model:` this code does not know is a model
 *   this code cannot rank, and silently rewriting it to `sonnet` would turn an
 *   author's deliberate choice of some future tier into a downgrade.
 * - **The Manager's own turns.** Planning and synthesis run on the run's
 *   provider default, never on a catalog `model:`, so there is nothing here to
 *   clamp. They are also the two turns you would least want quietly cheapened.
 * - **`npm run agent`**, the single-agent CLI, where `--model` is a person
 *   naming a model on purpose for one invocation.
 */

/** Cheapest first. The only ordering this module claims to know. */
export const MODEL_TIERS = ['haiku', 'sonnet', 'opus'] as const;

export type ModelTier = (typeof MODEL_TIERS)[number];

export const DEFAULT_MIN_MODEL: ModelTier = 'sonnet';
export const DEFAULT_MAX_MODEL: ModelTier = 'opus';

/** Env overrides, so a deployment can widen or narrow this without a code change. */
export const MIN_MODEL_ENV_VAR = 'AGENT_OFFICE_MIN_MODEL';
export const MAX_MODEL_ENV_VAR = 'AGENT_OFFICE_MAX_MODEL';

export interface ModelPolicy {
  min: ModelTier;
  max: ModelTier;
}

export const DEFAULT_MODEL_POLICY: ModelPolicy = {
  min: DEFAULT_MIN_MODEL,
  max: DEFAULT_MAX_MODEL,
};

function isTier(value: string): value is ModelTier {
  return (MODEL_TIERS as readonly string[]).includes(value);
}

function rank(tier: ModelTier): number {
  return MODEL_TIERS.indexOf(tier);
}

/**
 * Read the policy from the environment, falling back to the default.
 *
 * An unknown or inverted setting throws rather than degrading. A floor nobody
 * can read is worse than no floor: the whole value of this is that an operator
 * can state a rule and rely on it, and a typo that silently reverts to the
 * default would make every future "why did this run on haiku" unanswerable.
 */
export function resolveModelPolicy(env: NodeJS.ProcessEnv = process.env): ModelPolicy {
  const min = readTier(env, MIN_MODEL_ENV_VAR) ?? DEFAULT_MIN_MODEL;
  const max = readTier(env, MAX_MODEL_ENV_VAR) ?? DEFAULT_MAX_MODEL;

  if (rank(min) > rank(max)) {
    throw new Error(
      `${MIN_MODEL_ENV_VAR}=${min} is above ${MAX_MODEL_ENV_VAR}=${max}; ` +
        `the range is empty. Known tiers, cheapest first: ${MODEL_TIERS.join(', ')}.`,
    );
  }
  return { min, max };
}

function readTier(env: NodeJS.ProcessEnv, name: string): ModelTier | undefined {
  const raw = env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return undefined;
  if (!isTier(raw)) {
    throw new Error(
      `${name}="${env[name] ?? ''}" is not a known model tier. ` +
        `Known, cheapest first: ${MODEL_TIERS.join(', ')}.`,
    );
  }
  return raw;
}

export interface ModelDecision {
  /** What the agent should actually run on. `undefined` means "say nothing", as before. */
  model: string | undefined;
  /**
   * Set only when the policy changed the answer, and phrased for a human: this
   * string is what reaches `runs/diagnostics.jsonl`, where the question being
   * answered months later is "why did this agent run on something other than
   * what its file says".
   */
  reason?: string;
}

/**
 * Clamp one agent's declared `model:` into the policy's range.
 *
 * `declared` is the catalog's own word, verbatim and possibly absent. Absent is
 * left absent: an agent that names no model is deferring to the engine exactly
 * as `inherit` does, and inventing one here would mean 8 agents suddenly pinned
 * to a tier no author chose.
 */
export function applyModelPolicy(
  declared: string | undefined,
  policy: ModelPolicy = DEFAULT_MODEL_POLICY,
): ModelDecision {
  if (declared === undefined) return { model: undefined };

  const word = declared.trim().toLowerCase();
  if (!isTier(word)) return { model: declared };

  if (rank(word) < rank(policy.min)) {
    return {
      model: policy.min,
      reason: `${word} is below this deployment's floor; running on ${policy.min} instead`,
    };
  }
  if (rank(word) > rank(policy.max)) {
    return {
      model: policy.max,
      reason: `${word} is above this deployment's ceiling; running on ${policy.max} instead`,
    };
  }
  return { model: declared };
}
