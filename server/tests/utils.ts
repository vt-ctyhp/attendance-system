import type { RequestHandler } from 'express';
import type { AuthenticatedRequest } from '../src/auth';

interface HandlerOptions {
  body?: unknown;
  params?: Record<string, string>;
  query?: Record<string, unknown>;
  headers?: Record<string, string>;
  user?: AuthenticatedRequest['user'];
  method?: string;
}

interface HandlerResult<T = unknown> {
  status: number;
  data: T | null;
}

const createMockResponse = <T>() => {
  let status = 200;
  let data: T | null = null;

  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    json(payload: unknown) {
      data = payload as T;
      return this;
    },
    send(payload?: unknown) {
      data = (payload as T) ?? null;
      return this;
    },
    result(): HandlerResult<T> {
      return { status, data };
    }
  } as any;

  return res;
};

export const callHandler = async <T = unknown>(
  handler: RequestHandler,
  options: HandlerOptions = {}
): Promise<HandlerResult<T>> => {
  const headerEntries = Object.entries(options.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)] as const);
  const headerMap = new Map(headerEntries);

  const req: Partial<AuthenticatedRequest> & Record<string, unknown> = {
    body: options.body ?? {},
    params: options.params ?? {},
    query: options.query ?? {},
    headers: Object.fromEntries(headerMap),
    method: options.method ?? 'POST',
    ip: '127.0.0.1',
    user: options.user,
    get(name: string) {
      return headerMap.get(name.toLowerCase()) ?? undefined;
    }
  };

  const res = createMockResponse<T>();

  let nextCalledWithError: unknown = undefined;
  const next = (err?: unknown) => {
    if (err) {
      nextCalledWithError = err;
    }
  };

  await Promise.resolve(handler(req as AuthenticatedRequest, res, next));

  if (nextCalledWithError) {
    throw nextCalledWithError;
  }

  return res.result();
};
