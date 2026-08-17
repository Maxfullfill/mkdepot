-- ============================================================================
-- migration_04 — เพิ่ม foreign key ให้ calc_lines
-- แก้: Could not find a relationship between 'calc_lines' and 'stations'
-- ============================================================================
--
-- PostgREST ดึงข้อมูลข้ามตารางได้ก็ต่อเมื่อมี foreign key ประกาศไว้จริง
-- schema.sql เดิมประกาศ plant_code / mat_code เป็น text เฉย ๆ
-- ============================================================================

-- ล้างแถวกำพร้าก่อน (ถ้ามี) ไม่งั้นเพิ่ม FK ไม่ผ่าน
delete from calc_lines l
where not exists (select 1 from stations s where s.plant_code = l.plant_code)
   or not exists (select 1 from items    i where i.mat_code   = l.mat_code);

alter table calc_lines
  drop constraint if exists calc_lines_plant_code_fkey,
  add  constraint calc_lines_plant_code_fkey
       foreign key (plant_code) references stations(plant_code) on delete cascade;

alter table calc_lines
  drop constraint if exists calc_lines_mat_code_fkey,
  add  constraint calc_lines_mat_code_fkey
       foreign key (mat_code) references items(mat_code) on delete cascade;

-- บอกให้ Supabase อ่านโครงสร้างใหม่ทันที ไม่ต้องรอ
notify pgrst, 'reload schema';
