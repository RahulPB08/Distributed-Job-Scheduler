export class ShutdownManager {
  static setupGracefulShutdown(workerInstance) {
    const handleShutdown = async (signal) => {
      try {
        await workerInstance.shutdown();
      } catch (err) {
        process.stderr.write(`Error during shutdown: ${err.message}\n`);
      } finally {
        process.exit(0);
      }
    };

    process.on('SIGINT', () => handleShutdown('SIGINT'));
    process.on('SIGTERM', () => handleShutdown('SIGTERM'));
  }
}
