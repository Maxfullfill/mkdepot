-- ============================================================================
-- migration_05 — คลาสสินค้าอยู่ระดับ สาขา×สินค้า + กรองเฉพาะคลาสที่ต้องการ
-- ============================================================================
--
-- แก้บั๊ก: schema เดิมเก็บ class_fix ไว้ที่ตาราง stations
-- แต่ในไฟล์จริง สาขาเดียวมีสินค้าหลายคลาสปนกัน เช่น F019
--   100000122 = Class A / 100000127 = Class B / 100000123 = Class C
-- การเก็บที่ระดับสาขาทำให้ safety stock จ่ายผิดตัวทั้งหมด
-- ============================================================================

alter table stock_snapshots
  add column if not exists class_fix   text,
  add column if not exists class_dyna  text,
  add column if not exists depot_class text;

create index if not exists stock_snapshots_class_idx
  on stock_snapshots (snapshot_date, class_fix);

comment on column stock_snapshots.class_fix is
  'คลาสของสินค้าตัวนี้ที่สาขานี้ (Class A/B/C) — ไม่ใช่คลาสของสาขา';


-- ตัวกรอง: 1 = เอามาคำนวณ, 0 = ข้าม
insert into settings (key, value, unit, note) values
  ('include_class_a', 1, '0/1', 'นำสินค้า Class A มาคำนวณ'),
  ('include_class_b', 0, '0/1', 'นำสินค้า Class B มาคำนวณ'),
  ('include_class_c', 0, '0/1', 'นำสินค้า Class C มาคำนวณ')
on conflict (key) do nothing;


-- ============================================================================
-- เครื่องคำนวณ: ใช้คลาสรายบรรทัด และกรองตามตัวเลือกข้างบน
-- ============================================================================

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
  v_has_depot    := exists (select 1 from depot_stock where snapshot_date = v_snapshot);

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
      s.stock_pcs::numeric               as on_hand,
      coalesce(t.qty, 0)                 as in_transit,
      case when i.litre_per_piece > 0
           then s.sales_30_l / i.litre_per_piece
           else 0 end                    as spd,
      -- safety stock ตามคลาสของ "สินค้าตัวนี้ที่สาขานี้" ไม่ใช่คลาสของสาขา
      case s.class_fix
        when 'Class A' then (v_params->>'ss_class_a')::numeric
        when 'Class B' then (v_params->>'ss_class_b')::numeric
        else                (v_params->>'ss_class_c')::numeric
      end                                as safety_stock,
      greatest(coalesce(c.avg_days, v_rop_min) * v_cycle_buffer, v_rop_min) as cover_day,
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
      and (s.sales_90_pcs > 0 or s.stock_pcs > 0)
      -- กรองคลาสตามที่ตั้งไว้ในหน้า KPI และค่าคำนวณ
      and coalesce(
            case s.class_fix
              when 'Class A' then (v_params->>'include_class_a')::numeric
              when 'Class B' then (v_params->>'include_class_b')::numeric
              when 'Class C' then (v_params->>'include_class_c')::numeric
              else 0
            end, 0) = 1
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
      case
        when on_hand + in_transit <= 0 and spd > 0 then 1
        when doh_before < v_lead_time              then 2
        when doh_before < cover_day                then 3
        else 4
      end as priority
    from needed
  ),
  capped as (
    select *,
      case
        when not v_cap_on then need_raw
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


-- KPI ก็ต้องใช้คลาสรายบรรทัดเช่นกัน
create or replace view v_kpi_daily as
select
  s.snapshot_date,
  coalesce(s.class_fix, 'ไม่ระบุ')                                  as class_fix,
  count(*)                                                          as active_lines,
  count(*) filter (where s.stock_pcs > 0)                           as in_stock_lines,
  round(100.0 * count(*) filter (where s.stock_pcs > 0) / nullif(count(*),0), 2) as availability_pct,
  round(sum(s.stock_l) / nullif(sum(s.sales_30_l), 0), 1)           as doh_liter,
  round(sum(s.stock_pcs) / nullif(sum(s.sales_30_pcs), 0), 1)       as doh_pcs
from stock_snapshots s
where s.sales_90_pcs > 0 or s.stock_pcs > 0
group by s.snapshot_date, s.class_fix;

notify pgrst, 'reload schema';

-- ============================================================================
-- หลังรันไฟล์นี้: ต้องอัปโหลดไฟล์ POWER_BI ใหม่อีกครั้ง
-- เพราะข้อมูลเดิมยังไม่มีคอลัมน์คลาส ระบบจะกรองออกหมดแล้วคำนวณได้ 0 บรรทัด
-- ============================================================================
