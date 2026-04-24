-- Fix RLS policies for Supabase Realtime + admin dashboard
--
-- Problem: "using (false)" on SELECT blocks Supabase Realtime postgres_changes.
-- Realtime events are only delivered when the subscribing key (anon) has
-- SELECT permission on the table. Writes go through server-side API routes
-- using the service_role key, which bypasses RLS entirely — so blocking
-- INSERT/UPDATE/DELETE for anon is still correct.
--
-- Run this in Supabase Dashboard → SQL Editor

-- Drop the old deny-all policies
DROP POLICY IF EXISTS "No client access conversations" ON instagram_conversations;
DROP POLICY IF EXISTS "No client access messages" ON instagram_messages;

-- Allow anon SELECT (required for Realtime postgres_changes to fire in the browser)
CREATE POLICY "anon_select_conversations"
  ON instagram_conversations FOR SELECT TO anon USING (true);

CREATE POLICY "anon_select_messages"
  ON instagram_messages FOR SELECT TO anon USING (true);

-- Block all client-side writes (only service_role API routes can write)
CREATE POLICY "deny_anon_insert_conversations"
  ON instagram_conversations FOR INSERT TO anon WITH CHECK (false);

CREATE POLICY "deny_anon_update_conversations"
  ON instagram_conversations FOR UPDATE TO anon USING (false) WITH CHECK (false);

CREATE POLICY "deny_anon_delete_conversations"
  ON instagram_conversations FOR DELETE TO anon USING (false);

CREATE POLICY "deny_anon_insert_messages"
  ON instagram_messages FOR INSERT TO anon WITH CHECK (false);

CREATE POLICY "deny_anon_update_messages"
  ON instagram_messages FOR UPDATE TO anon USING (false) WITH CHECK (false);

CREATE POLICY "deny_anon_delete_messages"
  ON instagram_messages FOR DELETE TO anon USING (false);
