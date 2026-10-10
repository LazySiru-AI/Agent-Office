import { API } from '@agent-office/shared';
import { appendToken, authToken } from '../api.js';

/**
 * The PDF download (FR-P5).
 *
 * A plain anchor rather than a fetch-and-blob: the server already sends
 * `Content-Disposition: attachment` with a run-specific filename, so letting the
 * browser handle the transfer gets the filename, the progress indicator and the
 * cancel affordance for free — all of which a blob download would have to
 * reimplement badly.
 *
 * That argument is still the reason this stays a plain anchor rather than
 * switching to fetch+blob for A1 below — a blob download would have solved
 * the missing token for free (it goes through `fetch`, which already
 * attaches `AUTH_TOKEN_HEADER`) at the cost of reimplementing the filename,
 * the browser's own progress UI and the cancel affordance, which is exactly
 * the trade this comment already rejected once. `pdfHref` gets the anchor to
 * the same authenticated place without giving any of that up.
 *
 * ## A1/P2: this anchor needed the same fix `state/socket.ts` needed
 *
 * A plain `<a href download>` is a browser-native navigation, not a `fetch`
 * this app's own code is in the loop for, so it cannot carry
 * `AUTH_TOKEN_HEADER` any more than the WebSocket upgrade in `socket.ts` can
 * — there is no request object here to attach a header to. Behind the Vite
 * dev proxy that was invisible (the proxy injects the header on every
 * proxied request, this one included), but under `npm run serve` on its own
 * — the documented way to run this app — clicking "Download PDF" 401s
 * exactly like the socket did. `pdfHref` below appends `authToken` as the
 * same `?token=` query parameter `state/socket.ts`'s `buildWsUrl` appends to
 * the WebSocket URL, through the exact same `appendToken` helper — one
 * decision, defined once in `api.ts`, used by both callers that cannot carry
 * a header.
 */
/**
 * The line shown where the download button would be.
 *
 * Exported and pure so it can be tested: this package's suite runs under plain
 * Node with no DOM, so a component's rendered output is unassertable but the
 * decision behind it is not. The distinction being tested is the one the whole
 * `pdfError` field exists for — "not yet" versus "tried and failed".
 */
/**
 * The PDF download href — `API.runPdf(runId)` with `token` appended exactly
 * as `state/socket.ts`'s `buildWsUrl` appends it to the WebSocket URL (see
 * `appendToken` in `api.ts` for the one shared decision both call sites use).
 * Exported and pure, taking `token` as a parameter instead of reading
 * `api.ts`'s module-level `authToken` directly, for the same reason
 * `pdfErrorMessage` below and `buildWsUrl` are: this package's tests run
 * under plain Node with no DOM, so a component's rendered `href` attribute is
 * unassertable, but the string this function returns is not.
 */
export function pdfHref(runId: string, token: string | undefined): string {
  return appendToken(API.runPdf(runId), token);
}

export function pdfErrorMessage(input: {
  pdfError: string | undefined;
  runStatus: string | undefined;
}): string {
  if (input.pdfError !== undefined && input.pdfError !== '') {
    // The reason comes from `renderPdf`, which phrases its failures for a person
    // (most often "no Chromium on this machine"), so it is shown as written
    // rather than re-summarised into something vaguer.
    return `No PDF — the render failed: ${input.pdfError}`;
  }
  return `No PDF yet${input.runStatus === undefined ? '' : ` — run is ${input.runStatus}`}.`;
}

export interface PdfDownloadProps {
  runId: string | undefined;
  /** `run.pdfPath` — present only once the designer step has produced one. */
  pdfPath: string | undefined;
  /** The theme the designer chose, shown so a surprising look is explicable. */
  theme: string | undefined;
  rationale: string | undefined;
  /** The run's own status, used to explain *why* there is no PDF yet. */
  runStatus: string | undefined;
  /** `run.pdfError` — set when the render was attempted and failed (NFR-8). */
  pdfError: string | undefined;
}

export function PdfDownload({
  runId,
  pdfPath,
  theme,
  rationale,
  runStatus,
  pdfError,
}: PdfDownloadProps): JSX.Element | null {
  if (runId === undefined) return null;

  if (pdfPath === undefined) {
    // Deliberately not an error. A run that has not reached `designing` yet
    // simply has no PDF, and saying which state it is in is more useful than a
    // disabled button with no explanation.
    //
    // A run that TRIED and failed is a different thing entirely, and until
    // `pdfError` was carried onto the run these two rendered identically — the
    // user of a machine without Chromium saw "No PDF yet — run is done" forever,
    // with the actual reason sitting in a server-side log they may not have.
    return (
      <p className="muted">
        {pdfErrorMessage({ pdfError, runStatus })}
      </p>
    );
  }

  return (
    <div className="pdf-download">
      <a className="pdf-button" href={pdfHref(runId, authToken)} download>
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
