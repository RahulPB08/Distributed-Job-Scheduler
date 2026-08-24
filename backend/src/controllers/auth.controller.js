import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { run, get, all } from '../database/db.js';
import { ENV } from '../config/env.js';

export const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1),
  role: z.enum(['admin', 'developer']).optional().default('developer')
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1)
});

export class AuthController {
  static async register(req, res, next) {
    try {
      const parsed = registerSchema.parse(req.body);
      const existingUser = await get('SELECT id FROM users WHERE email = ?', [parsed.email]);
      if (existingUser) {
        return res.status(409).json({
          success: false,
          error: { code: 'CONFLICT', message: 'User with this email already exists' }
        });
      }

      let assignedRole = 'developer';
      if (parsed.role === 'admin') {
        const existingAdmin = await get('SELECT id FROM users WHERE role = "admin"');
        if (!existingAdmin) {
          assignedRole = 'admin';
        }
      }

      const userId = uuidv4();
      const apiKey = `djs_${uuidv4().replace(/-/g, '')}`;
      const passwordHash = await bcrypt.hash(parsed.password, 10);
      const now = new Date().toISOString();

      await run(
        'INSERT INTO users (id, email, password_hash, name, role, api_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [userId, parsed.email, passwordHash, parsed.name, assignedRole, apiKey, now, now]
      );

      const orgId = uuidv4();
      const orgName = `${parsed.name}'s Workspace`;
      const orgSlug = `${parsed.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now().toString().slice(-4)}`;

      await run(
        'INSERT INTO organizations (id, name, slug, creator_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        [orgId, orgName, orgSlug, userId, now, now]
      );

      await run(
        'INSERT INTO organization_members (id, org_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)',
        [uuidv4(), orgId, userId, 'leader', now]
      );

      const projectId = uuidv4();
      await run(
        'INSERT INTO projects (id, org_id, created_by_user_id, name, slug, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [projectId, orgId, userId, 'Default Project', 'default-project', 'Initial default project', now, now]
      );

      const policyId = uuidv4();
      await run(
        'INSERT INTO retry_policies (id, project_id, name, strategy, max_retries, base_delay_seconds, max_delay_seconds, backoff_multiplier, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [policyId, projectId, 'Default Exponential Policy', 'exponential_backoff', 3, 5, 300, 2.0, now, now]
      );

      const queueId = uuidv4();
      await run(
        'INSERT INTO queues (id, project_id, retry_policy_id, name, description, priority, max_concurrency, is_paused, shard_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [queueId, projectId, policyId, 'default', 'Default FIFO job queue', 10, 5, 0, 0, now, now]
      );

      const token = jwt.sign(
        { id: userId, email: parsed.email, role: assignedRole },
        ENV.JWT_SECRET,
        { expiresIn: ENV.JWT_EXPIRES_IN }
      );

      res.status(201).json({
        success: true,
        data: {
          token,
          user: {
            id: userId,
            email: parsed.email,
            name: parsed.name,
            role: assignedRole,
            apiKey
          }
        }
      });
    } catch (err) {
      next(err);
    }
  }

  static async login(req, res, next) {
    try {
      const parsed = loginSchema.parse(req.body);
      const user = await get('SELECT * FROM users WHERE email = ?', [parsed.email]);

      if (!user) {
        return res.status(401).json({
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Invalid email or password' }
        });
      }

      const match = await bcrypt.compare(parsed.password, user.password_hash);
      if (!match) {
        return res.status(401).json({
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Invalid email or password' }
        });
      }

      const token = jwt.sign(
        { id: user.id, email: user.email, role: user.role },
        ENV.JWT_SECRET,
        { expiresIn: ENV.JWT_EXPIRES_IN }
      );

      res.json({
        success: true,
        data: {
          token,
          user: {
            id: user.id,
            email: user.email,
            name: user.name,
            role: user.role,
            apiKey: user.api_key
          }
        }
      });
    } catch (err) {
      next(err);
    }
  }

  static async getMe(req, res, next) {
    try {
      const user = req.user;
      const memberships = await all(
        `SELECT o.id, o.name, o.slug, o.creator_id, om.role as member_role
         FROM organizations o
         JOIN organization_members om ON o.id = om.org_id
         WHERE om.user_id = ?`,
        [user.id]
      );

      res.json({
        success: true,
        data: {
          user: {
            id: user.id,
            email: user.email,
            name: user.name,
            role: user.role,
            apiKey: user.api_key,
            organizations: memberships
          }
        }
      });
    } catch (err) {
      next(err);
    }
  }

  static async regenerateApiKey(req, res, next) {
    try {
      const newKey = `djs_${uuidv4().replace(/-/g, '')}`;
      const now = new Date().toISOString();
      await run('UPDATE users SET api_key = ?, updated_at = ? WHERE id = ?', [newKey, now, req.user.id]);
      res.json({ success: true, data: { apiKey: newKey } });
    } catch (err) {
      next(err);
    }
  }

  static async listUsers(req, res, next) {
    try {
      if (req.user.role !== 'admin') {
        return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Admin access required' } });
      }
      const users = await all('SELECT id, email, name, role, created_at FROM users ORDER BY created_at DESC');
      res.json({ success: true, data: users });
    } catch (err) {
      next(err);
    }
  }

  static async getUserByEmail(req, res, next) {
    try {
      const { email } = req.query;
      if (!email) {
        return res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: 'Email is required' } });
      }
      const user = await get('SELECT id, email, name, role FROM users WHERE email = ?', [email]);
      if (!user) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'User not found' } });
      }
      res.json({ success: true, data: user });
    } catch (err) {
      next(err);
    }
  }

  static async deleteUser(req, res, next) {
    try {
      if (req.user.role !== 'admin') {
        return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Admin access required' } });
      }
      if (req.params.id === req.user.id) {
        return res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: 'Cannot delete own account' } });
      }
      await run('DELETE FROM users WHERE id = ?', [req.params.id]);
      res.json({ success: true, message: 'User deleted' });
    } catch (err) {
      next(err);
    }
  }
}
