/**
 * @agent-office/server — the orchestrator host.
 *
 * Phase 3's HTTP/WebSocket layer consumes this barrel; nothing here should need
 * to reach into a subpath.
 */

export {
  AgentParseError,
  RegistryLoadError,
  buildRegistry,
  buildRosterDigest,
  estimateTokens,
  loadRegistry,
  parseAgentFile,
  type DuplicateAgentName,
  type Registry,
} from './registry/index.js';

export {
  PROVIDER_IDS,
  ProviderUnavailableError,
  type AgentProvider,
  type AgentRunRequest,
  type ProviderAvailability,
  type ProviderId,
} from './providers/types.js';

export {
  ScriptedProvider,
  type ScriptedProviderOptions,
  type ScriptedResponse,
} from './providers/scripted.js';

export { UnsafePathError, type RunStore, type RunSummary } from './store/types.js';
export {
  assertSafeRelativePath,
  assertValidRunId,
  newRunId,
  resolveWithin,
} from './store/util.js';
export { MemoryRunStore } from './store/memoryStore.js';
export {
  FileRunStore,
  RUN_STATE_FILE,
  RUN_SUBDIRS,
  defaultRunsRoot,
  type StoreWarning,
} from './store/fileStore.js';

export {
  agentMarker,
  buildAssignmentBrief,
  type BriefInput,
  type UpstreamReport,
} from './orchestrator/brief.js';

export {
  DEFAULT_DISPATCH_OPTIONS,
  dispatchRun,
  materialiseAssignments,
  type DispatchDeps,
  type DispatchOptions,
  type DispatchResult,
} from './orchestrator/dispatcher.js';

export {
  DEFAULT_MAX_REPAIR_ATTEMPTS,
  DEFAULT_MAX_REPORT_CHARS,
  MANAGER_PLAN_ASSIGNMENT_ID,
  MANAGER_SYNTHESIS_ASSIGNMENT_ID,
  ManagerAbortedError,
  ManagerPlanningError,
  ManagerProviderError,
  MissingManagerSourceAgentError,
  PlanParseError,
  buildManagerSystemPrompt,
  buildPlanningPrompt,
  buildRepairPrompt,
  buildSynthesisPrompt,
  extractPlanJson,
  planRun,
  synthesiseReport,
  type AssignmentReport,
  type PlanRunDeps,
  type RejectedPlanAttempt,
  type SynthesiseReportDeps,
} from './orchestrator/manager.js';

export {
  SYNTHESIS_REPORT_PATH,
  executeRun,
  type ExecuteRunDeps,
  type ExecuteRunResult,
} from './orchestrator/runner.js';
