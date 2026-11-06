export interface ErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }

  toBody(): ErrorBody {
    const body: ErrorBody = { code: this.code, message: this.message };
    if (this.details !== undefined) body.details = this.details;
    return body;
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const Errors = {
  validation(message = 'Datos de entrada inválidos.', details?: unknown): AppError {
    return new AppError(400, 'VALIDATION_ERROR', message, details);
  },
  invalidJson(): AppError {
    return new AppError(400, 'INVALID_JSON', 'El cuerpo de la petición no es JSON válido.');
  },
  unauthorized(message = 'Autenticación requerida.'): AppError {
    return new AppError(401, 'UNAUTHORIZED', message);
  },
  invalidCredentials(message = 'Email o contraseña incorrectos.'): AppError {
    return new AppError(401, 'INVALID_CREDENTIALS', message);
  },
  emailTaken(): AppError {
    return new AppError(409, 'EMAIL_TAKEN', 'Ya existe una cuenta con ese email.');
  },
  userNotFound(): AppError {
    return new AppError(401, 'UNAUTHORIZED', 'La cuenta asociada al token ya no existe.');
  },
  forbidden(message = 'No tienes permisos para esta operación.'): AppError {
    return new AppError(403, 'FORBIDDEN', message);
  },
  alreadyLinkedUser(): AppError {
    return new AppError(409, 'USER_ALREADY_LINKED', 'Tu cuenta ya está vinculada a un GUID.');
  },
  alreadyLinkedGuid(): AppError {
    return new AppError(409, 'GUID_ALREADY_LINKED', 'Ese GUID ya está vinculado a otra cuenta.');
  },
  notFound(message = 'Recurso no encontrado.'): AppError {
    return new AppError(404, 'NOT_FOUND', message);
  },
  playerNotFound(guid?: string): AppError {
    return new AppError(404, 'PLAYER_NOT_FOUND', guid ? `No se encontró ningún jugador con GUID ${guid}.` : 'Jugador no encontrado.');
  },
  syncNotConfigured(): AppError {
    return new AppError(503, 'SYNC_NOT_CONFIGURED', 'No hay fuente de stats configurada: falta IW4MADMIN_DB_PATH o GAME_LOG_PATH.');
  },
  syncSourceUnavailable(reason: string): AppError {
    return new AppError(503, 'SYNC_SOURCE_UNAVAILABLE', `No se pudo abrir la base de datos de IW4MAdmin: ${reason}`);
  },
  internal(message = 'Error interno del servidor.'): AppError {
    return new AppError(500, 'INTERNAL', message);
  },
};
