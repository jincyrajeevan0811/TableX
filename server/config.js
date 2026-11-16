import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* .env is optional */ }

const env = process.env;

export const config = {
  port: Number(env.PORT || 8080),
  appUrl: (env.APP_URL || `http://localhost:${env.PORT || 8080}`).replace(/\/$/, ''),
  dbFile: env.DB_FILE ? path.resolve(ROOT, env.DB_FILE) : path.join(ROOT, 'data', 'tablex.db'),
  publicDir: path.join(ROOT, 'public'),
  superAdmin: {
    name: env.SUPERADMIN_NAME || 'TableX Super Admin',
    phone: env.SUPERADMIN_PHONE || '9000000000',
    email: env.SUPERADMIN_EMAIL || 'admin@tablex.app',
    password: env.SUPERADMIN_PASSWORD || 'ChangeMe@123',
  },
  razorpay: {
    keyId: env.RAZORPAY_KEY_ID || '',
    keySecret: env.RAZORPAY_KEY_SECRET || '',
    webhookSecret: env.RAZORPAY_WEBHOOK_SECRET || '',
  },
  allowDemoPayments: (env.ALLOW_DEMO_PAYMENTS ?? 'true') !== 'false',
  trialDays: Number(env.TRIAL_DAYS ?? 14),
  sessionDays: 30,
};
