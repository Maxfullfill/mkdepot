import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

interface Kpi {
  snapshot_date: string; class_fix: string; active_lines: number
  in_stock_lines: number; availability_pct: number; doh_liter: number
}
interface Boost {
  snapshot_date: string; mat_code: string; item_name: string
  stations_total: number; in_stock: number; short: number
  no_record: number; availability_pct: number
}
interface Budget {
  stock_liters: number; sales_per_day: number; doh_now: number
  budget_days: number; budget_liters: number; room_liters: number
}

export default function KpiPage() {
  const [rows, setRows] = useState<Kpi[]>([])
  const [budget, setBudget] = useState<Budget | null>(null)
  const [ceiling, setCeiling] = useState(20)
  const [boost, setBoost] = useState<Boost[]>([])

  useEffect(() => { void load() }, [])

  async function load() {
    const [k, b, s, bo] = await Promise.all([
      supabase.from('v_kpi_daily').select('*')
        .order('snapshot_date', { ascending: false }).limit(60),
      supabase.from('v_doh_budget').select('*').maybeSingle(),
      supabase.from('settings').select('value').eq('key', 'doh_ceiling').maybeSingle(),
      supabase.from('v_booster_kpi').select('*')
        .order('snapshot_date', { ascending: false }).order('mat_code'),
    ])
    setRows((k.data ?? []) as Kpi[])
    setBudget((b.data as Budget) ?? null)
    if (s.data) setCeiling(Number(s.data.value))
    const all = (bo.data ?? []) as Boost[]
    const day = all[0]?.snapshot_date
    setBoost(all.filter((x) => x.snapshot_date === day))
  }

  const classA = rows.filter((r) => r.class_fix === 'Class A')
  const latest = classA[0]

  return (
    <>
      <h2>KPI</h2>
      <p className="lede">
        Availability และ DOH นับเฉพาะ Class A ไม่รวมหัวเชื้อ ·
        หัวเชื้อมี KPI ของตัวเองแยกรายตัว ต้องมีวางครบทุกสาขา
      </p>

      {latest && (
        <dl className="stats">
          <div className="stat">
            <dt>Availability ล่าสุด</dt>
            <dd style={{ color: latest.availability_pct >= 97 ? 'var(--ok)' : 'var(--alarm)' }}>
              {latest.availability_pct?.toFixed(1)}<small>%</small>
            </dd>
          </div>
          <div className="stat">
            <dt>ของขาด</dt>
            <dd style={{ color: 'var(--alarm)' }}>
              {latest.active_lines - latest.in_stock_lines}
              <small> / {latest.active_lines.toLocaleString()}</small>
            </dd>
          </div>
          <div className="stat">
            <dt>DOH ล่าสุด</dt>
            <dd style={{ color: latest.doh_liter > ceiling ? 'var(--oil)' : 'var(--ok)' }}>
              {latest.doh_liter?.toFixed(1)}<small> วัน</small>
            </dd>
          </div>
          <div className="stat">
            <dt>เป้า</dt>
            <dd style={{ fontSize: 17, color: 'var(--ink-3)' }}>
              97<small>%</small> · {ceiling}<small> วัน</small>
            </dd>
          </div>
        </dl>
      )}

      {boost.length > 0 && (
        <div className="card">
          <h3>KPI หัวเชื้อ — ต้องมีวางครบทุกสาขา</h3>
          <p className="hint">
            นับทุกสาขา × หัวเชื้อทุกตัว · ไม่นับรวมใน Availability และ DOH
          </p>
          <table>
            <thead>
              <tr>
                <th>สินค้า</th><th className="num">มีของ</th>
                <th className="num">ขาด</th><th className="num">ไม่มีแถวในไฟล์</th>
                <th className="num">ครบ</th>
              </tr>
            </thead>
            <tbody>
              {boost.map((b) => (
                <tr key={b.mat_code}>
                  <td>{b.item_name}</td>
                  <td className="num">{b.in_stock} / {b.stations_total}</td>
                  <td className="num" style={{ color: b.short ? 'var(--alarm)' : undefined }}>
                    {b.short}
                  </td>
                  <td className="num" style={{ color: b.no_record ? 'var(--oil)' : 'var(--ink-3)' }}>
                    {b.no_record || '—'}
                  </td>
                  <td className="num" style={{
                    color: b.availability_pct >= 100 ? 'var(--ok)' : 'var(--alarm)',
                    fontWeight: 600,
                  }}>
                    {b.availability_pct?.toFixed(1)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {boost.some((b) => b.no_record > 0) && (
            <div className="note" style={{ marginTop: 12 }}>
              คอลัมน์ "ไม่มีแถวในไฟล์" คือสาขาที่ไม่เคยมีสินค้าตัวนั้นเลย
              ต่างจากสาขาที่มีแถวแต่สต็อกเป็นศูนย์ — ระบบจะสร้างรายการเติมให้ทั้งสองแบบ
            </div>
          )}
        </div>
      )}

      {budget && (
        <div className="card">
          <h3>งบ DOH — ที่ว่างสำหรับเติมของ</h3>
          <p className="hint">
            งบ = เพดาน {budget.budget_days} วัน × ยอดขายรวมต่อวัน − สต็อกที่มีอยู่
            {' · '}ติดลบแปลว่าของเกินเพดานอยู่แล้ว ต้องดึงออกก่อน
          </p>
          <table>
            <tbody>
              <tr>
                <td style={{ width: 250 }}>สต็อก Class A ตอนนี้</td>
                <td className="num" style={{ width: 100 }}>{budget.stock_liters?.toLocaleString()}</td>
                <td style={{ color: 'var(--ink-3)', fontSize: 12.5 }}>ลิตร · {budget.doh_now} วัน</td>
              </tr>
              <tr>
                <td>งบที่เพดาน {budget.budget_days} วัน</td>
                <td className="num">{budget.budget_liters?.toLocaleString()}</td>
                <td style={{ color: 'var(--ink-3)', fontSize: 12.5 }}>ลิตร</td>
              </tr>
              <tr>
                <td><strong>ที่ว่างคงเหลือ</strong></td>
                <td className="num">
                  <strong style={{ color: budget.room_liters >= 0 ? 'var(--ok)' : 'var(--alarm)' }}>
                    {budget.room_liters?.toLocaleString()}
                  </strong>
                </td>
                <td style={{ color: 'var(--ink-3)', fontSize: 12.5 }}>ลิตร</td>
              </tr>
            </tbody>
          </table>
          {budget.room_liters < 0 && (
            <div className="note bad" style={{ marginTop: 12 }}>
              ต้องดึงออก {Math.abs(budget.room_liters).toLocaleString()} ลิตร จึงจะแตะเพดาน {budget.budget_days} วัน
              — ทำได้ด้วยการโอนเกลี่ยหรือส่งคืน ไม่ใช่การหยุดสั่ง
            </div>
          )}
        </div>
      )}

      <div className="card" style={{ padding: 0 }}>
        <div style={{ padding: '20px 20px 12px' }}>
          <h3>ย้อนหลัง</h3>
          <p className="hint" style={{ margin: 0 }}>
            Class A แสดงเต็ม คลาสอื่นจางลง — เก็บทุกครั้งที่นำเข้าไฟล์ POWER_BI
          </p>
        </div>
        {rows.length === 0 ? (
          <div style={{ padding: '0 20px 20px' }}>
            <div className="note">ยังไม่มีข้อมูล — นำเข้าไฟล์ POWER_BI ก่อน</div>
          </div>
        ) : (
          <div className="tw" style={{ maxHeight: '52vh', border: 0, borderTop: '1px solid var(--line)' }}>
            <table>
              <thead>
                <tr>
                  <th>วันที่</th><th>Class</th>
                  <th className="num">บรรทัด</th><th className="num">ขาด</th>
                  <th className="num">Availability</th><th className="num">DOH</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((k, i) => {
                  const a = k.class_fix === 'Class A'
                  return (
                    <tr key={i} style={{ opacity: a ? 1 : 0.45 }}>
                      <td style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{k.snapshot_date}</td>
                      <td>{k.class_fix}</td>
                      <td className="num">{k.active_lines}</td>
                      <td className="num">{k.active_lines - k.in_stock_lines}</td>
                      <td className="num" style={{
                        color: !a ? undefined : k.availability_pct >= 97 ? 'var(--ok)' : 'var(--alarm)',
                      }}>
                        {k.availability_pct?.toFixed(1)}%
                      </td>
                      <td className="num" style={{ color: !a ? undefined : k.doh_liter > ceiling ? 'var(--oil)' : 'var(--ok)' }}>
                        {k.doh_liter?.toFixed(1)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  )
}
