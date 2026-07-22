import { fileURLToPath } from 'node:url';

import {
  createOpenSandboxLiveAcceptanceFailureReport,
  getOpenSandboxLiveAcceptanceExitCode,
  runOpenSandboxLiveAcceptance,
} from './live-acceptance.js';

/**
 * Runs the non-interactive operator command with JSON-only stdout.
 *
 * @param {{
 *   environment?: NodeJS.ProcessEnv | Record<string, string | undefined>,
 *   stdout?: { write(chunk: string): unknown },
 *   processEvents?: NodeJS.Process,
 *   runAcceptance?: typeof runOpenSandboxLiveAcceptance,
 * }} options
 */
export const runOpenSandboxLiveAcceptanceCli = async ({
  environment = process.env,
  stdout = process.stdout,
  processEvents = process,
  runAcceptance = runOpenSandboxLiveAcceptance,
} = {}) => {
  const controller = new AbortController();
  let receivedSignal = null;
  const onSigint = () => {
    if (receivedSignal !== null) return;
    receivedSignal = 'SIGINT';
    controller.abort();
  };
  const onSigterm = () => {
    if (receivedSignal !== null) return;
    receivedSignal = 'SIGTERM';
    controller.abort();
  };
  processEvents.on('SIGINT', onSigint);
  processEvents.on('SIGTERM', onSigterm);

  let report;
  try {
    report = await runAcceptance({ environment, signal: controller.signal });
  } catch {
    report = createOpenSandboxLiveAcceptanceFailureReport();
  } finally {
    processEvents.off('SIGINT', onSigint);
    processEvents.off('SIGTERM', onSigterm);
  }

  stdout.write(`${JSON.stringify(report)}\n`);
  if (receivedSignal === 'SIGINT') return 130;
  if (receivedSignal === 'SIGTERM') return 143;
  return getOpenSandboxLiveAcceptanceExitCode(report);
};

const isDirectExecution = process.argv[1]
  && fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectExecution) {
  process.exitCode = await runOpenSandboxLiveAcceptanceCli();
}
