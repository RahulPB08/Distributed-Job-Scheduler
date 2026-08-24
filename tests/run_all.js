/**
 * Distributed Job Scheduler — Master Test Suite Runner
 * Runs the unified end-to-end test suite and subsystem verification suites.
 */

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const testFiles = [
  'e2e_system_suite.test.js',
  'api.test.js',
  'dynamic_queue_sharding.test.js',
  'data_isolation.test.js',
  'distributed_lock.test.js',
  'event_driven_execution.test.js',
  'rate_limiting.test.js',
  'retry.test.js',
  'shard_routing.test.js',
  'worker.test.js'
];

async function runSingleTest(file) {
  return new Promise((resolve) => {
    const fullPath = path.resolve(__dirname, file);
    const backendNodeModules = path.resolve(__dirname, '../backend/node_modules');
    const proc = spawn('node', ['--test', fullPath], {
      stdio: 'inherit',
      env: {
        ...process.env,
        NODE_PATH: `${backendNodeModules}${path.delimiter}${process.env.NODE_PATH || ''}`
      }
    });

    proc.on('close', (code) => {
      resolve({ file, passed: code === 0 });
    });
  });
}

async function runAll() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║   DISTRIBUTED JOB SCHEDULER — MASTER TEST SUITE RUNNER      ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  const results = [];
  for (const file of testFiles) {
    console.log(`\n▶ RUNNING: tests/${file}...`);
    const res = await runSingleTest(file);
    results.push(res);
  }

  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║   TEST SUITE EXECUTION SUMMARY                             ║');
  console.log('╚════════════════════════════════════════════════════════════╝');

  let passedCount = 0;
  for (const r of results) {
    if (r.passed) {
      console.log(`  ✓ PASSED: tests/${r.file}`);
      passedCount++;
    } else {
      console.log(`  ✗ FAILED: tests/${r.file}`);
    }
  }

  console.log(`\nTOTAL: ${passedCount} / ${results.length} Test Suites Passed (${Math.round((passedCount / results.length) * 100)}%)\n`);
  process.exit(passedCount === results.length ? 0 : 1);
}

runAll();
