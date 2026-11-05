import type { NextFunction, Request, RequestHandler, Response } from 'express';

type AsyncRouteHandler = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;

/**
 * Envuelve handlers async para que cualquier rechazo llegue al error handler
 * central (Express 4 no captura promesas rechazadas por sí solo).
 */
export function asyncHandler(fn: AsyncRouteHandler): RequestHandler {
  return (req, res, next) => {
    void fn(req, res, next).catch(next);
  };
}
