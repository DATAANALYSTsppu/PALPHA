import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: { pid: undefined, hostname: undefined },
  transport: {
    target: 'pino/file',
    options: { destination: 1 },
  },
});

export function createLogger(component: string) {
  return logger.child({ component });
}
