-- Safe incremental migration: Username-only authentication on public.profiles
-- Preserves existing profile rows by deriving unique usernames if NULL,
-- and drops NOT NULL on email so new accounts never require an email address.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS username TEXT;

ALTER TABLE public.profiles
  ALTER COLUMN email DROP NOT NULL;

DO $$
DECLARE
  r RECORD;
  v_base TEXT;
  v_candidate TEXT;
  v_suffix INTEGER;
BEGIN
  FOR r IN
    SELECT id, email, full_name
    FROM public.profiles
    WHERE username IS NULL OR trim(username) = ''
    ORDER BY created_at ASC
  LOOP
    v_base := lower(regexp_replace(
      COALESCE(NULLIF(split_part(COALESCE(r.email, ''), '@', 1), ''), NULLIF(trim(r.full_name), ''), 'user'),
      '[^a-zA-Z0-9._-]+',
      '',
      'g'
    ));
    IF char_length(v_base) < 2 THEN
      v_base := 'user_' || substr(replace(r.id::TEXT, '-', ''), 1, 6);
    END IF;

    v_candidate := v_base;
    v_suffix := 1;
    WHILE EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id <> r.id AND lower(username) = lower(v_candidate)
    ) LOOP
      v_suffix := v_suffix + 1;
      v_candidate := v_base || '_' || v_suffix::TEXT;
    END LOOP;

    UPDATE public.profiles SET username = v_candidate WHERE id = r.id;
  END LOOP;
END $$;

ALTER TABLE public.profiles
  ALTER COLUMN username SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'profiles_username_length_check'
      AND conrelid = 'public.profiles'::regclass
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_username_length_check
      CHECK (char_length(trim(username)) >= 2 AND username !~ '\s');
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_username_lower_unique
  ON public.profiles (LOWER(username));

REVOKE SELECT ON public.profiles FROM authenticated;
GRANT SELECT (id, full_name, username, role, is_active, created_at, updated_at) ON public.profiles TO authenticated;
