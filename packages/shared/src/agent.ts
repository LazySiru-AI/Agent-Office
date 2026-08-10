import { z } from 'zod';

/**
 * A subagent as parsed from `categories/**\/*.md` in the host repo.
 *
 * Verified against the catalog: all 154 agent files carry `name`, `description`
 * and `tools`; 8 omit `model`. Descriptions are always single-line but may be
 * quoted or unquoted and frequently contain colons, which is why the parser uses
 * a real YAML parser rather than a regex.
 */
export const AgentDefSchema = z.object({
  /** Frontmatter `name`. Unique across the catalog. */
  name: z.string().min(1),

  /** Frontmatter `description`. This is what the Manager selects on (FR-R3). */
  description: z.string().min(1),

  /**
   * Frontmatter `tools`, split from its comma-separated source form.
   *
   * Doubles as the provider tool allowlist (§1.3) — the permission model was
   * already sitting in the catalog. Some entries carry colons or double
   * underscores (`subagent-catalog:search`, `mcp__bgpt__search_papers`) and are
   * preserved verbatim.
   */
  tools: z.array(z.string().min(1)),

  /** Frontmatter `model`. Observed: `sonnet`, `haiku`, `inherit`. Often absent. */
  model: z.string().min(1).optional(),

  /** Parent directory name, e.g. `08-business-product`. */
  category: z.string().min(1),

  /** Repo-relative path with forward slashes, stable across platforms. */
  filePath: z.string().min(1),

  /** Markdown body below the frontmatter — used verbatim as the system prompt. */
  systemPrompt: z.string().min(1),
});

export type AgentDef = z.infer<typeof AgentDefSchema>;

/** The ten catalog categories, in the order they appear on disk. */
export const AGENT_CATEGORIES = [
  '01-core-development',
  '02-language-specialists',
  '03-infrastructure',
  '04-quality-security',
  '05-data-ai',
  '06-developer-experience',
  '07-specialized-domains',
  '08-business-product',
  '09-meta-orchestration',
  '10-research-analysis',
] as const;

export type AgentCategory = (typeof AGENT_CATEGORIES)[number];

/**
 * Agents whose definitions are composed into the Manager's own system prompt
 * (FR-M1). The Manager is not a hardcoded prompt — it is assembled from the
 * catalog's own orchestration specialists.
 */
export const MANAGER_SOURCE_AGENTS = [
  'agent-organizer',
  'multi-agent-coordinator',
  'task-distributor',
] as const;
