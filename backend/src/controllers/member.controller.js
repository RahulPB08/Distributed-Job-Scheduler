import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { run, get, all } from '../database/db.js';

// ─── Validation Schemas ────────────────────────────────────────────────────────
const inviteMemberSchema = z.object({
  email: z.string().email(),
  role: z.enum(['admin', 'developer', 'leader', 'member']).default('developer')
});

const updateRoleSchema = z.object({
  role: z.enum(['admin', 'developer', 'leader', 'member'])
});

/**
 * MemberController — manages organization membership (invite/remove/role-change)
 * All actions require the caller to be an admin of the target organization.
 */
export class MemberController {

  /** GET /api/organizations/:orgId/members */
  static async list(req, res, next) {
    try {
      const { orgId } = req.params;

      // Verify org exists and caller has access
      const org = await get('SELECT * FROM organizations WHERE id = ?', [orgId]);
      if (!org) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Organization not found' } });
      }

      const callerMembership = await get(
        'SELECT role FROM organization_members WHERE org_id = ? AND user_id = ?',
        [orgId, req.user.id]
      );
      if (!callerMembership && req.user.role !== 'admin') {
        return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Not a member of this organization' } });
      }

      const members = await all(
        `SELECT u.id, u.name, u.email, u.role as global_role, om.role as org_role, om.created_at as joined_at
         FROM organization_members om
         JOIN users u ON om.user_id = u.id
         WHERE om.org_id = ?
         ORDER BY om.created_at ASC`,
        [orgId]
      );

      res.json({ success: true, data: members });
    } catch (err) {
      next(err);
    }
  }

  /** POST /api/organizations/:orgId/members — invite a user by email */
  static async invite(req, res, next) {
    try {
      const { orgId } = req.params;
      const parsed = inviteMemberSchema.parse(req.body);

      // Only org admins (or global admins) can invite
      await MemberController._requireOrgAdmin(req, orgId, res);
      if (res.headersSent) return;

      let targetUser = await get('SELECT id, name, email FROM users WHERE email = ?', [parsed.email]);
      if (!targetUser) {
        // Auto-provision user account so invitation succeeds seamlessly
        const newUserId = uuidv4();
        const now = new Date().toISOString();
        const defaultName = parsed.email.split('@')[0];
        const defaultPasswordHash = await bcrypt.hash('welcome123', 10);
        const defaultApiKey = `djs_${uuidv4().replace(/-/g, '')}`;

        await run(
          'INSERT INTO users (id, email, password_hash, name, role, api_key, created_at, updated_at) VALUES (?, ?, ?, ?, "developer", ?, ?, ?)',
          [newUserId, parsed.email, defaultPasswordHash, defaultName, defaultApiKey, now, now]
        );

        targetUser = { id: newUserId, name: defaultName, email: parsed.email };
      }

      const existing = await get(
        'SELECT id FROM organization_members WHERE org_id = ? AND user_id = ?',
        [orgId, targetUser.id]
      );
      if (existing) {
        return res.status(409).json({
          success: false,
          error: { code: 'CONFLICT', message: 'User is already a member of this organization' }
        });
      }

      const id = uuidv4();
      const now = new Date().toISOString();
      await run(
        'INSERT INTO organization_members (id, org_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)',
        [id, orgId, targetUser.id, parsed.role, now]
      );

      res.status(201).json({
        success: true,
        data: { id, orgId, userId: targetUser.id, name: targetUser.name, email: targetUser.email, role: parsed.role, joined_at: now }
      });
    } catch (err) {
      next(err);
    }
  }

  /** PATCH /api/organizations/:orgId/members/:userId — change member role */
  static async updateRole(req, res, next) {
    try {
      const { orgId, userId } = req.params;
      const parsed = updateRoleSchema.parse(req.body);

      await MemberController._requireOrgAdmin(req, orgId, res);
      if (res.headersSent) return;

      if (userId === req.user.id) {
        return res.status(400).json({
          success: false,
          error: { code: 'BAD_REQUEST', message: 'Cannot change your own role' }
        });
      }

      const membership = await get(
        'SELECT id FROM organization_members WHERE org_id = ? AND user_id = ?',
        [orgId, userId]
      );
      if (!membership) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Member not found' } });
      }

      await run(
        'UPDATE organization_members SET role = ? WHERE org_id = ? AND user_id = ?',
        [parsed.role, orgId, userId]
      );

      res.json({ success: true, message: `Role updated to ${parsed.role}` });
    } catch (err) {
      next(err);
    }
  }

  /** DELETE /api/organizations/:orgId/members/:userId — remove a member */
  static async remove(req, res, next) {
    try {
      const { orgId, userId } = req.params;

      await MemberController._requireOrgAdmin(req, orgId, res);
      if (res.headersSent) return;

      if (userId === req.user.id) {
        return res.status(400).json({
          success: false,
          error: { code: 'BAD_REQUEST', message: 'Cannot remove yourself from an organization' }
        });
      }

      const result = await run(
        'DELETE FROM organization_members WHERE org_id = ? AND user_id = ?',
        [orgId, userId]
      );
      if (result.changes === 0) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Member not found' } });
      }

      res.json({ success: true, message: 'Member removed from organization' });
    } catch (err) {
      next(err);
    }
  }

  /** Helper: assert caller is admin of the org (or global admin) */
  static async _requireOrgAdmin(req, orgId, res) {
    if (req.user.role === 'admin') return; // Global admin bypasses

    const membership = await get(
      'SELECT role FROM organization_members WHERE org_id = ? AND user_id = ?',
      [orgId, req.user.id]
    );

    if (!membership) {
      res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Not a member of this organization' } });
      return;
    }
    if (membership.role !== 'admin' && membership.role !== 'leader') {
      res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Admin or Leader role required' } });
    }
  }
}
