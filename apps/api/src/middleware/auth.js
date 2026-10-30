import jwt from 'jsonwebtoken';

export function requireAuth(req, res, next) {
  const token = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'يلزم تسجيل الدخول' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    return next();
  } catch {
    return res.status(401).json({ error: 'جلسة الدخول غير صالحة' });
  }
}

export function requireRole(...roles) {
  return (req, res, next) => roles.includes(req.user?.role)
    ? next() : res.status(403).json({ error: 'ليست لديك الصلاحية المطلوبة' });
}
