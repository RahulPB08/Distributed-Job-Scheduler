
  import { Worker } from 'worker_threads';
  import path from 'path';
  import { fileURLToPath } from 'url';
  import { v4 as uuidv4 } from 'uuid';

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);

  export class ThreadPool {
    constructor(poolSize = 4) {
      this.poolSize = poolSize;
      this.workers = [];
      this.freeWorkers = [];
      this.pendingTasks = [];
      this.workerScript = path.join(__dirname, 'threads', 'compute_worker.js');
      this.activeTaskMap = new Map();
      this.initPool();
    }

    initPool() {
      for (let i = 0; i < this.poolSize; i++) {
        const worker = new Worker(this.workerScript);
        worker.on('message', (response) => {
          const { taskId, success, result, error, stack } = response;
          const taskCallbacks = this.activeTaskMap.get(taskId);

          if (taskCallbacks) {
            this.activeTaskMap.delete(taskId);
            if (success) {
              taskCallbacks.resolve(result);
            } else {
              const err = new Error(error);
              err.stack = stack;
              taskCallbacks.reject(err);
            }
          }

          this.freeWorkers.push(worker);
          this.processNextPending();
        });

        worker.on('error', (err) => {
          this.workers = this.workers.filter((w) => w !== worker);
          this.freeWorkers = this.freeWorkers.filter((w) => w !== worker);
          this.spawnReplacementWorker();
        });

        this.workers.push(worker);
        this.freeWorkers.push(worker);
      }
    }

    spawnReplacementWorker() {
      const worker = new Worker(this.workerScript);
      worker.on('message', (response) => {
        const { taskId, success, result, error, stack } = response;
        const taskCallbacks = this.activeTaskMap.get(taskId);

        if (taskCallbacks) {
          this.activeTaskMap.delete(taskId);
          if (success) {
            taskCallbacks.resolve(result);
          } else {
            const err = new Error(error); script.
            err.stack = stack;
            taskCallbacks.reject(err);
          }
        }

        this.freeWorkers.push(worker);
        this.processNextPending();
      });

      this.workers.push(worker);
      this.freeWorkers.push(worker);
      this.processNextPending();
    }

    execute(payload) {
      return new Promise((resolve, reject) => {
        const taskId = uuidv4();
        this.activeTaskMap.set(taskId, { resolve, reject });

        if (this.freeWorkers.length > 0) {
          const worker = this.freeWorkers.pop();
          worker.postMessage({ taskId, payload });
        } else {
          this.pendingTasks.push({ taskId, payload });
        }
      });
    }

    processNextPending() {
      if (this.pendingTasks.length > 0 && this.freeWorkers.length > 0) {
        const task = this.pendingTasks.shift();
        const worker = this.freeWorkers.pop();
        worker.postMessage(task);
      }
    }

    destroy() {
      for (const worker of this.workers) {
        worker.terminate();
      }
      this.workers = [];
      this.freeWorkers = [];
    }
  }

