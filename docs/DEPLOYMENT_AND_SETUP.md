# Deployment, Configuration & Setup Guide

This guide covers local environment setup, running multi-instance worker pools, environment variables, and Docker Compose deployment.

---

## Prerequisites

- **Node.js**: v18.0.0 or higher (tested on Node v23)
- **npm**: v9.0.0 or higher
- **Python**: 3.10 or higher (tested on Python 3.13)
- **Redis**: v6.0+ (or use the built-in zero-config embedded RESP Redis broker)

---

## Local Development Setup

### 1. Backend REST API
```bash
cd backend
npm install
node src/database/seed.js
npm run start
```
*Backend runs on `http://localhost:4000` with WebSocket stream at `ws://localhost:4000/ws`.*

### 2. Python Scheduler Service
```bash
cd scheduler
pip install -r requirements.txt
python main.py
```

### 3. Node.js Worker Pool (Multiple Instances)
```bash
cd worker
npm install

# Start Worker Instance 1 (General Queues)
node src/index.js --worker-id=worker-alpha --concurrency=10 --queues=default,high-priority

# Start Worker Instance 2 (CPU & Webhooks)
node src/index.js --worker-id=worker-beta --concurrency=5 --queues=cpu-heavy,webhooks
```

### 4. React.js Frontend Dashboard
```bash
cd frontend
npm install
npm run dev
```
*Frontend runs on `http://localhost:3000`.*

---

## Environment Variables Reference

### Backend (`backend/.env`)
| Variable | Default Value | Description |
| :--- | :--- | :--- |
| `PORT` | `4000` | HTTP REST API listening port |
| `JWT_SECRET` | `djs-super-secret-jwt-key...` | Secret key for signing JWT tokens |
| `JWT_EXPIRES_IN` | `7d` | JWT session lifetime |
| `DB_PATH` | `./djs_database.sqlite` | SQLite database file location |
| `REDIS_HOST` | `127.0.0.1` | Redis host |
| `REDIS_PORT` | `6379` | Redis port |
| `USE_EMBEDDED_BROKER` | `true` | Enables embedded RESP broker fallback if external Redis is absent |

### Python Scheduler (`scheduler/config.py`)
| Variable | Default Value | Description |
| :--- | :--- | :--- |
| `DB_PATH` | `../backend/djs_database.sqlite` | Path to shared relational database |
| `REDIS_HOST` | `127.0.0.1` | Redis host |
| `REDIS_PORT` | `6379` | Redis port |
| `POLL_INTERVAL_SECONDS` | `1.0` | Dispatch loop tick interval |
| `HEARTBEAT_DEAD_THRESHOLD` | `45` | Seconds of missed heartbeat before worker is marked dead |

### Worker Fleet (`worker/.env`)
| Variable | Default Value | Description |
| :--- | :--- | :--- |
| `DB_PATH` | `../backend/djs_database.sqlite` | Path to shared relational database |
| `REDIS_HOST` | `127.0.0.1` | Redis host |
| `REDIS_PORT` | `6379` | Redis port |

---

## Docker Compose Deployment

To launch the full production stack with a single command:

```bash
docker-compose up --build -d
```

Services launched:
- `djs-redis`: Redis 7 in-memory broker
- `djs-backend`: Express REST API on port `4000`
- `djs-scheduler`: Python scheduler service
- `djs-worker-1`: Worker instance 1 (10 concurrency slots)
- `djs-worker-2`: Worker instance 2 (10 concurrency slots)
- `djs-frontend`: React production build on port `3000`

