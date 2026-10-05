export class ApiFault extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string, readonly details?: unknown) { super(message); }
}
