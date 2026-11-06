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

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('Email inválido'),
  password: z.string().min(1, 'La contraseña es obligatoria'),
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
