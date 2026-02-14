/**
 * Signal-cli daemon management
 * Spawns and manages the signal-cli HTTP daemon process
 */
import { spawn, ChildProcess } from 'node:child_process';
import { logger } from '../logger.js';

export interface SignalDaemonOpts {
  cliPath: string;
  account?: string;
  httpHost: string;
  httpPort: number;
  sendReadReceipts?: boolean;
}

export interface SignalDaemonHandle {
  pid?: number;
  process: ChildProcess;
  stop: () => void;
}

function classifyLogLine(line: string): 'log' | 'error' | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  if (/\b(ERROR|WARN|WARNING|FAILED|SEVERE|EXCEPTION)\b/i.test(trimmed)) {
    return 'error';
  }
  return 'log';
}

function buildDaemonArgs(opts: SignalDaemonOpts): string[] {
  const args: string[] = [];

  if (opts.account) {
    args.push('-a', opts.account);
  }

  args.push('daemon');
  args.push('--http', `${opts.httpHost}:${opts.httpPort}`);
  args.push('--no-receive-stdout');
  args.push('--receive-mode', 'on-start');

  if (opts.sendReadReceipts) {
    args.push('--send-read-receipts');
  }

  return args;
}

export function spawnSignalDaemon(opts: SignalDaemonOpts): SignalDaemonHandle {
  const args = buildDaemonArgs(opts);

  logger.info({ cliPath: opts.cliPath, args: args.join(' ') }, 'Spawning signal-cli daemon');

  const child = spawn(opts.cliPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout?.on('data', (data) => {
    for (const line of data.toString().split(/\r?\n/)) {
      const kind = classifyLogLine(line);
      if (kind === 'log') {
        logger.debug({ source: 'signal-cli' }, line.trim());
      } else if (kind === 'error') {
        logger.error({ source: 'signal-cli' }, line.trim());
      }
    }
  });

  child.stderr?.on('data', (data) => {
    for (const line of data.toString().split(/\r?\n/)) {
      const kind = classifyLogLine(line);
      if (kind === 'log') {
        logger.debug({ source: 'signal-cli' }, line.trim());
      } else if (kind === 'error') {
        logger.error({ source: 'signal-cli' }, line.trim());
      }
    }
  });

  child.on('error', (err) => {
    logger.error({ err }, 'signal-cli spawn error');
  });

  child.on('exit', (code, signal) => {
    logger.info({ code, signal }, 'signal-cli daemon exited');
  });

  return {
    pid: child.pid,
    process: child,
    stop: () => {
      if (!child.killed) {
        logger.info('Stopping signal-cli daemon');
        child.kill('SIGTERM');
      }
    },
  };
}
