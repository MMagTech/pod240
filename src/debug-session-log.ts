/** NDJSON debug ingest for Cursor debug mode (session 217fbd). */
export function dbgSession(
  hypothesisId: string,
  location: string,
  message: string,
  data: Record<string, unknown>
): void {
  // #region agent log
  fetch("http://127.0.0.1:7688/ingest/3975e644-56cd-4139-8e66-002460c97d39", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Debug-Session-Id": "217fbd",
    },
    body: JSON.stringify({
      sessionId: "217fbd",
      hypothesisId,
      location,
      message,
      data,
      timestamp: Date.now(),
    }),
  }).catch(() => {});
  // #endregion
}
