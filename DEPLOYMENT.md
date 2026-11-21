# دليل النشر والتشغيل — نظام ميزان المحاسبي المتكامل

## 1. الاتصال بقاعدة البيانات (Supabase Transaction Pooler)

يتصل الخادم بقاعدة بيانات PostgreSQL عبر **Supabase Transaction Pooler (Port 6543)** باستخدام حزمة `pg` بدون استعلامات مُعدّة مسماة (`unnamed queries`) وبمعاملات ذرّية (`BEGIN / COMMIT`) متوافقة تماماً مع Supavisor.

المتغيرات البيئية:
- `DATABASE_URL` — رابط الاتصال عبر Transaction Pooler (`postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres`).
- `AUTH_SECRET` — (اختياري) مفتاح سري لتوقيع رموز الجلسات (HMAC-SHA256).

---

## 2. خطوات النشر على Vercel

1. **قاعدة البيانات**: تأكد من تنفيذ `supabase/schema.sql` في مشروع Supabase (تبدأ جميع الجداول فارغة تماماً بدون أي بيانات تجريبية).
2. **رفع المشروع إلى GitHub**: ادفع الملفات إلى مستودع GitHub خاص (مع إبقاء `.env` مستثنى في `.gitignore`).
3. **الاستيراد في Vercel**:
   - اختر المستودع في Vercel (سيقرأ إعدادات `vercel.json` و`api/index.ts` تلقائياً).
   - أضف `DATABASE_URL` و`AUTH_SECRET` في **Environment Variables**.
   - اضغط **Deploy**.
4. **الإعداد الأولي**:
   - عند فتح الرابط لأول مرة، ستظهر شاشة **الإعداد الأولي للنظام المحاسبي** لإنشاء حساب المدير الأول (`ADMIN`).
   - تُغلق شاشة الإعداد الأولي تلقائياً بعد إنشاء الحساب الأول.
