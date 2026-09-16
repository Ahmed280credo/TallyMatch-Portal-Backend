import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  CORS_ORIGIN: z.string().default("http://localhost:5173"),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  REDIS_URL: z.string().min(1).default("redis://localhost:6379"),
  GOOGLE_GEMINI_API_KEY: z.string().min(1),
  GEMINI_MODEL: z.string().default("gemini-2.5-flash"),
  MAX_UPLOAD_MB: z.coerce.number().int().positive().default(15),
  // Optional: ConfigModule.forRoot's `validate` return value replaces
  // process.env wholesale, so any var not listed here — even if present in
  // .env — gets silently stripped for the rest of the process. Optional
  // prep-work vars (like this one, read directly via process.env rather
  // than through ConfigService) must still be declared here to survive.
  ERP_CREDENTIALS_ENCRYPTION_KEY: z.string().optional()
});

export function validateEnv(config: Record<string, unknown>) {
  const parsed = EnvSchema.safeParse(config);

  if (!parsed.success) {
    throw new Error(`Invalid environment: ${parsed.error.message}`);
  }

  return parsed.data;
}

