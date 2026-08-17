-- ============================================================================
-- migration_03 — เข้าสู่ระบบด้วยชื่อผู้ใช้ ไม่ต้องใช้อีเมลจริง
-- รันต่อจาก schema.sql และ migration_02.sql
-- ============================================================================
--
-- Supabase บังคับให้ auth ใช้อีเมล แต่ไม่ตรวจว่ามีอยู่จริง
-- หน้าเว็บจึงต่อ @mgk.local ให้เบื้องหลัง ผู้ใช้พิมพ์แค่ชื่อ
--
-- ปัญหาที่ต้องแก้พร้อมกัน: RLS เดิมให้สิทธิ์ "ใครล็อกอินแล้วเห็นหมด"
-- ถ้าเปิดให้สมัครเอง คนนอกที่เจอ URL ก็เห็นข้อมูลทันที
-- จึงเพิ่มตาราง app_users — สมัครได้ แต่ต้องอนุมัติก่อนถึงเห็นข้อมูล
-- ============================================================================

create table if not exists app_users (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  username     text unique not null,
  display_name text,
  role         text not null default 'staff' check (role in ('staff','admin')),
  is_active    boolean not null default false,   -- ต้องอนุมัติก่อน
  created_at   timestamptz default now()
);

comment on table app_users is
  'ผู้ใช้ที่อนุมัติแล้ว — สมัครใหม่จะได้ is_active = false ต้องให้ admin เปิดให้';


-- สร้างแถวอัตโนมัติเมื่อมีคนสมัคร ดึงชื่อผู้ใช้จากส่วนหน้า @ ของอีเมล
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into app_users (user_id, username, display_name)
  values (new.id, split_part(new.email, '@', 1), split_part(new.email, '@', 1))
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();


-- ตัวตรวจสิทธิ์ — security definer เพื่อให้ policy เรียกได้โดยไม่วนซ้ำ
create or replace function is_member()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from app_users
    where user_id = auth.uid() and is_active
  );
$$;

create or replace function is_admin()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from app_users
    where user_id = auth.uid() and is_active and role = 'admin'
  );
$$;

grant execute on function is_member() to authenticated;
grant execute on function is_admin()  to authenticated;


-- ============================================================================
-- เปลี่ยน RLS: จากเดิม "ล็อกอินแล้วเห็นหมด" เป็น "ต้องอยู่ในรายชื่อที่อนุมัติ"
-- ============================================================================

do $$
declare
  t text;
  tables text[] := array[
    'stations','items','import_batches','stock_snapshots',
    'in_transit','depot_stock','delivery_trips','delivery_plan',
    'calc_runs','calc_lines'
  ];
begin
  foreach t in array tables loop
    execute format('drop policy if exists "read_authenticated" on %I', t);
    execute format('drop policy if exists "write_authenticated" on %I', t);
    execute format(
      'create policy "member_all" on %I for all to authenticated
         using (is_member()) with check (is_member())', t);
  end loop;

  -- settings: ทุกคนอ่านได้ (สูตรต้องใช้) แต่แก้ได้เฉพาะ admin
  execute 'drop policy if exists "read_authenticated"  on settings';
  execute 'drop policy if exists "write_authenticated" on settings';
end $$;

create policy "settings_read"  on settings for select to authenticated using (is_member());
create policy "settings_write" on settings for update to authenticated using (is_admin()) with check (is_admin());


-- app_users: เห็นเฉพาะแถวตัวเอง / admin จัดการได้ทุกแถว
alter table app_users enable row level security;

create policy "own_row"    on app_users for select to authenticated using (user_id = auth.uid());
create policy "admin_read" on app_users for select to authenticated using (is_admin());
create policy "admin_all"  on app_users for all    to authenticated using (is_admin()) with check (is_admin());


-- ============================================================================
-- เปิดใช้งานผู้ใช้คนแรกให้เป็น admin
-- ============================================================================
--
-- 1. สมัครผ่านหน้าเว็บ หรือสร้างที่ Authentication > Users
--    (ถ้าสร้างในหน้า Supabase ให้ใส่อีเมลเป็น ชื่อผู้ใช้@mgk.local และติ๊ก Auto Confirm)
-- 2. กลับมารันคำสั่งนี้ แทน 'somchai' ด้วยชื่อผู้ใช้จริง
--
--    update app_users set is_active = true, role = 'admin'
--    where username = 'somchai';
--
-- จากนั้นอนุมัติคนอื่นได้จากหน้า "ผู้ใช้" ในเว็บ ไม่ต้องกลับมาที่นี่อีก
-- ============================================================================
