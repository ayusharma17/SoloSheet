-- Phase 4: Add target_pages column
-- Run this in your Supabase SQL Editor

-- 1. Add target_pages column to course_materials
ALTER TABLE course_materials ADD COLUMN IF NOT EXISTS target_pages integer DEFAULT 1;

-- 2. Verify column exists
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'course_materials' AND column_name = 'target_pages';
