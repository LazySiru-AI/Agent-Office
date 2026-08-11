import { isRunTerminal, type RunSummary } from '@agent-office/shared';

/**
 * Filtering and sorting for the run history (Phase 7).
 *
 * The run list was fine at five runs and is a wall of near-identical rows at
 * fifty — every one of them beginning "Review the…", distinguished only by a
 * status chip. This module is the part of the browser worth testing: the
 * component that renders it has no logic beyond mapping over what comes out of
 * here, which is deliberate, because the web package has no component-testing
 * setup and logic hidden inside JSX would be logic nobody checks.
 */

export type RunFilter = 'all' | 'live' | 'finished' | 'failed';

export interface RunQuery {
  /** Free text, matched against the task and the run id. */
  search: string;
  filter: RunFilter;
}

export const EMPTY_QUERY: RunQuery = { search: '', filter: 'all' };

/**
 * `failed` covers `cancelled` too.
 *
 * They are different things to the orchestrator — one is a defeat, the other a
 * decision — but to someone scanning history for "runs that did not produce a
 * report" they are the same category, and a separate filter for each would be
 * two buttons that are almost always clicked together.
 */
function matchesFilter(run: RunSummary, filter: RunFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'live':
      return run.live;
    case 'finished':
      return run.status === 'done';
    case 'failed':
      return run.status === 'failed' || run.status === 'cancelled';
  }
}

/**
 * Case-insensitive substring match over the task and the id.
 *
 * The id is searchable because it carries the date (`20260810-201640-rnqc`), so
 * typing `20260810` finds everything from one day without a date picker. That
 * is a happy accident of the id format, but a useful one, and it is worth
 * keeping deliberately rather than losing to a refactor.
 *
 * Multiple words are ANDed, in any order — "tax ireland" should find a run
 * whose task says "Ireland … tax", which a naive substring match would miss.
 */
function matchesSearch(run: RunSummary, search: string): boolean {
  const terms = search.toLowerCase().split(/\s+/).filter((term) => term.length > 0);
  if (terms.length === 0) return true;

  const haystack = `${run.task} ${run.id}`.toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

/**
 * Apply a query, newest first.
 *
 * Sorted by `updatedAt` rather than `createdAt`: a run that was started
 * yesterday and finished a minute ago is the one you are most likely looking
 * for, and it is the one whose events you just watched.
 *
 * Live runs are floated to the top regardless of timestamp. There are rarely
 * more than one or two, and burying the thing currently executing under
 * yesterday's history is the single most annoying way for this list to be
 * technically correct.
 */
export function queryRuns(runs: readonly RunSummary[], query: RunQuery): RunSummary[] {
  return runs
    .filter((run) => matchesFilter(run, query.filter) && matchesSearch(run, query.search))
    .sort((a, b) => {
      if (a.live !== b.live) return a.live ? -1 : 1;
      return b.updatedAt - a.updatedAt;
    });
}

export interface RunCounts {
  all: number;
  live: number;
  finished: number;
  failed: number;
}

/**
 * How many runs each filter would show — for the filter buttons.
 *
 * Counted against the *unsearched* list on purpose: a count that changed as you
 * typed would make the buttons flicker, and the question they answer is "how
 * much history is there", not "how much of my search is finished".
 */
export function countRuns(runs: readonly RunSummary[]): RunCounts {
  const counts: RunCounts = { all: runs.length, live: 0, finished: 0, failed: 0 };
  for (const run of runs) {
    if (run.live) counts.live += 1;
    if (run.status === 'done') counts.finished += 1;
    if (run.status === 'failed' || run.status === 'cancelled') counts.failed += 1;
  }
  return counts;
}

/**
 * A short, human relative time — "4m ago", "3d ago".
 *
 * `Intl.RelativeTimeFormat` would be the correct tool and is deliberately not
 * used: it produces "4 minutes ago", which is three times the width in a
 * sidebar that is already tight, and this list needs a glanceable stamp rather
 * than a sentence. `now` is a parameter so the tests are not racing the clock.
 */
export function formatAge(timestamp: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 60) return 'just now';

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;

  return new Date(timestamp).toISOString().slice(0, 10);
}

/**
 * Whether a run is worth offering a replay of.
 *
 * Replay reads the saved event log, so a run still executing has nothing
 * settled to replay and a run that never dispatched has nothing at all.
 */
export function isReplayable(run: RunSummary): boolean {
  return !run.live && isRunTerminal(run.status);
}
