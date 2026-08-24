# Cross-OS and Any-Device Testing Guide

The **Distributed Job Scheduler (DJS)** is engineered with native cross-platform compatibility, enabling deterministic execution, test automation, and validation across **any Operating System**, **any CPU architecture**, and **any Client Device**.

---

## 1. Supported Operating Systems & Devices

| Platform / Device Category | Supported Environments | Primary Test Runner |
| :--- | :--- | :--- |
| **Windows** | Windows 10, 11, Server 2019/2022, WSL2 | `test.bat` or `.\test.ps1` |
| **Linux** | Ubuntu, Debian, Alpine, Fedora, CentOS, Arch, RHEL | `./test.sh` or `npm test` |
| **macOS** | Apple Silicon (M1/M2/M3/M4 arm64), Intel (x86_64) | `./test.sh` or `npm test` |
| **Docker & Containers** | Linux Containers, Windows Containers, Kubernetes Pods | `npm run test:docker` or `docker compose -f docker-compose.test.yml up` |
| **Edge / IoT Devices** | Raspberry Pi 4/5 (ARM64), NVIDIA Jetson, Embedded Nodes | `./test.sh` |
| **Mobile & Tablet Clients** | iOS Safari, Android Chrome, iPadOS (Responsive Viewports) | `npm run test:cross-device` |
| **Cloud CI/CD Matrix** | GitHub Actions, GitLab CI, AWS CodeBuild, GCP Cloud Build | `.github/workflows/cross-platform-ci.yml` |

---

## 2. Quickstart Test Commands

### Option A: Windows (CMD or PowerShell)

```cmd
:: Run all test suites with auto-discovery & OS diagnostics
test.bat

:: Run a specific test suite (e.g. security, os, device, e2e)
test.bat cross_os
test.bat cross_device
test.bat security
```

```powershell
# PowerShell with colored diagnostic banner
.\test.ps1

# Filter by suite name
.\test.ps1 -Filter cross_os
.\test.ps1 -Filter cross_device

# Run inside isolated Docker container
.\test.ps1 -Docker
```

---

### Option B: Linux & macOS (POSIX Shell)

```bash
# Make executable (first time only)
chmod +x test.sh

# Run all test suites
./test.sh

# Run specific suite filter
./test.sh cross_os
./test.sh cross_device

# Run inside isolated Docker test container
./test.sh --docker
```

---

### Option C: Universal NPM Scripts (Any OS)

```bash
# Run master cross-platform test runner
npm test

# Run Cross-OS compatibility suite
npm run test:cross-os

# Run Cross-Device & Responsive API suite
npm run test:cross-device

# Run Security & Hardening audit suite
npm run test:security

# Run isolated containerized test run
npm run test:docker
```

---

### Option D: Docker Containerized Testing (Zero Local Dependencies)

Run on any machine with Docker installed (Linux, Mac, Windows, Raspberry Pi, Cloud VM):

```bash
docker compose -f docker-compose.test.yml up --build --abort-on-container-exit --exit-code-from test-runner
```

---

## 3. Test Suites Overview

1. **`tests/cross_os_compatibility.test.js`**:
   - Validates path normalization (`/` vs `\`) across Windows and Unix filesystems.
   - Tests SQLite temporary database creation and file-locking across OS filesystems (NTFS, ext4, APFS).
   - Verifies environment variable resolution and platform-agnostic defaults.
   - Validates Redis connection fallback and in-memory broker compatibility.
   - Reports CPU core count, RAM, platform type (`win32`, `linux`, `darwin`), and architecture (`x64`, `arm64`).

2. **`tests/cross_device.test.js`**:
   - Tests API responses across diverse device User-Agents (iPhone 15 Pro, Galaxy S24, iPad Pro, Linux/Windows workstations, Raspberry Pi 5).
   - Validates CORS preflight headers for multi-device client connections (mobile LAN IPs, tablet browsers, localhost).
   - Tests low-bandwidth pagination and streaming payload limits.
   - Validates responsive viewport design token constraints.

3. **`tests/security_audit.test.js`**:
   - Validates RBAC permissions, IDOR multi-tenant isolation, SSRF prevention, and rate-limiting.

4. **`tests/e2e_system_suite.test.js`**:
   - End-to-end multi-worker execution, priority scheduling, retry backoff, DLQ, and distributed locking.

5. **`tests/dynamic_queue_sharding.test.js` & `tests/shard_routing.test.js`**:
   - High-throughput queue sharding, autoscaling, and global concurrency enforcement.

---

## 4. Continuous Integration (CI/CD)

The repository includes a GitHub Actions matrix workflow at [`.github/workflows/cross-platform-ci.yml`](../.github/workflows/cross-platform-ci.yml) that executes on every pull request and push across:
- `ubuntu-latest` (Linux x64)
- `windows-latest` (Windows x64)
- `macos-latest` (macOS arm64 / x86_64)
- Node.js 20.x and 22.x
- Docker container testbed
