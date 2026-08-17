-- ============================================================================
-- Maxnitron Fulfillment System — Supabase (PostgreSQL) Schema
-- ขอบเขต: คลังแม่กลอง | เฟส 1 = คำนวณเติมสินค้า + ผูกกับเที่ยวรถจริง
-- ============================================================================

create extension if not exists "pgcrypto";


-- ============================================================================
-- 1. MASTER DATA  (เปลี่ยนไม่บ่อย — อัปเดตเมื่อมีสาขา/สินค้าใหม่)
-- ============================================================================

create table stations (
  plant_code    text primary key,                    -- F019, SC10, S196
  combine_code  text,                                -- 72L, 68F
  branch_name   text not null,
  depot         text not null default 'แม่กลอง',
  class_fix     text check (class_fix in ('Class A','Class B','Class C')),
  class_dyna    text,
  shop_status   text default 'OPEN',
  is_active     boolean default true,
  created_at    timestamptz default now()
);

create table items (
  mat_code        text primary key,                  -- 100000133
  desc_th         text,
  desc_en         text,
  litre_per_piece numeric not null check (litre_per_piece > 0),
  pack_size       numeric,                           -- ชิ้นต่อลัง
  uom             text,                              -- BT, GAL
  transfer_uom    text,                              -- หน่วยโอน
  class_by_depot  text,
  is_active       boolean default true
);

-- พารามิเตอร์ปรับได้จากหน้าเว็บ (แทนชีต setting เดิม)
create table settings (
  key        text primary key,
  value      numeric not null,
  unit       text,
  note       text,
  updated_at timestamptz default now(),
  updated_by uuid
);

insert into settings (key, value, unit, note) values
  ('rop_min',        4, 'วัน',  'CoverDay ขั้นต่ำ กรณีไม่มีข้อมูลรอบส่ง (ค่าเดิมในชีต = 4)'),
  ('lead_time',      3, 'วัน',  'เวลานำ: สั่งถึงของถึงสาขา'),
  ('doh_ceiling',   25, 'วัน',  'เพดาน DOH ตาม KPI — ห้ามเติมจนเกินค่านี้'),
  ('cycle_buffer', 1.15, 'เท่า', 'ตัวคูณกันรอบส่งคลาด: CoverDay = รอบส่งจริง x ค่านี้'),
  ('ss_class_a',     2, 'ชิ้น', 'Safety stock Class A (เดิม 1 — แนะนำเพิ่มเป็น 2)'),
  ('ss_class_b',     1, 'ชิ้น', 'Safety stock Class B (เดิม 0 — คลาสนี้ availability แย่สุด 73%)'),
  ('ss_class_c',     0, 'ชิ้น', 'Safety stock Class C (คงไว้ 0 — DOH สูงมากอยู่แล้ว)'),
  ('min_order_qty',  0, 'ชิ้น', 'จำนวนสั่งขั้นต่ำต่อบรรทัด');


-- ============================================================================
-- 2. การนำเข้าไฟล์  (ทุกไฟล์ผ่าน batch เดียวกัน ย้อนรอยได้ว่าใครอัปเมื่อไหร่)
-- ============================================================================

create type import_source as enum ('power_bi', 'me2n', 'wms', 'trips');
create type import_status as enum ('pending', 'validated', 'committed', 'failed');

create table import_batches (
  batch_id      uuid primary key default gen_random_uuid(),
  source        import_source not null,
  filename      text not null,
  snapshot_date date not null,                       -- ข้อมูล ณ วันไหน (ไม่ใช่วันอัป)
  row_count     integer,
  status        import_status default 'pending',
  error_log     jsonb,
  uploaded_by   uuid references auth.users(id),
  uploaded_at   timestamptz default now()
);

create index on import_batches (source, snapshot_date desc);


-- ============================================================================
-- 3. ข้อมูลรายวัน  (append-only — เก็บประวัติ ไม่ทับของเก่า)
-- ============================================================================

-- จากไฟล์ POWER_BI / STATION_DOH_BY_BRANCH
create table stock_snapshots (
  id            bigserial primary key,
  batch_id      uuid references import_batches(batch_id) on delete cascade,
  snapshot_date date not null,
  plant_code    text not null references stations(plant_code),
  mat_code      text not null references items(mat_code),
  stock_l       numeric default 0,
  stock_pcs     integer default 0,
  sales_7_l     numeric default 0,
  sales_30_l    numeric default 0,
  sales_90_l    numeric default 0,
  sales_7_pcs   numeric default 0,
  sales_30_pcs  numeric default 0,
  sales_90_pcs  numeric default 0,
  unique (snapshot_date, plant_code, mat_code)
);

create index on stock_snapshots (snapshot_date desc, plant_code);

-- จากไฟล์ ME2N — ของที่สั่งแล้วยังไม่ถึงสาขา
create table in_transit (
  id            bigserial primary key,
  batch_id      uuid references import_batches(batch_id) on delete cascade,
  snapshot_date date not null,
  plant_code    text not null references stations(plant_code),
  mat_code      text not null references items(mat_code),
  po_no         text,
  po_date       date,
  qty_pcs       numeric default 0,
  unique (snapshot_date, plant_code, mat_code, po_no)
);

create index on in_transit (snapshot_date desc, plant_code, mat_code);

-- จากไฟล์ WMS — สต็อกคงเหลือที่คลัง (กันสั่งเกินของที่มี)
create table depot_stock (
  id            bigserial primary key,
  batch_id      uuid references import_batches(batch_id) on delete cascade,
  snapshot_date date not null,
  mat_code      text not null references items(mat_code),
  qty_pcs       numeric default 0,
  unique (snapshot_date, mat_code)
);

-- จากไฟล์เที่ยวรถ — ประวัติการส่งจริง (ใช้คำนวณรอบส่งอัตโนมัติ)
create table delivery_trips (
  id            bigserial primary key,
  batch_id      uuid references import_batches(batch_id) on delete cascade,
  trip_date     date not null,
  plant_code    text not null references stations(plant_code),
  trip_no       integer,
  pickup_point  text,                                -- ไออาร์, ศรีราชา, แม่กลอง
  group_type    text,                                -- ทั่วไป
  unique (trip_date, plant_code, trip_no)
);

create index on delivery_trips (plant_code, trip_date desc);

-- แผนเที่ยวรถรอบถัดไป — เฟส 1 คำนวณเฉพาะสาขาที่มีรถเข้าจริง
create table delivery_plan (
  id           bigserial primary key,
  trip_date    date not null,
  plant_code   text not null references stations(plant_code),
  trip_no      integer,
  pickup_point text,
  note         text,
  created_at   timestamptz default now(),
  unique (trip_date, plant_code)
);

create index on delivery_plan (trip_date);


-- ============================================================================
-- 4. รอบส่งจริงรายสาขา  (คำนวณสด — ไม่ต้องทำชีต Dataรอบการจัดส่ง เองอีก)
-- ============================================================================

create or replace view v_station_cycle as
with gaps as (
  select
    plant_code,
    trip_date,
    trip_date - lag(trip_date) over (partition by plant_code order by trip_date) as gap_days
  from (select distinct plant_code, trip_date from delivery_trips) d
  where trip_date >= current_date - interval '120 days'
)
select
  plant_code,
  count(*) filter (where gap_days is not null)        as n_intervals,
  round(avg(gap_days) filter (where gap_days > 0), 2) as avg_days,
  max(trip_date)                                      as last_trip
from gaps
group by plant_code;

comment on view v_station_cycle is
  'รอบส่งเฉลี่ยรายสาขา จากประวัติ 120 วันล่าสุด — ป้อนเข้าสูตร CoverDay';


-- ============================================================================
-- 5. รอบการคำนวณ
-- ============================================================================

create table calc_runs (
  run_id        uuid primary key default gen_random_uuid(),
  run_date      date not null default current_date,
  trip_date     date not null,                       -- คำนวณเพื่อรถเที่ยววันไหน
  snapshot_date date not null,                       -- ใช้ข้อมูลของวันไหน
  params        jsonb not null,                      -- snapshot ของ settings ตอนนั้น
  line_count    integer,
  created_by    uuid references auth.users(id),
  created_at    timestamptz default now(),
  exported_at   timestamptz
);

create table calc_lines (
  id             bigserial primary key,
  run_id         uuid references calc_runs(run_id) on delete cascade,
  plant_code     text not null,
  mat_code       text not null,

  -- ตัวตั้งที่ใช้คำนวณ (เก็บไว้เพื่อตรวจสอบย้อนหลัง)
  sales_per_day  numeric,
  cover_day      numeric,
  lead_time      numeric,
  safety_stock   numeric,
  target_pcs     numeric,
  on_hand_pcs    numeric,
  in_transit_pcs numeric,

  -- ผลลัพธ์
  suggested_pcs  integer,                            -- ระบบคำนวณ
  manual_add     integer default 0,                  -- เจ้าหน้าที่ปรับเพิ่ม/ลด
  final_pcs      integer generated always as (greatest(suggested_pcs + manual_add, 0)) stored,
  uom            text,
  doh_before     numeric,
  doh_after      numeric,
  action         text,                               -- เติมสินค้า / ไม่เติมสินค้า
  priority       smallint,                           -- 1=ขาดจริง 2=เสี่ยงขาด 3=ไม่พอถึงรอบหน้า 4=ปกติ
  flag           text,                               -- StockOut / DOH<7 / เกินเพดาน / คลังไม่พอ

  unique (run_id, plant_code, mat_code)
);

create index on calc_lines (run_id, action);
create index on calc_lines (run_id, priority);


-- ============================================================================
-- 6. เครื่องคำนวณ
-- ============================================================================
--
-- สูตรเดิมในชีต:  target = ยอดขาย/วัน x (ROP 4 + LeadTime 3) + SafetyStock
--   ผลจำลองกับข้อมูลจริง 2,620 แถว → availability 93.2%, DOH 55.0
--   ปัญหา: 43% ของสาขารถเข้าห่างเกิน 7 วัน ของหมดก่อนรถรอบหน้า
--
-- สูตรนี้:  cover_day = MAX(รอบส่งจริง x buffer, rop_min)
--   ผลจำลอง → availability 99.7%, DOH 65.2
--
-- หมายเหตุสำคัญเรื่องเพดาน DOH:
--   เคยทดลองใส่เพดาน floor(25 x ยอดขาย/วัน) แล้ว availability "ตก" เหลือ 90.6%
--   เพราะมี 386 แถว (15%) ที่ขายช้าจนวางแค่ 1 ชิ้นก็เกิน DOH 25 ทันที
--   (ขายเฉลี่ย 0.033 ชิ้น/วัน = 1 ชิ้นทุก 30 วัน)
--   → เพดานจึงตั้งเป็น toggle ปิดไว้เป็นค่าเริ่มต้น (doh_cap_enabled = 0)
--   → DOH ต้องแก้ด้วยการดึงของออก ไม่ใช่การสั่งน้อยลง:
--     ถ้าหยุดสั่งทั้งเดือน DOH ยังอยู่ 53 วัน เพราะ 9,544 L เป็นของไม่ขายเลย
-- ============================================================================

insert into settings (key, value, unit, note) values
  ('doh_cap_enabled', 0, '0/1', 'เปิดเพดาน DOH ตอนคำนวณ — ปิดไว้ เพราะทำให้ SKU ขายช้าสั่งไม่ได้เลย')
on conflict (key) do nothing;


create or replace function calculate_replenishment(
  p_trip_date     date,
  p_snapshot_date date default null,
  p_created_by    uuid default null
) returns uuid
language plpgsql
as $$
declare
  v_run_id       uuid;
  v_snapshot     date;
  v_params       jsonb;
  v_lead_time    numeric;
  v_rop_min      numeric;
  v_doh_ceiling  numeric;
  v_cycle_buffer numeric;
  v_min_order    numeric;
  v_cap_on       boolean;
  v_has_depot    boolean;
  v_count        integer;
begin
  v_snapshot := coalesce(p_snapshot_date,
                         (select max(snapshot_date) from stock_snapshots));

  if v_snapshot is null then
    raise exception 'ยังไม่มีข้อมูลสต็อก — อัปโหลดไฟล์ POWER_BI ก่อน';
  end if;

  if not exists (select 1 from delivery_plan where trip_date = p_trip_date) then
    raise exception 'ยังไม่มีแผนเที่ยวรถของวันที่ % — อัปโหลดไฟล์เที่ยวรถก่อน', p_trip_date;
  end if;

  select jsonb_object_agg(key, value) into v_params from settings;

  v_lead_time    := (v_params->>'lead_time')::numeric;
  v_rop_min      := (v_params->>'rop_min')::numeric;
  v_doh_ceiling  := (v_params->>'doh_ceiling')::numeric;
  v_cycle_buffer := (v_params->>'cycle_buffer')::numeric;
  v_min_order    := (v_params->>'min_order_qty')::numeric;
  v_cap_on       := coalesce((v_params->>'doh_cap_enabled')::numeric, 0) = 1;

  -- แยก "คลังไม่มีของ" ออกจาก "ยังไม่ได้อัปไฟล์ WMS"
  -- ถ้ายังไม่มีข้อมูลคลัง จะไม่เอาสต็อกคลังมาจำกัดยอดสั่ง
  v_has_depot := exists (select 1 from depot_stock where snapshot_date = v_snapshot);

  insert into calc_runs (trip_date, snapshot_date, params, created_by)
  values (p_trip_date, v_snapshot, v_params, p_created_by)
  returning run_id into v_run_id;

  insert into calc_lines (
    run_id, plant_code, mat_code,
    sales_per_day, cover_day, lead_time, safety_stock,
    target_pcs, on_hand_pcs, in_transit_pcs,
    suggested_pcs, uom, doh_before, doh_after, action, priority, flag
  )
  with base as (
    select
      s.plant_code,
      s.mat_code,
      i.uom,
      i.litre_per_piece,
      s.stock_pcs::numeric               as on_hand,
      coalesce(t.qty, 0)                 as in_transit,
      case when i.litre_per_piece > 0
           then s.sales_30_l / i.litre_per_piece
           else 0 end                    as spd,
      case st.class_fix
        when 'Class A' then (v_params->>'ss_class_a')::numeric
        when 'Class B' then (v_params->>'ss_class_b')::numeric
        else                (v_params->>'ss_class_c')::numeric
      end                                as safety_stock,
      greatest(coalesce(c.avg_days, v_rop_min) * v_cycle_buffer, v_rop_min) as cover_day,
      -- NULL = ไม่รู้ยอดคลัง (ไม่จำกัด) / ตัวเลข = ยอดจริงจาก WMS
      case when v_has_depot then coalesce(d.qty_pcs, 0) else null end as depot_qty
    from stock_snapshots s
    join stations st on st.plant_code = s.plant_code and st.is_active
    join items    i  on i.mat_code    = s.mat_code   and i.is_active
    join delivery_plan dp
      on dp.plant_code = s.plant_code and dp.trip_date = p_trip_date
    left join v_station_cycle c on c.plant_code = s.plant_code
    left join lateral (
      select sum(qty_pcs) as qty from in_transit it
      where it.plant_code = s.plant_code
        and it.mat_code   = s.mat_code
        and it.snapshot_date = v_snapshot
    ) t on true
    left join lateral (
      select qty_pcs from depot_stock ds
      where ds.mat_code = s.mat_code and ds.snapshot_date = v_snapshot
    ) d on true
    where s.snapshot_date = v_snapshot
      and (s.sales_90_pcs > 0 or s.stock_pcs > 0)   -- ตัด SKU ที่สาขานี้ไม่ได้ขาย
  ),
  needed as (
    select *,
      spd * (cover_day + v_lead_time) + safety_stock as target_raw,
      case when spd > 0 then (on_hand + in_transit) / spd end as doh_before
    from base
  ),
  ranked as (
    select *,
      ceil(greatest(target_raw - (on_hand + in_transit), 0)) as need_raw,
      -- ลำดับความสำคัญ ใช้ตอนคลังของไม่พอ
      case
        when on_hand + in_transit <= 0 and spd > 0                    then 1  -- ขาดจริง
        when doh_before < v_lead_time                                 then 2  -- จะขาดก่อนรถถึง
        when doh_before < cover_day                                   then 3  -- ไม่พอถึงรอบหน้า
        else 4
      end as priority
    from needed
  ),
  capped as (
    select *,
      case
        when not v_cap_on then need_raw
        -- เพดาน DOH: แต่ยังต้องวางให้ถึง safety stock เสมอ ไม่งั้น SKU ขายช้าสั่งไม่ได้เลย
        else greatest(
               least(need_raw,
                     greatest(floor(v_doh_ceiling * spd) - (on_hand + in_transit),
                              greatest(safety_stock - (on_hand + in_transit), 0))),
               0)
      end as want
    from ranked
  ),
  allocated as (
    select *,
      -- จัดสรรตามของที่คลังมีจริง เรียงตามลำดับความสำคัญ
      case
        when depot_qty is null then want
        else greatest(
               least(want,
                     depot_qty - coalesce(
                       sum(want) over (partition by mat_code
                                       order by priority, spd desc, plant_code
                                       rows between unbounded preceding and 1 preceding), 0)),
               0)
      end as qty
    from capped
  )
  select
    v_run_id, plant_code, mat_code,
    round(spd, 4), round(cover_day, 2), v_lead_time, safety_stock,
    round(target_raw, 2), on_hand, in_transit,
    qty::integer, uom,
    round(doh_before, 1),
    case when spd > 0 then round((on_hand + in_transit + qty) / spd, 1) end,
    case when qty > 0 then 'เติมสินค้า' else 'ไม่เติมสินค้า' end,
    priority,
    case
      when qty < need_raw and depot_qty is not null then 'คลังไม่พอ'
      when qty < need_raw and v_cap_on              then 'ชนเพดาน DOH'
      when priority = 1                             then 'StockOut'
      when priority = 2                             then 'เสี่ยงขาดก่อนรถถึง'
    end
  from allocated
  where need_raw >= v_min_order;

  get diagnostics v_count = row_count;
  update calc_runs set line_count = v_count where run_id = v_run_id;

  return v_run_id;
end;
$$;


-- ============================================================================
-- 7. VIEW สำหรับหน้าเว็บ
-- ============================================================================

-- รายการสั่งพร้อม export เป็นเทมเพลต
create or replace view v_order_template as
select
  r.run_id,
  r.trip_date,
  l.plant_code,
  st.branch_name,
  l.mat_code,
  i.desc_en          as item_desc,
  l.final_pcs        as qty,
  coalesce(i.transfer_uom, l.uom) as uom,
  l.priority,
  l.flag
from calc_lines l
join calc_runs r on r.run_id = l.run_id
join stations  st on st.plant_code = l.plant_code
join items     i  on i.mat_code    = l.mat_code
where l.final_pcs > 0
order by l.priority, st.branch_name, i.desc_en;

-- KPI รายวัน — ตัวที่ Google Sheet ทำไม่ได้ เพราะไม่มีประวัติ
create or replace view v_kpi_daily as
select
  s.snapshot_date,
  st.class_fix,
  count(*)                                                          as active_lines,
  count(*) filter (where s.stock_pcs > 0)                           as in_stock_lines,
  round(100.0 * count(*) filter (where s.stock_pcs > 0) / nullif(count(*),0), 2) as availability_pct,
  round(sum(s.stock_l) / nullif(sum(s.sales_30_l), 0), 1)           as doh_liter,
  round(sum(s.stock_pcs) / nullif(sum(s.sales_30_pcs), 0), 1)       as doh_pcs
from stock_snapshots s
join stations st on st.plant_code = s.plant_code
where s.sales_90_pcs > 0 or s.stock_pcs > 0
group by s.snapshot_date, st.class_fix;


-- ============================================================================
-- 8. ROW LEVEL SECURITY
-- ============================================================================

alter table stations        enable row level security;
alter table items           enable row level security;
alter table settings        enable row level security;
alter table import_batches  enable row level security;
alter table stock_snapshots enable row level security;
alter table in_transit      enable row level security;
alter table depot_stock     enable row level security;
alter table delivery_trips  enable row level security;
alter table delivery_plan   enable row level security;
alter table calc_runs       enable row level security;
alter table calc_lines      enable row level security;

-- ผู้ใช้ที่ล็อกอินแล้วอ่านได้ทั้งหมด (คลังเดียว ไม่ต้องแบ่งสิทธิ์ตามคลัง)
do $$
declare t text;
begin
  foreach t in array array[
    'stations','items','settings','import_batches','stock_snapshots',
    'in_transit','depot_stock','delivery_trips','delivery_plan',
    'calc_runs','calc_lines'
  ] loop
    execute format(
      'create policy "read_authenticated" on %I for select to authenticated using (true)', t
    );
    execute format(
      'create policy "write_authenticated" on %I for all to authenticated using (true) with check (true)', t
    );
  end loop;
end $$;

-- หมายเหตุ: ถ้าต้องแยกสิทธิ์ admin/staff ภายหลัง เพิ่มตาราง user_roles
-- แล้วเปลี่ยน policy ของ settings เป็น admin เท่านั้น
