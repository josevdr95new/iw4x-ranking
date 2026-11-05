import type { RequestHandler } from 'express';
import { z } from 'zod';
import { Errors } from '../lib/errors.js';

export type ValidationSource = 'body' | 'query' | 'params';

function toIssues(error: z.ZodError): Array<{ path: string; message: string }> {
  return error.issues.map((issue) => ({
    path: issue.path.join('.') || '(raíz)',
    message: issue.message,
  }));
}

/** Middleware: valida una parte del request contra un schema zod y la reemplaza por el dato parseado. */
export function validate(schema: z.ZodTypeAny, source: ValidationSource = 'body'): RequestHandler {
  return (req, _res, next) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      next(Errors.validation('Datos de entrada inválidos.', toIssues(result.error)));
      return;
    }
    (req as unknown as Record<string, unknown>)[source] = result.data;
    next();
  };
}

/** Valida datos sueltos (fuera del request) contra un schema zod. */
export function parseWith<S extends z.ZodTypeAny>(schema: S, data: unknown): z.output<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw Errors.validation('Datos de entrada inválidos.', toIssues(result.error));
  }
  return result.data as z.output<S>;
}
