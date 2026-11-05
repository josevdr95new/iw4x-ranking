import type { NextFunction, Request, Response } from 'express';
import { isAppError } from '../lib/errors.js';

interface BodyParserLikeError {
  type?: unknown;
  status?: unknown;
}

function isBodyParserError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const candidate = err as BodyParserLikeError;
  return candidate.type === 'entity.parse.failed' || (err instanceof SyntaxError && candidate.status === 400);
}

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: `Ruta no encontrada: ${req.method} ${req.originalUrl}` },
  });
}

/** Manejador central de errores: normaliza toda respuesta de error. */
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (isAppError(err)) {
    res.status(err.statusCode).json({ error: err.toBody() });
    return;
  }
  if (isBodyParserError(err)) {
    res.status(400).json({
      error: { code: 'INVALID_JSON', message: 'El cuerpo de la petición no es JSON válido.' },
    });
    return;
  }
  console.error('[error] Error no controlado:', err);
  res.status(500).json({
    error: { code: 'INTERNAL', message: 'Error interno del servidor.' },
  });
}
