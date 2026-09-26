import { z } from 'zod';

export const companionDispatchInputSchema = z.object({ schema_version: z.literal(1),
  card_store_id: z.string().uuid(), card_id: z.string().uuid(), revision: z.number().int().positive(),
  dispatch_id: z.string().uuid() }).strict();