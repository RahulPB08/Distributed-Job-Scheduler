# Authentication, API Keys & Role-Based Access Control (RBAC)

The platform enforces multi-tenant authentication and granular role-based permissions across all API endpoints and resources.

---

## Supported Authentication Methods

### 1. JSON Web Tokens (JWT)
- **Header**: `Authorization: Bearer <jwt_token>`
- **Payload**:
```json
{
  "id": "user-uuid",
  "email": "dev@djs.io",
  "role": "developer",
  "orgId": "org-uuid",
  "iat": 1740000000,
  "exp": 1740604800
}
```
- **Expiration**: Configurable via `JWT_EXPIRES_IN` (defaults to 7 days).

### 2. Programmatic API Keys
- **Header**: `x-api-key: djs_<hex_token>`
- Enables external backend services, CI/CD pipelines, and automated scripts to dispatch jobs and query status without interactive login flows.

---

## Role-Based Access Control (RBAC) Matrix

| Resource & Operation | Admin | Developer | Viewer |
| :--- | :---: | :---: | :---: |
| **View Dashboard & Metrics** | Yes | Yes | Yes |
| **Inspect Jobs, Queues & Workers** | Yes | Yes | Yes |
| **Dispatch Immediate / Delayed Jobs** | Yes | Yes | No |
| **Create & Submit Batch Pipelines** | Yes | Yes | No |
| **Create & Edit Recurring Cron Schedules** | Yes | Yes | No |
| **Pause, Resume & Purge Queues** | Yes | Yes | No |
| **Retry Failed Jobs & DLQ Entries** | Yes | Yes | No |
| **Trigger AI Failure Diagnostics** | Yes | Yes | No |
| **Create Projects & Retry Policies** | Yes | Yes | No |
| **Drain Worker Fleet Instances** | Yes | Yes | No |
| **Stop Worker Fleet Instances** | Yes | No | No |
| **User Role Management** | Yes | No | No |
| **Delete Projects & Schedules** | Yes | No | No |

---

## Pre-Configured Demo Accounts

For immediate testing, the database seed script provides 3 accounts:

| Role | Email | Default Password | API Key |
| :--- | :--- | :--- | :--- |
| **Admin** | `admin@djs.io` | `AdminPassword123!` | `djs_admin_key_1234567890abcdef` |
| **Developer** | `dev@djs.io` | `DevPassword123!` | `djs_dev_key_1234567890abcdef` |
| **Viewer** | `viewer@djs.io` | `ViewerPassword123!` | `djs_viewer_key_1234567890abcdef` |

