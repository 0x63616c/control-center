interface LifecycleWorker {
  run(): Promise<void>;
  shutdown(): void;
}

interface LifecycleLogger {
  info(data: Record<string, string>, message: string): void;
  info(message: string): void;
}

interface WorkerLifecycleDependencies {
  worker: LifecycleWorker;
  closeClient(): Promise<void>;
  closeNative(): Promise<void>;
  logger: LifecycleLogger;
}

export function createWorkerLifecycle(dependencies: WorkerLifecycleDependencies): {
  run(): Promise<void>;
  shutdown(signal: string): void;
} {
  let shutdownRequested = false;

  return {
    shutdown(signal) {
      if (shutdownRequested) return;
      shutdownRequested = true;
      dependencies.logger.info({ signal }, "temporal worker shutting down");
      dependencies.worker.shutdown();
    },
    async run() {
      try {
        await dependencies.worker.run();
      } finally {
        try {
          await dependencies.closeClient();
        } finally {
          await dependencies.closeNative();
        }
      }
      dependencies.logger.info("temporal worker stopped");
    },
  };
}
