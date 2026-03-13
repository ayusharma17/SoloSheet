-- ============================================================
-- Phase 5: Anti-Abuse & Identity Guard SQL Implementation
-- Run this in your Supabase SQL Editor
-- ============================================================

-- 0. Admin Whitelist Table
CREATE TABLE IF NOT EXISTS admin_whitelist (
    email text PRIMARY KEY,
    created_at timestamp with time zone DEFAULT now()
);

-- Insert the default admin
INSERT INTO admin_whitelist (email) VALUES ('ayush170505@gmail.com') ON CONFLICT DO NOTHING;

-- 1. Modified handle_new_user trigger (1 trial credit, .edu restriction, & whitelist)
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
DECLARE
  is_admin boolean;
BEGIN
  -- Check if the email is in the admin whitelist
  SELECT EXISTS(SELECT 1 FROM public.admin_whitelist WHERE email = new.email) INTO is_admin;

  -- Defense in depth: Deny non-.edu emails unless it's in the admin whitelist
  IF new.email NOT ILIKE '%.edu' AND NOT is_admin THEN
    RAISE EXCEPTION 'Access restricted to verified educational domains.';
  END IF;

  -- Insert profile with 1 trial credit (or 9999 for admin)
  IF is_admin THEN
      INSERT INTO public.profiles (id, email, credits)
      VALUES (new.id, new.email, 9999);
  ELSE
      INSERT INTO public.profiles (id, email, credits)
      VALUES (new.id, new.email, 1);
  END IF;
  
  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- 2. Device Fingerprints Table
CREATE TABLE IF NOT EXISTS device_fingerprints (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
    fingerprint_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);

-- Index for quick lookups
CREATE INDEX IF NOT EXISTS idx_fingerprints_hash ON device_fingerprints(fingerprint_hash);

-- Secure it via RLS
ALTER TABLE device_fingerprints ENABLE ROW LEVEL SECURITY;

-- RLS Policies
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'device_fingerprints' AND policyname = 'Users can insert own fingerprint'
  ) THEN
    CREATE POLICY "Users can insert own fingerprint" 
      ON device_fingerprints FOR INSERT WITH CHECK (auth.uid() = user_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'device_fingerprints' AND policyname = 'Users can view own fingerprint'
  ) THEN
    CREATE POLICY "Users can view own fingerprint" 
      ON device_fingerprints FOR SELECT USING (auth.uid() = user_id);
  END IF;
END
$$;

-- Secure function to register device fingerprint and revoke credit if duplicate
CREATE OR REPLACE FUNCTION register_device_fingerprint(client_hash text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    existing_count integer;
BEGIN
    -- Check if this fingerprint exists for ANY OTHER user
    SELECT count(*) INTO existing_count FROM device_fingerprints WHERE fingerprint_hash = client_hash AND user_id != auth.uid();
    
    -- If it does exist elsewhere, revoke the trial credit (assuming they haven't bought any yet)
    IF existing_count > 0 THEN
       UPDATE profiles SET credits = 0 WHERE id = auth.uid() AND credits = 1;
    END IF;
    
    -- Register it for the current user (fail silently if already inserted due to unique constraints, etc.)
    INSERT INTO device_fingerprints (user_id, fingerprint_hash)
    VALUES (auth.uid(), client_hash);
END;
$$;


-- 3. Financial Integration (Secure function for Stripe webhook)
CREATE OR REPLACE FUNCTION add_credits(target_user_id uuid, amount integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE profiles
  SET credits = credits + amount, 
      updated_at = now()
  WHERE id = target_user_id;
END;
$$;
