import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { AgentDef } from '@agent-office/shared';
import { buildRegistry, buildRosterDigest, estimateTokens, loadRegistry } from './index.js';
import { DEFAULT_CANDIDATE_LIMIT, rankCandidates, selectCandidates } from './select.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** `src/registry` -> src -> server -> packages -> repo root. Matches index.test.ts. */
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');

/**
 * Synchronous, filename-only scan for `<name>.md` under `categories/`. Used
 * only to decide, at test-collection time, whether the tax-advisor-specific
 * assertion below should run or be cleanly `it.skip`-ped — a full
 * `loadRegistry` is async and this needs an answer before `describe` bodies
 * run, so it deliberately does not reuse the real parser.
 */
function agentFileExistsSync(repoRoot: string, name: string): boolean {
  const target = `${name.toLowerCase()}.md`;
  const stack = [path.join(repoRoot, 'categories')];

  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) break;

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.toLowerCase() === target) {
        return true;
      }
    }
  }
  return false;
}

const TAX_ADVISOR_EXISTS = agentFileExistsSync(REPO_ROOT, 'tax-advisor');

// ---------------------------------------------------------------------------
// A small synthetic registry for the unit-level tests below. Kept deliberately
// tiny and hand-legible: the real 154-agent registry is exercised separately,
// in the routing-matrix describe block, where the actual field data matters.
// ---------------------------------------------------------------------------

function agent(overrides: Partial<AgentDef> & Pick<AgentDef, 'name'>): AgentDef {
  return {
    description: `${overrides.name} does things.`,
    tools: ['Read'],
    category: '01-core-development',
    filePath: `categories/01-core-development/${overrides.name}.md`,
    systemPrompt: `You are ${overrides.name}.`,
    ...overrides,
  };
}

const SYNTHETIC_AGENTS: AgentDef[] = [
  agent({
    name: 'tax-advisor',
    description: 'Advises on corporate tax structuring and filings.',
    category: '08-business-product',
  }),
  agent({
    name: 'backend-developer',
    description: 'Builds server-side APIs and backend systems.',
    category: '01-core-development',
  }),
  agent({
    name: 'security-auditor',
    description: 'Conducts security audits and risk evaluations.',
    category: '04-quality-security',
  }),
  agent({
    name: 'zeta-agent',
    description: 'Has no overlap with any query used in these tests.',
    category: '07-specialized-domains',
  }),
  agent({
    name: 'alpha-agent',
    description: 'Also has no overlap with any query used in these tests.',
    category: '07-specialized-domains',
  }),
];

const SYNTHETIC_REGISTRY = buildRegistry(SYNTHETIC_AGENTS);

describe('rankCandidates: BM25 fundamentals', () => {
  it('ranks an agent whose name matches the query above one that only matches loosely', () => {
    // "tax-advisor" tokenises to ["tax", "advisor"]; the name field is
    // weighted highest (FR-R4 brief: "an agent literally called `tax-advisor`
    // should win a tax query").
    const ranked = rankCandidates(SYNTHETIC_REGISTRY, 'tax advice needed');
    expect(ranked[0]?.agent.name).toBe('tax-advisor');
  });

  it('records which query terms actually matched, for explainability', () => {
    const ranked = rankCandidates(SYNTHETIC_REGISTRY, 'tax advisor structuring');
    const top = ranked.find((candidate) => candidate.agent.name === 'tax-advisor');
    expect(top?.matched.sort()).toEqual(['advisor', 'structuring', 'tax']);
  });

  it('gives a zero score, not a crash, to an agent that shares no terms with the query', () => {
    const ranked = rankCandidates(SYNTHETIC_REGISTRY, 'tax advisor structuring');
    const zeta = ranked.find((candidate) => candidate.agent.name === 'zeta-agent');
    expect(zeta?.score).toBe(0);
    expect(zeta?.matched).toEqual([]);
  });

  it('does not double-count a query term repeated in the task text', () => {
    // "tax" appearing three times must not outscore it appearing once — term
    // frequency saturation lives on the document side of BM25, not the query
    // side; repeating the query is not a way to inflate a match.
    const once = rankCandidates(SYNTHETIC_REGISTRY, 'tax')[0];
    const repeated = rankCandidates(SYNTHETIC_REGISTRY, 'tax tax tax')[0];
    expect(once?.score).toBe(repeated?.score);
  });
});

describe('rankCandidates: determinism', () => {
  it('returns byte-for-byte identical results across repeated calls with the same inputs', () => {
    const first = rankCandidates(SYNTHETIC_REGISTRY, 'security audit for the backend API');
    const second = rankCandidates(SYNTHETIC_REGISTRY, 'security audit for the backend API');

    expect(first.map((c) => [c.agent.name, c.score, c.matched])).toEqual(
      second.map((c) => [c.agent.name, c.score, c.matched]),
    );
  });

  it('breaks tied scores by agent name ascending', () => {
    // "zzzz qqqq" matches nothing, so every agent scores exactly 0 and the
    // entire ordering is decided by the tie-break.
    const ranked = rankCandidates(SYNTHETIC_REGISTRY, 'zzzz qqqq');
    const names = ranked.map((c) => c.agent.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, 'en')));
  });
});

describe('rankCandidates: never returns an empty list for a non-empty roster', () => {
  it('still returns every agent for a task matching nothing in the corpus', () => {
    const ranked = rankCandidates(SYNTHETIC_REGISTRY, 'zzzz qqqq');
    expect(ranked).toHaveLength(SYNTHETIC_AGENTS.length);
    expect(ranked.length).toBeGreaterThan(0);
  });

  it('selectCandidates likewise still returns names, falling back to a stable default order', () => {
    const names = selectCandidates(SYNTHETIC_REGISTRY, 'zzzz qqqq');
    expect(names.length).toBe(SYNTHETIC_AGENTS.length);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, 'en')));
  });
});

describe('rankCandidates: inputs that must never throw', () => {
  it.each([
    ['an empty task', ''],
    ['a whitespace-only task', '   \n\t  '],
    ['a task of pure stopwords', 'the a of and or to in on with is are'],
    ['a very long task', 'security audit backend retry logic '.repeat(2000)],
    [
      'a task with punctuation and unicode',
      "Review the café's façade — 你好, world!! What's the ROI?? (tax@advisor.example) #urgent",
    ],
  ])('does not throw for %s', (_label, task) => {
    expect(() => rankCandidates(SYNTHETIC_REGISTRY, task)).not.toThrow();
    expect(() => selectCandidates(SYNTHETIC_REGISTRY, task)).not.toThrow();

    // And still produces a full, non-empty ranking in every case.
    const ranked = rankCandidates(SYNTHETIC_REGISTRY, task);
    expect(ranked).toHaveLength(SYNTHETIC_AGENTS.length);
  });
});

describe('selectCandidates: limit handling', () => {
  it('defaults to DEFAULT_CANDIDATE_LIMIT (40)', () => {
    expect(DEFAULT_CANDIDATE_LIMIT).toBe(40);
  });

  it('returns the top `limit` names, best first', () => {
    const names = selectCandidates(SYNTHETIC_REGISTRY, 'tax advisor structuring', { limit: 2 });
    expect(names).toEqual(['tax-advisor', ...names.slice(1)]);
    expect(names).toHaveLength(2);
  });

  it('returns the whole roster when `limit` exceeds the roster size', () => {
    const names = selectCandidates(SYNTHETIC_REGISTRY, 'tax advisor', { limit: 1000 });
    expect(names).toHaveLength(SYNTHETIC_AGENTS.length);
    expect(new Set(names)).toEqual(new Set(SYNTHETIC_AGENTS.map((a) => a.name)));
  });

  it('rejects a limit of 0 with a clear Error rather than silently clamping', () => {
    expect(() => selectCandidates(SYNTHETIC_REGISTRY, 'tax', { limit: 0 })).toThrow(
      /limit must be a positive integer/,
    );
  });

  it('rejects a negative limit with a clear Error', () => {
    expect(() => selectCandidates(SYNTHETIC_REGISTRY, 'tax', { limit: -5 })).toThrow(
      /limit must be a positive integer/,
    );
  });

  it('rejects a non-integer limit', () => {
    expect(() => selectCandidates(SYNTHETIC_REGISTRY, 'tax', { limit: 2.5 })).toThrow(
      /limit must be a positive integer/,
    );
  });
});

// ---------------------------------------------------------------------------
// The routing matrix: does BM25 actually surface the right specialists from
// the real 154-agent catalog? This is the point of FR-R4, so it is tested
// against `loadRegistry(REPO_ROOT)`, not a synthetic fixture.
// ---------------------------------------------------------------------------

describe('routing matrix against the real registry', () => {
  it('resolves a repo root that actually contains the categories directory', () => {
    expect(existsSync(path.join(REPO_ROOT, 'categories'))).toBe(true);
  });

  /** Top-10: generous enough that a reasonable team assembled by hand would
   * fit inside it, tight enough that "everything scored above zero" doesn't
   * trivially pass. The Manager only needs its short-list to contain the
   * right specialists somewhere near the top, not to rank them perfectly. */
  const TOP_N = 10;

  function printRanking(label: string, ranked: readonly ReturnType<typeof rankCandidates>[number][]): void {
    // eslint-disable-next-line no-console
    console.log(
      `\n[routing matrix] ${label} — top ${TOP_N}:\n` +
        ranked
          .slice(0, TOP_N)
          .map(
            (c, i) =>
              `  ${i + 1}. ${c.agent.name} (score=${c.score.toFixed(3)}, matched=[${c.matched.join(', ')}])`,
          )
          .join('\n'),
    );
  }

  // Only the domains where BM25 actually does the job it is meant to do live
  // in this table. `software` and `research` are documented separately below
  // as known-bad — see the comments there for why folding them in here would
  // mean either a red suite or a quietly weakened assertion, neither of which
  // this task brief wants.
  const DOMAINS = [
    {
      label: 'legal',
      task: 'Review our vendor NDA for unusual liability and termination terms',
      // legal-advisor is the only dedicated legal specialist in the catalog
      // (verified: `categories/08-business-product/legal-advisor.md`, no
      // sibling "contracts" or "compliance-lawyer" agent exists).
      mustAppearInTopN: ['legal-advisor'],
      mustNotCrowdTopN: ['backend-developer', 'kubernetes-specialist', 'market-researcher'],
    },
    {
      label: 'product',
      task: 'Prioritise the Q3 roadmap and define success metrics for the new onboarding flow',
      // product-manager: categories/08-business-product/product-manager.md.
      mustAppearInTopN: ['product-manager'],
      mustNotCrowdTopN: ['kubernetes-specialist', 'legal-advisor', 'penetration-tester'],
    },
  ] as const;

  it.each(DOMAINS)(
    'ranks plausible $label specialists in the top 10 without implausible agents crowding them out',
    async ({ label, task, mustAppearInTopN, mustNotCrowdTopN }) => {
      const registry = await loadRegistry(REPO_ROOT);
      const ranked = rankCandidates(registry, task);
      const top = ranked.slice(0, TOP_N).map((c) => c.agent.name);

      printRanking(label, ranked);

      for (const name of mustAppearInTopN) {
        expect(registry.get(name), `fixture agent "${name}" must exist in the registry`).toBeDefined();
        expect(top, `expected "${name}" in the ${label} top ${TOP_N}`).toContain(name);
      }
      for (const name of mustNotCrowdTopN) {
        expect(top, `expected "${name}" NOT in the ${label} top ${TOP_N}`).not.toContain(name);
      }
    },
  );

  // ---------------------------------------------------------------------
  // KNOWN-BAD: software domain.
  //
  // "Review the payments service for authentication bugs and refactor the
  // retry logic" is, to a human, an obvious job for backend-developer,
  // security-auditor and payment-integration (all three verified present
  // under categories/). BM25 does not deliver that team:
  //
  //   #1 ad-security-reviewer  — an Active Directory security specialist
  //      (categories/04-quality-security/ad-security-reviewer.md: "audit
  //      Active Directory security posture ... assess authentication
  //      protocol hardening"). It wins purely because its description
  //      happens to contain the literal words "review" and "authentication"
  //      — a coincidental collision with a domain that has nothing to do
  //      with the task.
  //
  //   security-auditor never scores at all: the task never says "security"
  //   or "audit" in those exact words.
  //
  //   backend-developer never scores at all: the task never says "backend",
  //   "API" or "server".
  //
  //   payment-integration originally never scored at all, and that was the
  //   sharpest version of the underlying problem: the task says "payments"
  //   (plural), the agent's name and description say "payment" (singular), and
  //   plain BM25 has no stemming. A single trailing "s" was the entire reason
  //   the single most relevant agent in the catalog was invisible to the
  //   ranker.
  //
  // That specific defect was fixed, after it was measured, by folding regular
  // plurals in `singularise()` — see the comment there for why plurals and
  // nothing else. `payment-integration` now ranks #2 and `fintech-engineer`
  // enters the top 10. The rest of the finding stands and is asserted below:
  // the coincidental collision still wins the top slot, and two of the three
  // agents a human would pick still never score.
  it('software task — plural folding recovers the payment specialists, but a coincidental collision still wins', async () => {
    const registry = await loadRegistry(REPO_ROOT);
    const task = 'Review the payments service for authentication bugs and refactor the retry logic';
    const ranked = rankCandidates(registry, task);
    const top = ranked.slice(0, TOP_N).map((c) => c.agent.name);

    printRanking('software', ranked);

    for (const name of ['ad-security-reviewer', 'backend-developer', 'security-auditor', 'payment-integration']) {
      expect(registry.get(name), `fixture agent "${name}" must exist in the registry`).toBeDefined();
    }

    // Fixed: "payments" now reaches "payment".
    expect(top, 'plural folding should surface the payment specialist').toContain(
      'payment-integration',
    );

    // Still wrong, and worth keeping visible: an Active Directory security
    // specialist takes the top slot on the literal words "review" and
    // "authentication". Nothing about BM25 can tell that collision from a real
    // match, so this assertion documents a limitation rather than a target.
    expect(ranked[0]?.agent.name).toBe('ad-security-reviewer');
    expect(ranked[0]?.matched.sort()).toEqual(['authentication', 'review']);

    // Still absent: the task never says "security", "audit", "backend" or
    // "API" in those exact words, so neither agent scores at all. Stemming
    // cannot help here — the vocabularies genuinely do not overlap.
    expect(top).not.toContain('security-auditor');
    expect(top).not.toContain('backend-developer');
  });

  // ---------------------------------------------------------------------
  // KNOWN-BAD: research domain.
  //
  // scientific-literature-researcher rightly takes #1 — this part works well
  // and is asserted as a genuine pass below, not a known-bad. But "state" (as
  // in "state of the art") and "retrieval" (as in "retrieval-augmented") are
  // both polysemous: they also mean "application/infrastructure state" and
  // "context/memory retrieval" respectively elsewhere in the catalog, and
  // BM25 has no way to tell the senses apart. The result is that five
  // entirely unrelated software/infra agents outrank the catalog's own
  // research generalists:
  //
  //   context-manager     matched "retrieval" + "state" (its description is
  //                        about *multi-agent context* retrieval and shared
  //                        *state*, categories/09-meta-orchestration).
  //   terraform-engineer,
  //   react-specialist,
  //   angular-architect,
  //   flutter-expert       all matched on "state" alone, meaning
  //                        infrastructure/application state, not "state of
  //                        the art".
  //
  // Meanwhile research-analyst and data-researcher — the two obvious
  // generalist picks for "survey the literature and summarise the state of
  // the art" — score exactly zero and are absent from the top 10, because
  // neither description shares a single literal token with the task text.
  it('KNOWN-BAD: research task — polysemous terms outrank the catalog’s own research generalists', async () => {
    const registry = await loadRegistry(REPO_ROOT);
    const task =
      'Survey the published literature on retrieval-augmented generation and summarise the state of the art';
    const ranked = rankCandidates(registry, task);
    const top = ranked.slice(0, TOP_N).map((c) => c.agent.name);

    printRanking('research', ranked);

    for (const name of [
      'scientific-literature-researcher',
      'search-specialist',
      'context-manager',
      'terraform-engineer',
      'react-specialist',
      'angular-architect',
      'flutter-expert',
      'research-analyst',
      'data-researcher',
    ]) {
      expect(registry.get(name), `fixture agent "${name}" must exist in the registry`).toBeDefined();
    }

    // The genuine pass: the one agent whose entire purpose is "search
    // scientific literature" correctly takes #1 for a task about surveying
    // scientific literature.
    expect(ranked[0]?.agent.name).toBe('scientific-literature-researcher');
    // search-specialist is a reasonable secondary pick — "retrieval" is a
    // real (if coincidental) point of contact with its actual purpose.
    expect(top).toContain('search-specialist');

    // The known-bad part: unrelated framework and infrastructure agents,
    // pulled in purely by the word "state", still crowd the top 10 ahead of
    // the true generalists. The exact membership of that group shifts slightly
    // with scoring changes, so this asserts the *shape* of the failure — that
    // several such agents are present — rather than pinning a list that would
    // break on every retune and teach nothing when it did.
    const stateFalsePositives = [
      'context-manager',
      'terraform-engineer',
      'react-specialist',
      'angular-architect',
      'flutter-expert',
      'workflow-orchestrator',
      'multi-agent-coordinator',
    ].filter((name) => top.includes(name));

    expect(
      stateFalsePositives.length,
      `expected several "state" false positives in the top ${TOP_N}; got ${JSON.stringify(stateFalsePositives)}`,
    ).toBeGreaterThanOrEqual(3);

    expect(top, 'research-analyst scores zero and is missing from the top 10').not.toContain('research-analyst');
    expect(top, 'data-researcher scores zero and is missing from the top 10').not.toContain('data-researcher');
  });

  // ---------------------------------------------------------------------
  // Recall at the cut, which is the number that decides whether FR-R4 can be
  // switched on at all.
  //
  // Every test above measures *precision* — is the top of the ranking any
  // good. For a pre-filter that is the less important question. FR-R4's job is
  // to hand the Manager a shorter roster, so the only way it can do real harm
  // is by cutting an agent the Manager would have picked. Ranking a good agent
  // fourth instead of first costs nothing; dropping it from the list entirely
  // means the Manager cannot choose it however well it reasons.
  //
  // The catalog makes this sharp: most agents score exactly 0.000 for any
  // given task, so a top-40 cut is "the handful that matched, plus the
  // alphabetical head of the zero-scoring tail". `security-auditor` and
  // `backend-developer` score zero on the software task — they survive the cut
  // only if the alphabet is kind, which is not a property anyone should rely
  // on.
  it('measures whether a 40-candidate cut keeps the agents a human would pick', async () => {
    const registry = await loadRegistry(REPO_ROOT);

    const expectations: { label: string; task: string; wanted: string[] }[] = [
      {
        label: 'software',
        task: 'Review the payments service for authentication bugs and refactor the retry logic',
        wanted: ['backend-developer', 'security-auditor', 'code-reviewer', 'payment-integration'],
      },
      {
        label: 'legal',
        task: 'Review our vendor NDA for unusual liability and termination terms',
        wanted: ['legal-advisor', 'compliance-auditor', 'risk-manager'],
      },
      {
        label: 'tax',
        task: 'We are opening a subsidiary in Ireland — what are the corporation tax and VAT registration consequences?',
        wanted: ['tax-advisor', 'tax-compliance-specialist', 'risk-manager'],
      },
      {
        label: 'research',
        task: 'Survey the published literature on retrieval-augmented generation and summarise the state of the art',
        wanted: ['research-analyst', 'data-researcher', 'scientific-literature-researcher'],
      },
      {
        label: 'product',
        task: 'Prioritise the Q3 roadmap and define success metrics for the new onboarding flow',
        wanted: ['product-manager', 'ux-researcher', 'business-analyst'],
      },
    ];

    const report: string[] = [];
    let kept = 0;
    let total = 0;

    for (const scenario of expectations) {
      for (const name of scenario.wanted) {
        expect(registry.get(name), `fixture agent "${name}" must exist`).toBeDefined();
      }
      const shortlist = new Set(selectCandidates(registry, scenario.task, { limit: 40 }));
      const lost = scenario.wanted.filter((name) => !shortlist.has(name));
      kept += scenario.wanted.length - lost.length;
      total += scenario.wanted.length;
      report.push(
        `  ${scenario.label.padEnd(9)} kept ${scenario.wanted.length - lost.length}/${scenario.wanted.length}` +
          (lost.length === 0 ? '' : `  lost: ${lost.join(', ')}`),
      );
    }

    // eslint-disable-next-line no-console -- this number is the finding.
    console.log(`[FR-R4 recall @40] ${kept}/${total} wanted agents survive the cut\n${report.join('\n')}`);

    // Deliberately not asserted at 100%: it is not, and pretending otherwise
    // by lowering the bar until it passes would hide the one fact that matters
    // about this module. What *is* asserted is that the measurement ran and
    // that the cut is not catastrophic — below half would mean the pre-filter
    // is actively worse than sending the whole roster.
    expect(total).toBeGreaterThan(0);
    expect(kept / total, 'a pre-filter that loses most wanted agents is worse than no filter').toBeGreaterThan(0.5);
  });

  // ---------------------------------------------------------------------
  // Tax domain.
  //
  // `tax-advisor` and `tax-compliance-specialist` were, at the time this test
  // was written, being authored by another agent in parallel and might not
  // exist on disk yet. `TAX_ADVISOR_EXISTS` is resolved synchronously (a
  // filename scan, not a full parse) before test collection so the
  // tax-advisor-specific assertion below can be cleanly skipped — reported as
  // "skipped" in the test run, never silently absent — rather than guessed at.
  it('ranks whatever tax coverage currently exists in the top 10 for a tax query', async () => {
    const registry = await loadRegistry(REPO_ROOT);
    const task =
      'We are opening a subsidiary in Ireland — what are the corporation tax and VAT registration consequences?';
    const ranked = rankCandidates(registry, task);
    const top = ranked.slice(0, TOP_N).map((c) => c.agent.name);

    printRanking('tax', ranked);

    // Sanity check only — no assertion on ranking here, since whether these
    // exist at all is exactly what's in question for this domain.
    expect(top.length).toBeGreaterThan(0);
  });

  (TAX_ADVISOR_EXISTS ? it : it.skip)(
    'ranks tax-advisor in the top 5 for a tax query, now that it exists in the registry',
    async () => {
      const registry = await loadRegistry(REPO_ROOT);
      const task =
        'We are opening a subsidiary in Ireland — what are the corporation tax and VAT registration consequences?';
      const ranked = rankCandidates(registry, task);

      expect(registry.get('tax-advisor')).toBeDefined();
      // Name-weighted BM25 doing exactly what FR-R4 asks for: an agent
      // literally called `tax-advisor` wins a tax query outright.
      expect(ranked.slice(0, 5).map((c) => c.agent.name)).toContain('tax-advisor');
      expect(ranked[0]?.agent.name).toBe('tax-advisor');
    },
  );

  it('reports the FR-R4 prompt-size win: full roster digest vs a 40-candidate digest', async () => {
    const registry = await loadRegistry(REPO_ROOT);
    const task = 'Review the payments service for authentication bugs and refactor the retry logic';

    const fullTokens = estimateTokens(buildRosterDigest(registry));

    const candidateNames = selectCandidates(registry, task, { limit: DEFAULT_CANDIDATE_LIMIT });
    const candidateAgents = candidateNames
      .map((name) => registry.get(name))
      .filter((a): a is AgentDef => a !== undefined);
    const candidateTokens = estimateTokens(buildRosterDigest(buildRegistry(candidateAgents)));

    // eslint-disable-next-line no-console
    console.log(
      `\n[routing matrix] roster digest tokens: full=${fullTokens}, ` +
        `${DEFAULT_CANDIDATE_LIMIT}-candidate=${candidateTokens} ` +
        `(${Math.round((1 - candidateTokens / fullTokens) * 100)}% smaller)`,
    );

    expect(candidateNames).toHaveLength(DEFAULT_CANDIDATE_LIMIT);
    expect(candidateTokens).toBeLessThan(fullTokens);
  });
});
