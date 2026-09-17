-- ============================================================
-- Phase 1: Profiles, Course Materials, RLS & Auto-Creation
-- (Already applied to Supabase — kept here for reference)
-- ============================================================

-- Create a table for user profiles and credits
CREATE TABLE IF NOT EXISTS profiles (
  id uuid REFERENCES auth.users ON DELETE CASCADE PRIMARY KEY,
  email text UNIQUE,
  credits integer DEFAULT 3 CHECK (credits >= 0),
  updated_at timestamp with time zone DEFAULT now()
);

-- Create a table for the AI-extracted course data
CREATE TABLE IF NOT EXISTS course_materials (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid REFERENCES auth.users ON DELETE CASCADE NOT NULL,
  course_name text,
  extracted_json jsonb, -- This holds the dense notes/formulae
  created_at timestamp with time zone DEFAULT now()
);

-- Enable RLS on both tables
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE course_materials ENABLE ROW LEVEL SECURITY;

-- Set up RLS Policies: Users can only see/read their own data
CREATE POLICY "Users can view own profile" ON profiles FOR SELECT USING (auth.uid() = id);
CREATE POLICY "Users can view own materials" ON course_materials FOR SELECT USING (auth.uid() = user_id);

-- Create a Trigger to automatically create a profile and give 3 credits on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
BEGIN
  INSERT INTO public.profiles (id, email, credits)
  VALUES (new.id, new.email, 3);
  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE PROCEDURE public.handle_new_user();
