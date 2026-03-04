import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(8080),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  JWT_ISSUER: z.string().default("remote-support"),
  JWT_AUDIENCE: z.string().default("remote-support-clients"),
  SESSION_CODE_TTL_MIN: z.coerce.number().default(10),
  SESSION_TOKEN_TTL_MIN: z.coerce.number().default(30),
  CONTROLLER_TOKEN_TTL_MIN: z.coerce.number().default(30),
  TECH_EMAIL: z.string().email().default("tech@example.com"),
  TECH_PASSWORD: z.string().min(8).default("ChangeMe123!"),
  RATE_LIMIT_WINDOW_SEC: z.coerce.number().default(60),
  RATE_LIMIT_MAX: z.coerce.number().default(120),
  LOGIN_RATE_LIMIT_MAX: z.coerce.number().default(10),
  WS_HEARTBEAT_SEC: z.coerce.number().default(30)
});

export const config = envSchema.parse(process.env);
