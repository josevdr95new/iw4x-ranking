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
