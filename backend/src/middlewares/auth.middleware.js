import jwt from 'jsonwebtoken';
import { ENV } from '../config/env.js';
import { get } from '../database/db.js';

export const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    let apiKey = req.headers['x-api-key'];
    if (!apiKey && authHeader && authHeader.startsWith('Bearer djs_')) {
      apiKey = authHeader.split(' ')[1];
    }

    if (apiKey) {
      const user = await get('SELECT id, email, name, role, api_key FROM users WHERE api_key = ?', [apiKey]);
      if (!user) {
        return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid API Key' } });
      }
      req.user = user;
      return next();
    }

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, ENV.JWT_SECRET);
    const user = await get('SELECT id, email, name, role, api_key FROM users WHERE id = ?', [decoded.id]);

    if (!user) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'User not found' } });
    }

    req.user = user;
    next();
  } catch (err) {
    res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } });
  }
};

export const requireOrgMember = async (req, res, next) => {
  try {
    if (req.user.role === 'admin') return next();

    const orgId = req.params.orgId || req.query.orgId || req.body.orgId;
    if (!orgId) return next();

    const membership = await get(
      'SELECT id, role FROM organization_members WHERE org_id = ? AND user_id = ?',
      [orgId, req.user.id]
    );

    if (!membership) {
      return res.status(403).json({
        success: false,
        error: { code: 'FORBIDDEN', message: 'You do not have access to this organization' }
      });
    }

    req.orgRole = membership.role;
    next();
  } catch (err) {
    next(err);
  }
};
