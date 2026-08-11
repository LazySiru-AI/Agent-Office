import { API } from '@agent-office/shared';

/**
 * The PDF download (FR-P5).
 *
 * A plain anchor rather than a fetch-and-blob: the server already sends
 * `Content-Disposition: attachment` with a run-specific filename, so letting the
 * browser handle the transfer gets the filename, the progress indicator and the
 * cancel affordance for free — all of which a blob download would have to
 * reimplement badly.
 */
export interface PdfDownloadProps {
  runId: string | undefined;
  /** `run.pdfPath` — present only once the designer step has produced one. */
  pdfPath: string | undefined;
  /** The theme the designer chose, shown so a surprising look is explicable. */
  theme: string | undefined;
  rationale: string | undefined;
  /** The run's own status, used to explain *why* there is no PDF yet. */
  runStatus: string | undefined;
}

export function PdfDownload({
  runId,
  pdfPath,
  theme,
  rationale,
  runStatus,
}: PdfDownloadProps): JSX.Element | null {
  if (runId === undefined) return null;

  if (pdfPath === undefined) {
    // Deliberately not an error. A run that has not reached `designing` yet
    // simply has no PDF, and saying which state it is in is more useful than a
    // disabled button with no explanation.
    return (
      <p className="muted">
        No PDF yet{runStatus === undefined ? '' : ` — run is ${runStatus}`}.
      </p>
    );
  }

  return (
    <div className="pdf-download">
      <a className="pdf-button" href={API.runPdf(runId)} download>
        Download PDF
      </a>
      {theme !== undefined && (
        <span className="pdf-theme">
          <strong>{theme}</strong> theme
          {rationale !== undefined && rationale.length > 0 ? ` — ${rationale}` : ''}
        </span>
      )}
    </div>
  );
}
