/**
 * Structured error surfaced by gateway-mode calls. A non-2xx HTTP response from
 * the conduit-gateway is turned into one of these so callers can branch on
 * `status` and inspect the parsed `body` instead of parsing a raw Response.
 */
export class ConduitError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "ConduitError";
    this.status = status;
    this.body = body;
    // Restore prototype chain for instanceof across transpile targets.
    Object.setPrototypeOf(this, ConduitError.prototype);
  }
}
