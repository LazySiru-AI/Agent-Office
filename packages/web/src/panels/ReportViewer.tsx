import { useEffect, useState } from 'react';
import { fetchAssignmentReport, fetchRunReport } from '../api.js';

/**
 * Report viewer: the Manager's synthesis plus per-assignment reports.
 *
 * Markdown is rendered as preformatted text — PLAN.md is explicit that Phase
 * 3 is "deliberately ugly" and no markdown library should be added. A themed
 * HTML render is Phase 5's job (FR-P2/P3).
 */
export interface ReportViewerProps {
  runId: string | undefined;
  /** `run.reportPath` — present once the Manager's synthesis has been written. */
  runReportPath: string | undefined;
  /** Set by clicking "view" in the assignment table. */
  assignmentReportPath: string | undefined;
  onCloseAssignmentReport: () => void;
}

interface Loaded {
  path: string;
  markdown: string;
}

export function ReportViewer({
  runId,
  runReportPath,
  assignmentReportPath,
  onCloseAssignmentReport,
}: ReportViewerProps): JSX.Element {
  const synthesis = useFetchedReport(
    runId !== undefined && runReportPath !== undefined ? runId : undefined,
    fetchRunReport,
  );
  const assignment = useFetchedAssignmentReport(runId, assignmentReportPath);

  return (
    <div className="report-viewer">
      <section>
        <h2>Synthesis</h2>
        {runReportPath === undefined && <p className="muted">Not written yet.</p>}
        {runReportPath !== undefined && synthesis.error !== undefined && (
          <p className="form-error">{synthesis.error}</p>
        )}
        {runReportPath !== undefined && synthesis.loading && <p className="muted">Loading…</p>}
        {synthesis.data !== undefined && <pre className="markdown">{synthesis.data.markdown}</pre>}
      </section>

      {assignmentReportPath !== undefined && (
        <section>
          <div className="report-section-header">
            <h2>Report: {assignmentReportPath}</h2>
            <button type="button" onClick={onCloseAssignmentReport}>
              close
            </button>
          </div>
          {assignment.error !== undefined && <p className="form-error">{assignment.error}</p>}
          {assignment.loading && <p className="muted">Loading…</p>}
          {assignment.data !== undefined && <pre className="markdown">{assignment.data.markdown}</pre>}
        </section>
      )}
    </div>
  );
}

interface FetchState {
  data: Loaded | undefined;
  loading: boolean;
  error: string | undefined;
}

function useFetchedReport(
  runId: string | undefined,
  fetcher: (runId: string) => Promise<Loaded>,
): FetchState {
  const [state, setState] = useState<FetchState>({ data: undefined, loading: false, error: undefined });

  useEffect(() => {
    if (runId === undefined) {
      setState({ data: undefined, loading: false, error: undefined });
      return;
    }
    let cancelled = false;
    setState({ data: undefined, loading: true, error: undefined });
    fetcher(runId)
      .then((data) => {
        if (!cancelled) setState({ data, loading: false, error: undefined });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState({ data: undefined, loading: false, error: err instanceof Error ? err.message : String(err) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [runId, fetcher]);

  return state;
}

function useFetchedAssignmentReport(
  runId: string | undefined,
  reportPath: string | undefined,
): FetchState {
  const [state, setState] = useState<FetchState>({ data: undefined, loading: false, error: undefined });

  useEffect(() => {
    if (runId === undefined || reportPath === undefined) {
      setState({ data: undefined, loading: false, error: undefined });
      return;
    }
    let cancelled = false;
    setState({ data: undefined, loading: true, error: undefined });
    fetchAssignmentReport(runId, reportPath)
      .then((data) => {
        if (!cancelled) setState({ data, loading: false, error: undefined });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState({ data: undefined, loading: false, error: err instanceof Error ? err.message : String(err) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [runId, reportPath]);

  return state;
}
