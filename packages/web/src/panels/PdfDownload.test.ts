import { describe, expect, it } from 'vitest';
import { pdfErrorMessage, pdfHref } from './PdfDownload.js';

/**
 * The one decision in `PdfDownload` that is a decision rather than markup.
 *
 * This suite runs under plain Node with no DOM, so the component's output is
 * unassertable here — but the question it answers is not about rendering. A run
 * that never reached `designing` and a run whose Chromium launch failed both
 * arrive with `pdfPath === undefined`, and before `run.pdfError` was carried out
 * of `produceDeliverable` they were literally indistinguishable to this panel.
 */
describe('pdfErrorMessage (NFR-8)', () => {
  it('says the render failed, and why, when a reason was recorded', () => {
    const message = pdfErrorMessage({
      pdfError: 'no Chromium-family browser found on this machine',
      runStatus: 'done',
    });

    expect(message).toContain('render failed');
    expect(message).toContain('no Chromium-family browser found');
    // The status is not repeated here: "run is done" alongside "the render
    // failed" reads as a contradiction, and the failure is the useful half.
    expect(message).not.toContain('run is done');
  });

  it('falls back to the status when there is no reason, which is the not-yet case', () => {
    expect(pdfErrorMessage({ pdfError: undefined, runStatus: 'working' })).toBe(
      'No PDF yet — run is working.',
    );
  });

  it('says the plainest thing when it knows neither', () => {
    expect(pdfErrorMessage({ pdfError: undefined, runStatus: undefined })).toBe('No PDF yet.');
  });

  it('treats an empty reason as no reason, not as a failure with a blank explanation', () => {
    // A degenerate `pdfError: ''` would otherwise render "the render failed: "
    // with nothing after the colon — worse than the not-yet message it replaced.
    expect(pdfErrorMessage({ pdfError: '', runStatus: 'done' })).toBe('No PDF yet — run is done.');
  });
});

/**
 * A1/P2: the download anchor needed the exact fix `state/socket.ts`'s WS URL
 * needed, and for the same reason (see this file's own header comment) — a
 * plain `<a href download>` cannot carry `AUTH_TOKEN_HEADER` any more than a
 * native `WebSocket` upgrade can. `pdfHref` is the pure decision behind that
 * anchor's `href`, taking `token` as a parameter rather than reading `api.ts`'s
 * module-level `authToken` directly so it is testable here with no DOM and no
 * module-reset dance.
 */
describe('pdfHref (A1/P2 — the PDF download authenticates outside the Vite dev proxy)', () => {
  it('is the plain PDF route with no token to attach — the dev-proxy flow', () => {
    expect(pdfHref('run-1', undefined)).toBe('/api/runs/run-1/pdf');
  });

  it('appends the bootstrapped token as a query parameter for the direct-serve flow', () => {
    expect(pdfHref('run-1', 'secret-token')).toBe('/api/runs/run-1/pdf?token=secret-token');
  });

  it('percent-encodes the run id in the route the same way with or without a token', () => {
    // Not this function's own responsibility (that's `API.runPdf`'s
    // `encodeURIComponent`), but pinning it here catches a regression where
    // `pdfHref` built the URL by hand instead of delegating to `API.runPdf`.
    expect(pdfHref('run/with slash', undefined)).toBe('/api/runs/run%2Fwith%20slash/pdf');
  });
});
