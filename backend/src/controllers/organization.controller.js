import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { run, get, all } from '../database/db.js';

export const createOrgSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1).optional()
});

export const addMemberSchema = z.object({
  email: z.string().email(),
  role: z.enum(['leader', 'member']).optional().default('member')
});

export class OrganizationController {
  static async list(req, res, next) {
    try {
      if (req.user.role === 'admin') {
        const orgs = await all(
          `SELECT o.*, u.name as creator_name, u.email as creator_email,
                  (SELECT COUNT(*) FROM organization_members WHERE org_id = o.id) as member_count,
                  (SELECT COUNT(*) FROM projects WHERE org_id = o.id) as project_count
           FROM organizations o
           JOIN users u ON o.creator_id = u.id
           ORDER BY o.created_at DESC`
        );
        return res.json({ success: true, data: orgs });
      }

      const orgs = await all(
        `SELECT o.*, om.role as member_role, u.name as creator_name,
                (SELECT COUNT(*) FROM organization_members WHERE org_id = o.id) as member_count,
                (SELECT COUNT(*) FROM projects WHERE org_id = o.id) as project_count
         FROM organizations o
         JOIN organization_members om ON o.id = om.org_id
         JOIN users u ON o.creator_id = u.id
         WHERE om.user_id = ?
         ORDER BY o.created_at DESC`,
        [req.user.id]
      );
      res.json({ success: true, data: orgs });
    } catch (err) {
      next(err);
    }
  }

  static async create(req, res, next) {
    try {
      const parsed = createOrgSchema.parse(req.body);
      const finalSlug = parsed.slug || parsed.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
      const existing = await get('SELECT id FROM organizations WHERE slug = ?', [finalSlug]);

      if (existing) {
        return res.status(409).json({
          success: false,
          error: { code: 'CONFLICT', message: 'Organization with this slug already exists' }
        });
      }

      const orgId = uuidv4();
      const now = new Date().toISOString();

      await run(
        'INSERT INTO organizations (id, name, slug, creator_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        [orgId, parsed.name, finalSlug, req.user.id, now, now]
      );

      await run(
        'INSERT INTO organization_members (id, org_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)',
        [uuidv4(), orgId, req.user.id, 'leader', now]
      );

      const defaultProjectId = uuidv4();
      await run(
        'INSERT INTO projects (id, org_id, created_by_user_id, name, slug, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [defaultProjectId, orgId, req.user.id, 'Default Project', 'default-project', 'Initial organization workspace', now, now]
      );

      const policyId = uuidv4();
      await run(
        'INSERT INTO retry_policies (id, project_id, name, strategy, max_retries, base_delay_seconds, max_delay_seconds, backoff_multiplier, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [policyId, defaultProjectId, 'Default Policy', 'exponential_backoff', 3, 5, 300, 2.0, now, now]
      );

      const { ensureServiceQueues } = await import('./queue.controller.js');
      await ensureServiceQueues(defaultProjectId);

      const created = await get('SELECT * FROM organizations WHERE id = ?', [orgId]);
      res.status(201).json({ success: true, data: created });
    } catch (err) {
      next(err);
    }
  }

  static async getMembers(req, res, next) {
    try {
      const { id } = req.params;
      const membership = await get(
        'SELECT role FROM organization_members WHERE org_id = ? AND user_id = ?',
        [id, req.user.id]
      );

      if (!membership && req.user.role !== 'admin') {
        return res.status(403).json({
          success: false,
          error: { code: 'FORBIDDEN', message: 'You are not a member of this organization' }
        });
      }

      const members = await all(
        `SELECT u.id, u.email, u.name, u.role as user_role, om.role as org_role, om.created_at as joined_at
         FROM organization_members om
         JOIN users u ON om.user_id = u.id
         WHERE om.org_id = ?
         ORDER BY om.created_at ASC`,
        [id]
      );

      res.json({ success: true, data: members });
    } catch (err) {
      next(err);
    }
  }

  static async addMemberByEmail(req, res, next) {
    try {
      const { id } = req.params;
      const parsed = addMemberSchema.parse(req.body);

      const org = await get('SELECT * FROM organizations WHERE id = ?', [id]);
      if (!org) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Organization not found' } });
      }

      const isLeader = org.creator_id === req.user.id;
      const isAdmin = req.user.role === 'admin';

      if (!isLeader && !isAdmin) {
        return res.status(403).json({
          success: false,
          error: { code: 'FORBIDDEN', message: 'Only the Organization Leader can add new members' }
        });
      }

      const targetUser = await get('SELECT id, email, name, role FROM users WHERE email = ?', [parsed.email]);
      if (!targetUser) {
        return res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: `User with email "${parsed.email}" was not found. Please ensure they have registered an account first.` }
        });
      }

      const existingMember = await get(
        'SELECT id FROM organization_members WHERE org_id = ? AND user_id = ?',
        [id, targetUser.id]
      );

      if (existingMember) {
        return res.status(409).json({
          success: false,
          error: { code: 'CONFLICT', message: 'User is already a member of this organization' }
        });
      }

      const memberId = uuidv4();
      const now = new Date().toISOString();

      await run(
        'INSERT INTO organization_members (id, org_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)',
        [memberId, id, targetUser.id, parsed.role, now]
      );

      res.status(201).json({
        success: true,
        message: `User ${targetUser.email} successfully added to organization`,
        data: {
          id: memberId,
          user_id: targetUser.id,
          email: targetUser.email,
          name: targetUser.name,
          role: parsed.role,
          joined_at: now
        }
      });
    } catch (err) {
      next(err);
    }
  }

  static async getById(req, res, next) {
    try {
      const org = await get(
        `SELECT o.*, u.name as creator_name,
                (SELECT COUNT(*) FROM organization_members WHERE org_id = o.id) as member_count,
                (SELECT COUNT(*) FROM projects WHERE org_id = o.id) as project_count
         FROM organizations o
         JOIN users u ON o.creator_id = u.id
         WHERE o.id = ?`,
        [req.params.id]
      );
      if (!org) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Organization not found' } });

      if (req.user.role !== 'admin') {
        const membership = await get('SELECT id FROM organization_members WHERE org_id = ? AND user_id = ?', [org.id, req.user.id]);
        if (!membership) return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Access denied' } });
      }
      res.json({ success: true, data: org });
    } catch (err) { next(err); }
  }

  static async update(req, res, next) {
    try {
      const { id } = req.params;
      const org = await get('SELECT * FROM organizations WHERE id = ?', [id]);
      if (!org) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Organization not found' } });

      const isOwner = org.creator_id === req.user.id;
      if (!isOwner && req.user.role !== 'admin') {
        return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Only the org creator can update it' } });
      }

      const { name } = req.body;
      const now = new Date().toISOString();
      if (name) await run('UPDATE organizations SET name = ?, updated_at = ? WHERE id = ?', [name, now, id]);

      const updated = await get('SELECT * FROM organizations WHERE id = ?', [id]);
      res.json({ success: true, data: updated });
    } catch (err) { next(err); }
  }

  static async delete(req, res, next) {
    try {
      const { id } = req.params;
      const org = await get('SELECT * FROM organizations WHERE id = ?', [id]);
      if (!org) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Organization not found' } });

      if (org.creator_id !== req.user.id && req.user.role !== 'admin') {
        return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Only org creator or global admin can delete' } });
      }

      await run('DELETE FROM organizations WHERE id = ?', [id]);
      res.json({ success: true, message: 'Organization deleted' });
    } catch (err) { next(err); }
  }
}


