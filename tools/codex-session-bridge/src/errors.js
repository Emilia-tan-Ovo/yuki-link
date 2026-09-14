export class BridgeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

// Best-effort redaction, not a licence to send secrets to the bridge.
export function redact(text) {
  return String(text)
    .replace(/\b(?:sk|rk)-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]')
    .replace(/\bBearer\s+[^\s"',}]+/gi, 'Bearer [REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password)\s*["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1[REDACTED]');
}

export function publicError(error) {
  return {
    code: error instanceof BridgeError ? error.code : 'INTERNAL_ERROR',
    message: redact(error.message),
    ...(error instanceof BridgeError ? { details: error.details } : {}),
  };
}
