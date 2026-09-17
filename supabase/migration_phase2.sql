-- Phase 2: Add user_directive column and INSERT policy
-- Run this in your Supabase SQL Editor

-- 1. Add user_directive column to course_materials
ALTER TABLE course_materials ADD COLUMN IF NOT EXISTS user_directive text;

-- 2. Allow authenticated users to insert their own materials
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'course_materials' AND policyname = 'Users can insert own materials'
  ) THEN
    CREATE POLICY "Users can insert own materials"
      ON course_materials FOR INSERT
      WITH CHECK (auth.uid() = user_id);
  END IF;
END
$$;

-- 3. Create a secure function to decrement credits (called via RPC)
CREATE OR REPLACE FUNCTION decrement_credits(user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE profiles
  SET credits = credits - 1, updated_at = now()
  WHERE id = user_id AND credits > 0;
END;
$$;
