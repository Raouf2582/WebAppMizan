import type { NextFunction, Request, Response } from 'express';
import type { UserProfile } from '../shared/types.ts';
import { verifySessionToken } from './auth.ts';
import { dbQuery } from './db.ts';
import { AppError } from './errors.ts';

declare global {
  namespace Express {
    interface Request {
      userProfile?: UserProfile;
    }
  }
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';

    if (!token) {
      throw new AppError(401, 'يلزم تسجيل الدخول للوصول إلى هذا المورد.', 'UNAUTHORIZED');
    }

    const session = verifySessionToken(token);
    if (!session) {
      throw new AppError(401, 'انتهت صلاحية الجلسة أو رمز التحقق غير صالح.', 'INVALID_SESSION');
    }

    const { rows } = await dbQuery<UserProfile>(
      `SELECT id, full_name, username, role, is_active, created_at, updated_at
       FROM public.profiles
       WHERE id = $1
       LIMIT 1`,
      [session.sub],
    );

    const profile = rows[0];
    if (!profile) {
      throw new AppError(403, 'لم يتم العثور على ملف المستخدم في النظام.', 'PROFILE_NOT_FOUND');
    }

    if (!profile.is_active) {
      throw new AppError(403, 'تم تعطيل هذا الحساب. يرجى التواصل مع مدير النظام.', 'ACCOUNT_DISABLED');
    }

    req.userProfile = profile;
    next();
  } catch (err) {
    next(err);
  }
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  if (!req.userProfile) {
    return next(new AppError(401, 'يلزم تسجيل الدخول.', 'UNAUTHORIZED'));
  }
  if (req.userProfile.role !== 'ADMIN') {
    return next(new AppError(403, 'هذه العملية متاحة لمدير النظام فقط.', 'ADMIN_REQUIRED'));
  }
  next();
}
