import type { ZodType } from 'zod';
import { HttpError } from '../errors';

export const parseWithSchema = <T>(schema: ZodType<T, any, any>, payload: unknown, message = 'Invalid request payload'): T => {
  const result = schema.safeParse(payload);
  if (!result.success) {
    throw HttpError.fromZod(result.error, message);
  }
  return result.data;
};
