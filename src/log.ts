// The shared pino logger. SamaPrime's chain code imports `@/lib/logger`; this
// is that module's SamaPay home, so the ported files change an import path
// and nothing else. Level from LOG_LEVEL, same as the worker and reconciler.
import pino from "pino";
export const logger = pino({ level: process.env.LOG_LEVEL ?? "info", name: "samapay" });
export default logger;
