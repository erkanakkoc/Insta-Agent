-- Instagram Leads Table
-- Run in Supabase Dashboard → SQL Editor

create table if not exists instagram_leads (
  id uuid default gen_random_uuid() primary key,
  igsid text not null,
  conversation_id uuid references instagram_conversations(id) on delete set null,
  name text,
  username text,
  interest text,          -- 'roller' | 'ice'
  location text,          -- 'bostanli' | 'göztepe' | 'unknown'
  lesson_type text,       -- 'private' | 'group' | 'unknown'
  notes text,
  created_at timestamp with time zone default now()
);

create index if not exists idx_leads_igsid on instagram_leads(igsid);
create index if not exists idx_leads_created on instagram_leads(created_at desc);

-- RLS: anon can read, only service_role can write
alter table instagram_leads enable row level security;

create policy "anon_select_leads"
  on instagram_leads for select to anon using (true);

create policy "deny_anon_insert_leads"
  on instagram_leads for insert to anon with check (false);

create policy "deny_anon_update_leads"
  on instagram_leads for update to anon using (false);

create policy "deny_anon_delete_leads"
  on instagram_leads for delete to anon using (false);
