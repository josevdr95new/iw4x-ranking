import { z } from 'zod';

export const registerSchema = z.object({
  email: z.string().trim().toLowerCase().email('Email inválido').max(254),
  password: z.string().min(8, 'La contraseña debe tener al menos 8 caracteres').max(72),
  displayName: z
    .string()
    .trim()
    .min(3, 'El nombre visible debe tener al menos 3 caracteres')
    .max(32, 'El nombre visible no puede superar 32 caracteres'),
});

export type RegisterInput = z.infer<typeof registerSchema>;

/**
 * LOGIN solo por NICK (displayName reservado). El frontend nuevo envía
 * `identifier` con el nick; el campo legacy `email` se acepta durante la
 * transición con el MISMO tratamiento. Un email en el campo NO es credencial:
 * no coincide con ningún nick → 401 genérico.
 */
export const loginSchema = z
  .object({
    /** Nick (displayName). Es el único método de acceso; el email no es credencial. */
    identifier: z
      .string()
      .trim()
      .min(3, 'El identifier debe tener al menos 3 caracteres')
      .max(64, 'El identifier no puede superar 64 caracteres')
      .optional(),
    /** DEPRECATED (transición): mismo tratamiento que identifier (se espera un nick). */
    email: z
      .string()
      .trim()
      .min(3, 'El identifier debe tener al menos 3 caracteres')
      .max(64, 'El identifier no puede superar 64 caracteres')
      .optional(),
    password: z.string().min(1, 'La contraseña es obligatoria'),
  })
  .refine((data) => data.identifier !== undefined || data.email !== undefined, {
    message: 'Debes enviar identifier (tu nick) y password.',
  });

export type LoginInput = z.infer<typeof loginSchema>;

export const updateProfileSchema = z
  .object({
    displayName: z
      .string()
      .trim()
      .min(3, 'El nombre visible debe tener al menos 3 caracteres')
      .max(32, 'El nombre visible no puede superar 32 caracteres')
      .optional(),
    currentPassword: z.string().min(1).optional(),
    password: z
      .string()
      .min(8, 'La nueva contraseña debe tener al menos 8 caracteres')
      .max(72)
      .optional(),
  })
  .refine((data) => data.displayName !== undefined || data.password !== undefined, {
    message: 'Debes enviar displayName y/o password.',
  })
  .refine((data) => data.password === undefined || data.currentPassword !== undefined, {
    message: 'Para cambiar la contraseña debes enviar currentPassword.',
  });

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
