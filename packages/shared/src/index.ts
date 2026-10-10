/**
 * @agent-office/shared — the contracts both sides agree on.
 *
 * Nothing in here may import from `server` or `web`. If a type is needed by only
 * one side, it belongs in that package, not this one.
 */

export {
  AgentDefSchema,
  AGENT_CATEGORIES,
  MANAGER_SOURCE_AGENTS,
  type AgentDef,
  type AgentCategory,
} from './agent.js';

export {
  RUN_STATUSES,
  ASSIGNMENT_STATUSES,
  RunStatusSchema,
  AssignmentStatusSchema,
  TERMINAL_RUN_STATUSES,
  TERMINAL_ASSIGNMENT_STATUSES,
  ASSIGNMENT_BEHAVIOUR,
  isRunTerminal,
  isAssignmentTerminal,
  canTransitionRun,
  canTransitionAssignment,
  type RunStatus,
  type AssignmentStatus,
  type CharacterBehaviour,
} from './status.js';

export {
  RunPlanSchema,
  PhaseSpecSchema,
  AssignmentSpecSchema,
  allAssignments,
  assignedAgentNames,
  validatePlanAgainstRegistry,
  type RunPlan,
  type PhaseSpec,
  type AssignmentSpec,
  type PlanRegistryIssue,
} from './plan.js';

export {
  AgentEventSchema,
  LoggedAgentEventSchema,
  isAgentEventType,
  type AgentEvent,
  type AgentEventType,
  type LoggedAgentEvent,
} from './events.js';

export {
  RunStateSchema,
  AssignmentStateSchema,
  UsageSchema,
  EMPTY_USAGE,
  addUsage,
  totalUsage,
  runTotalUsage,
  findAssignment,
  assignmentsInPhase,
  dependenciesSatisfied,
  dependenciesUnreachable,
  isRunFinished,
  ClarifyingQuestionSchema,
  type RunState,
  type AssignmentState,
  type Usage,
  type ClarifyingQuestion,
} from './run.js';

export {
  API,
  CreateRunRequestSchema,
  CreateRunResponseSchema,
  TeamOperationSchema,
  TeamDecisionSchema,
  ClarificationRequestSchema,
  ClarificationAnswerSchema,
  ClarificationDecisionSchema,
  RunSummarySchema,
  RunListResponseSchema,
  AgentSummarySchema,
  AgentListResponseSchema,
  ProviderInfoSchema,
  ProviderListResponseSchema,
  ReportResponseSchema,
  RunEventsResponseSchema,
  ApiErrorSchema,
  ClientMessageSchema,
  ServerMessageSchema,
  EVENT_BUFFER_LIMIT,
  LOG_BUFFER_LIMIT,
  DEFAULT_PRICING,
  FREE_MODELS,
  CACHE_READ_MULTIPLIER,
  CACHE_WRITE_MULTIPLIER,
  costForUsage,
  estimateCostUsd,
  formatCostUsd,
  type CreateRunRequest,
  type CreateRunResponse,
  type TeamOperation,
  type TeamDecision,
  type ClarificationRequest,
  type ClarificationDecision,
  type RunSummary,
  type RunListResponse,
  type AgentSummary,
  type AgentListResponse,
  type ProviderInfo,
  type ProviderListResponse,
  type ReportResponse,
  type RunEventsResponse,
  type ApiError,
  type ClientMessage,
  type ServerMessage,
} from './wire.js';

export {
  DIAGNOSTIC_KINDS,
  DIAGNOSTIC_SEVERITIES,
  SEVERITY_FOR_KIND,
  DiagnosticRecordSchema,
  type DiagnosticKind,
  type DiagnosticSeverity,
  type DiagnosticRecord,
} from './diagnostics.js';

export {
  DesignChoiceSchema,
  REPORT_BUNDLE_PATH,
  REPORT_HTML_PATH,
  REPORT_PDF_PATH,
  REPORT_THEME_BRIEFS,
  REPORT_THEME_IDS,
  ReportDocumentSchema,
  ReportThemeIdSchema,
  RosterEntrySchema,
  type DesignChoice,
  type ReportDocument,
  type ReportThemeId,
  type RosterEntry,
} from './report.js';
