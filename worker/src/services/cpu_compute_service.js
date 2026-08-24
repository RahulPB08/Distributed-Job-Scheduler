import crypto from 'crypto';

export class CpuComputeService {
  static async execute(payload = {}, timeoutSeconds = 60, logCallback = () => {}) {
    const operations = Math.min(payload.operations || 100000, 2000000);
    const computeType = payload.type || 'prime_sum';

    logCallback('info', `Starting CPU compute task [type: ${computeType}, ops: ${operations}]`);
    const startTime = Date.now();

    let resultData = {};

    if (computeType === 'prime_sum') {
      let primeCount = 0;
      let sum = 0;
      const isPrime = (num) => {
        for (let i = 2, s = Math.sqrt(num); i <= s; i++) {
          if (num % i === 0) return false;
        }
        return num > 1;
      };

      for (let i = 2; i < operations; i++) {
        if (isPrime(i)) {
          primeCount++;
          sum += i;
        }
      }
      resultData = { primesFound: primeCount, primeSum: sum, range: operations };
    } else if (computeType === 'hash_crunch') {
      let hash = 'seed_' + Date.now();
      for (let i = 0; i < operations; i++) {
        hash = crypto.createHash('sha256').update(hash + i).digest('hex');
      }
      resultData = { iterations: operations, finalHash: hash };
    } else {
      // General mathematical transformation
      let acc = 1;
      for (let i = 1; i <= operations; i++) {
        acc = (acc * 1.00001 + Math.sin(i)) % 1000000;
      }
      resultData = { iterations: operations, resultAccumulator: acc };
    }

    const durationMs = Date.now() - startTime;
    logCallback('info', `CPU compute task finished in ${durationMs}ms with result: ${JSON.stringify(resultData)}`);

    return {
      computeType,
      durationMs,
      result: resultData
    };
  }
}
