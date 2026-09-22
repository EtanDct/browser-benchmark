export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

/** Rejects after `ms` without cancelling the underlying work; callers must clean up (kill the browser). */
export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message.split('\n')[0] : String(err);
}
