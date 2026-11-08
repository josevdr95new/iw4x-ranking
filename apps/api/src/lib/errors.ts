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
  nickTaken(): AppError {
    return new AppError(409, 'NICK_TAKEN', 'Ese nick ya está reservado por otra cuenta.');
  },
  alertAlreadyResolved(): AppError {
    return new AppError(409, 'ALERT_ALREADY_RESOLVED', 'La alerta ya fue resuelta o descartada.');
  },
  guidLinkedToOtherAccount(guid: string): AppError {
    return new AppError(
      409,
      'GUID_ALREADY_LINKED',
      `El GUID ${guid} ya está vinculado a OTRA cuenta (no al dueño del nick): no se puede auto-vincular. Resuélvelo manualmente (p. ej. revisa el imposter en /api/admin/iam/clients).`,
    );
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
  saveShaMismatch(path: string): AppError {
    return new AppError(
      400,
      'SHA_MISMATCH',
      `El sha256 declarado no coincide con el contenido recibido para "${path}": recalcula el hash y reintenta.`,
    );
  },
  saveNotFound(): AppError {
    return new AppError(404, 'SAVE_NOT_FOUND', 'Esta cuenta nunca subió un cloud save.');
  },
  saveVersionNotFound(version: number): AppError {
    return new AppError(404, 'SAVE_VERSION_NOT_FOUND', `No existe la versión ${version} (o fue podada; se conservan las últimas 10).`);
  },
  saveFileNotFound(path: string): AppError {
    return new AppError(404, 'SAVE_FILE_NOT_FOUND', `El archivo "${path}" no está en esa versión del save.`);
  },
  internal(message = 'Error interno del servidor.'): AppError {
    return new AppError(500, 'INTERNAL', message);
  },
  /** Guid de BOT (rango 0xb07…): los bots no son cuentas, jamás se vinculan. */
  botGuidNotLinkable(guid: string): AppError {
    return new AppError(
      400,
      'BOT_GUID_NOT_LINKABLE',
      `El GUID ${guid} pertenece al rango dedicado de BOTS (0xb07…): los bots no son cuentas y no se pueden vincular.`,
    );
  },
};
