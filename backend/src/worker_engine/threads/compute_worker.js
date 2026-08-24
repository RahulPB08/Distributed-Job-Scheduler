import { parentPort } from 'worker_threads';
import crypto from 'crypto';

parentPort.on('message', (task) => {
  const { taskId, payload } = task;
  const startTime = Date.now();

  try {
    const {
      algorithm = 'sha256',
      iterations = 100000,
      dataset_size = 1000,
      type = 'hash_iterations'
    } = payload;

    let resultData = {};

    if (type === 'matrix_multiply') {
      const size = Math.min(dataset_size, 300);
      const a = Array.from({ length: size }, () => Array.from({ length: size }, () => Math.random()));
      const b = Array.from({ length: size }, () => Array.from({ length: size }, () => Math.random()));
      const c = Array.from({ length: size }, () => Array(size).fill(0));

      for (let i = 0; i < size; i++) {
        for (let j = 0; j < size; j++) {
          for (let k = 0; k < size; k++) {
            c[i][j] += a[i][k] * b[k][j];
          }
        }
      }
      resultData = {
        matrixSize: `${size}x${size}`,
        sampleChecksum: c[0][0].toFixed(4)
      };
    } else {
      let currentHash = crypto.createHash(algorithm).update('initial_seed_value').digest('hex');
      const limit = Math.min(iterations, 500000);

      for (let i = 0; i < limit; i++) {
        currentHash = crypto.createHash(algorithm).update(currentHash + i.toString()).digest('hex');
      }

      resultData = {
        algorithm,
        iterationsComputed: limit,
        finalHash: currentHash
      };
    }

    const durationMs = Date.now() - startTime;
    parentPort.postMessage({
      taskId,
      success: true,
      result: {
        ...resultData,
        durationMs,
        threadId: process.pid
      }
    });
  } catch (err) {
    parentPort.postMessage({
      taskId,
      success: false,
      error: err.message,
      stack: err.stack
    });
  }
});

