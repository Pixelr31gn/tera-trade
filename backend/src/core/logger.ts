import pino from "pino";
import { getSettings } from "./config.js";

export const logger = pino({
  level: getSettings().logLevel,
  transport:
    getSettings().environment === "development"
      ? { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:standard" } }
      : undefined,
});

export function childLogger(name: string) {
  return logger.child({ module: name });
}
