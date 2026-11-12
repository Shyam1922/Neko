// A promise that gives up. Used so a stalled model call becomes a visible error,
// never an endless "Thinking...".

export class ModelTimeoutError extends Error {
  constructor(public readonly what: string, public readonly ms: number) {
    super(`Timed out after ${Math.round(ms / 1000)}s waiting for ${what}.`);
    this.name = "ModelTimeoutError";
  }
}

export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ModelTimeoutError(what, ms)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
