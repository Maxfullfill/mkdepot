-- รันต่อจาก schema.sql ใน SQL Editor
-- เพิ่มชนิดไฟล์นำเข้าสำหรับ Master Item

alter type import_source add value if not exists 'master_items';

-- ให้ trips เก็บได้แม้ trip_no ซ้ำในวันเดียวกันคนละสาขา (ปรับ unique ให้ยืดหยุ่นขึ้น)
alter table delivery_trips drop constraint if exists delivery_trips_trip_date_plant_code_trip_no_key;
create unique index if not exists delivery_trips_uniq
  on delivery_trips (trip_date, plant_code, coalesce(trip_no, 0));
