/**
 * Distributed Job Scheduler — Master Cross-Platform Test Suite Runner
 * Runs unified end-to-end, subsystem verification, cross-OS, and cross-device suites
 * on ANY Operating System (Windows, Linux, macOS, WSL) and ANY Architecture (x86_64, ARM64).
 */

import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Filter argument parsing (e.g. node tests/run_all.js --filter=security or node tests/run_all.js api)
const args = process.argv.slice(2);
let filterQuery = '';
for (const arg of args) {
  if (arg.startsWith('--filter=')) {
    filterQuery = arg.split('=')[1].toLowerCase();
  } else if (!arg.startsWith('-')) {
    filterQuery = arg.toLowerCase();
  }
}

// Auto-discover all .test.js files in tests/
const allFiles = fs.readdirSync(__dirname)
  .filter(f => f.endsWith('.test.js'))
  .sort((a, b) => {
    // Prioritize system & cross-platform suites first
    if (a.includes('e2e_system')) return -1;
    if (b.includes('e2e_system')) return 1;
    if (a.includes('cross_os')) return -1;
    if (b.includes('cross_os')) return 1;
    if (a.includes('cross_device')) return -1;
    if (b.includes('cross_device')) return 1;
    return a.localeCompare(b);
  });

const testFiles = filterQuery 
  ? allFiles.filter(f => f.toLowerCase().includes(filterQuery))
  : allFiles;

async function runSingleTest(file, timeoutMs = 45000) {
  const startTime = Date.now();
  return new Promise((resolve) => {
    const fullPath = path.resolve(__dirname, file);
    const backendNodeModules = path.resolve(__dirname, '../backend/node_modules');
    const workerNodeModules = path.resolve(__dirname, '../worker/node_modules');
    
    // Cross-platform node_path resolution
    const combinedNodePath = [
      backendNodeModules,
      workerNodeModules,
      process.env.NODE_PATH || ''
    ].filter(Boolean).join(path.delimiter);

    let isResolved = false;
    const proc = spawn(process.execPath, ['--test', fullPath], {
      stdio: 'inherit',
      env: {
        ...process.env,
        NODE_PATH: combinedNodePath
      }
    });

    const timer = setTimeout(() => {
      if (!isResolved) {
        isResolved = true;
        console.error(`\n✖ [TIMEOUT] Test suite ${file} exceeded ${timeoutMs / 1000}s limit. Terminating child process.`);
        try {
          // proc.kill() without signal works on all platforms including Windows
          proc.kill();
        } catch (e) {}
        const durationMs = Date.now() - startTime;
        resolve({ file, passed: false, durationMs, timedOut: true });
      }
    }, timeoutMs);

    proc.on('close', (code) => {
      if (!isResolved) {
        isResolved = true;
        clearTimeout(timer);
        const durationMs = Date.now() - startTime;
        resolve({ file, passed: code === 0, durationMs });
      }
    });

    proc.on('error', (err) => {
      if (!isResolved) {
        isResolved = true;
        clearTimeout(timer);
        const durationMs = Date.now() - startTime;
        resolve({ file, passed: false, durationMs, error: err.message });
      }
    });
  });
}

function printEnvironmentBanner() {
  const platform = os.platform();
  const arch = os.arch();
  const cpus = os.cpus();
  const totalMemGb = (os.totalmem() / (1024 * 1024 * 1024)).toFixed(2);
  const freeMemGb = (os.freemem() / (1024 * 1024 * 1024)).toFixed(2);

  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║   DISTRIBUTED JOB SCHEDULER — MASTER CROSS-PLATFORM TEST RUNNER      ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');
  console.log(` ▸ Operating System : ${platform} (${os.type()} ${os.release()})`);
  console.log(` ▸ Architecture     : ${arch} | Logical CPU Cores: ${cpus.length} [${cpus[0]?.model?.trim() || 'Generic'}]`);
  console.log(` ▸ Memory Profile   : ${freeMemGb} GB free / ${totalMemGb} GB total`);
  console.log(` ▸ Node.js Runtime  : ${process.version} (V8: ${process.versions.v8})`);
  console.log(` ▸ Workspace Root   : ${path.resolve(__dirname, '..')}`);
  if (filterQuery) {
    console.log(` ▸ Filter Applied   : "${filterQuery}" (${testFiles.length} matched)`);
  }
  console.log('────────────────────────────────────────────────────────────────────────\n');
}

async function runAll() {
  printEnvironmentBanner();

  if (testFiles.length === 0) {
    console.log(`⚠ No test files found matching query: "${filterQuery}"\n`);
    process.exit(1);
  }

  console.log(`Discovered ${testFiles.length} test suites. Executing sequential runs...\n`);

  const results = [];
  for (const file of testFiles) {
    console.log(`\n▶ [SUITE] RUNNING: tests/${file}...`);
    const res = await runSingleTest(file);
    results.push(res);
  }

  console.log('\n╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║   TEST SUITE EXECUTION SUMMARY                                       ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');

  let passedCount = 0;
  for (const r of results) {
    const timeStr = `${(r.durationMs / 1000).toFixed(2)}s`;
    if (r.passed) {
      console.log(`  ✓ PASSED : tests/${r.file.padEnd(35)} (${timeStr})`);
      passedCount++;
    } else {
      console.log(`  ✗ FAILED : tests/${r.file.padEnd(35)} (${timeStr})`);
    }
  }

  const passPercentage = Math.round((passedCount / results.length) * 100);
  console.log('────────────────────────────────────────────────────────────────────────');
  console.log(`TOTAL: ${passedCount} / ${results.length} Test Suites Passed (${passPercentage}%)\n`);

  const exitCode = passedCount === results.length ? 0 : 1;
  // Force exit to prevent any lingering handles (Redis, net.Server, timers) from
  // keeping the process alive after all tests finish.
  setTimeout(() => process.exit(exitCode), 500);
}

runAll();
