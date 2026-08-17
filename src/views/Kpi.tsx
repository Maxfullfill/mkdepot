import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

interface Kpi {
  snapshot_date: string; class_fix: string; active_lines: number
  in_stock_lines: number; availability_pct: number; doh_liter: number
}
interface Budget {
  stock_liters: number; sales_per_day: number; doh_now: number
  budget_days: number; budget_liters: number; room_liters: number
}

export default function KpiPage() {
  const [rows, setRows] = useState<Kpi[]>([])
  const [budget, setBudget] = useState<Budget | null>(null)
  const [ceiling, setCeiling] = useState(20)

  useEffect(() => { void load() }, [])

  async function load() {
    const [k, b, s] = await Promise.all([
      supabase.from('v_kpi_daily').select('*')
        .order('snapshot_date', { ascending: false }).limit(60),
      supabase.from('v_doh_budget').select('*').maybeSingle(),
      supabase.from('settings').select('value').eq('key', 'doh_ceiling').maybeSingle(),
    ])
    setRows((k.data ?? []) as Kpi[])
    setBudget((b.data as Budget) ?? null)
    if (s.data) setCeiling(Number(s.data.value))
  }

  const classA = rows.filter((r) => r.class_fix === 'Class A')
  const latest = classA[0]

  return (
    <>
      <h2>KPI</h2>
      <p className="lede">
        นับเฉพาะสินค้า Class A ตามคอลัมน์ Class-สาขา(3ด.Fix) จากทุกสาขาที่ดูแล
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
