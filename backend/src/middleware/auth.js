const jwt = require('jsonwebtoken');
const User = require('../models/User');

const authenticate = async (req, res, next) => {
  try {
    // Support token from Authorization header or query param (for SSE/EventSource)
    const token = req.header('Authorization')?.replace('Bearer ', '') || req.query.token;

    if (!token) {
      throw new Error();
    }

    // Verify JWT token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id);

    if (!user || !user.is_active) {
      throw new Error();
    }

    // Add device tracking headers to request
    req.user = user;
    req.token = token;
    req.deviceId = req.headers['x-device-id'];
    req.userAgent = req.headers['user-agent'];
    
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ 
        error: 'Token expired',
        code: 'TOKEN_EXPIRED',
        message: 'Access token has expired. Please refresh your token.'
      });
    } else if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ 
        error: 'Invalid token',
        code: 'INVALID_TOKEN'
      });
    }
    
    res.status(401).json({ error: 'Please authenticate' });
  }
};

const optionalAuth = async (req, res, next) => {
  try {
    // Try JWT from Authorization header
    let token = req.header('Authorization')?.replace('Bearer ', '');

    // Fall back to cookie
    if (!token && req.cookies && req.cookies.token) {
      token = req.cookies.token;
    }

    if (token) {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await User.findById(decoded.id);

      if (user && user.is_active) {
        req.user = user;
        req.token = token;
        return next();
      }
    }

    // Fall back to x-api-key header
    const apiKey = req.headers['x-api-key'];
    if (apiKey) {
      try {
        const ApiKey = require('../models/ApiKey');
        const keyData = await ApiKey.verifyKey(apiKey);
        if (keyData && keyData.is_active && (!keyData.expires_at || new Date(keyData.expires_at) > new Date())) {
          req.user = {
            id: keyData.user_id,
            username: keyData.username,
            email: keyData.email,
            role: keyData.role,
          };
          req.apiKey = { id: keyData.id, name: keyData.name, permissions: keyData.permissions };
        }
      } catch (_) { /* swallow — optional auth */ }
    }

    next();
  } catch (error) {
    next();
  }
};

const requireAdmin = async (req, res, next) => {
  try {
    // First authenticate the user
    await new Promise((resolve, reject) => {
      authenticate(req, res, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    // Check if user has admin role
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    next();
  } catch (error) {
    res.status(401).json({ error: 'Please authenticate' });
  }
};

const generateToken = (user) => {
  return jwt.sign(
    { 
      id: user.id, 
      email: user.email,
      username: user.username,
      role: user.role
    },
    process.env.JWT_SECRET,
    { 
      expiresIn: process.env.JWT_EXPIRE || '7d' 
    }
  );
};

module.exports = { authenticate, optionalAuth, requireAdmin, generateToken };