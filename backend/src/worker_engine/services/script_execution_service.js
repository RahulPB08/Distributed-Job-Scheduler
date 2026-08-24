export class ScriptExecutionService {
  static async execute(payload = {}, timeoutSeconds = 60, logCallback = () => {}) {
    const scriptName = payload.script || 'data_transform';
    const params = payload.params || {};

    logCallback('info', `Running custom script [${scriptName}] with parameters: ${JSON.stringify(params)}`);

    const startTime = Date.now();
    const delay = Math.floor(Math.random() * 120) + 30;
    await new Promise((r) => setTimeout(r, delay));

    if (payload.simulateFailure) {
      throw new Error(`Script Execution Error in [${scriptName}]: Exit code 1 - RuntimeException`);
    }

    const durationMs = Date.now() - startTime;
    logCallback('info', `Script [${scriptName}] finished successfully with exit code 0`);

    return {
      scriptName,
      exitCode: 0,
      output: `Script ${scriptName} completed transformation on ${JSON.stringify(params)}`,
      durationMs
    };
  }
}
