import { useEffect, useMemo, useState } from 'react'
import * as XLSX from 'xlsx'
import { supabase } from '../lib/supabase'
import { StepNum, Fold } from './ui'

interface Plan {
  mat_code: string; item_name: string; uom: string | null
  pack_size: number; units_per_case: number; days: number
  issued: number; issue_days: number
  per_day: number; prev_per_day: number; trend_pct: number | null
  depot_stock: number; depot_doh: number | null
  target_stock: number; suggest_qty: number
  suggest_cases: number; order_pcs: number
  status: string
}
interface Idle { mat_code: string; item_name: string; uom: string | null; depot_stock: number }
interface Daily { trip_date: string; mat_code: string; item_name: string; stations: number; qty: number }

const STATUS: Record<string, string> = {
  'คลังหมด': 'alarm', 'ต้องสั่งด่วน': 'alarm', 'ควรสั่ง': 'oil', 'พอ': 'ok',
}

export default function Depot() {
  const [rows, setRows] = useState<Plan[]>([])
  const [idle, setIdle] = useState<Idle[]>([])
  const [daily, setDaily] = useState<Daily[]>([])
  const [days, setDays] = useState(7)
  const [cover, setCover] = useState(14)
  const [lead, setLead] = useState(7)
  const [onlyNeed, setOnlyNeed] = useState(true)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  useEffect(() => { void init() }, [])

  async function init() {
    const { data: s } = await supabase.from('settings').select('key, value')
      .in('key', ['depot_lookback_days', 'depot_cover_days', 'depot_lead_days'])
    const m = Object.fromEntries((s ?? []).map((x) => [x.key, Number(x.value)]))
    if (m.depot_lookback_days) setDays(m.depot_lookback_days)
    if (m.depot_cover_days) setCover(m.depot_cover_days)
    if (m.depot_lead_days) setLead(m.depot_lead_days)
    await load(m.depot_lookback_days ?? 7)
  }

  async function load(d = days) {
    setBusy(true)
    const [p, i, dl] = await Promise.all([
      supabase.rpc('depot_plan', { p_days: d }),
      supabase.from('v_depot_idle').select('*').order('depot_stock', { ascending: false }),
      supabase.from('v_depot_issue_daily').select('*')
        .order('trip_date', { ascending: false }).limit(400),
    ])
    setRows(Array.isArray(p.data) ? (p.data as Plan[]) : [])
    setIdle((i.data ?? []) as Idle[])
    setDaily((dl.data ?? []) as Daily[])
    setBusy(false)
  }

  async function saveSetting(key: string, value: number | null, set: (v: number) => void) {
    if (value === null) return
    set(value)
    await supabase.from('settings').update({ value }).eq('key', key)
    await load(key === 'depot_lookback_days' ? value : days)
    setMsg('บันทึกแล้ว'); setTimeout(() => setMsg(''), 1800)
  }

  const shown = useMemo(
    () => onlyNeed ? rows.filter((r) => r.status !== 'พอ') : rows,
    [rows, onlyNeed]
  )

  const totals = useMemo(() => ({
    issued: rows.reduce((s, r) => s + r.issued, 0),
    order: rows.reduce((s, r) => s + r.order_pcs, 0),
    cases: rows.reduce((s, r) => s + r.suggest_cases, 0),
    urgent: rows.filter((r) => r.status === 'คลังหมด' || r.status === 'ต้องสั่งด่วน').length,
    skus: rows.length,
  }), [rows])

  /** ยอดรายวันแบบตาราง SKU x วัน ใช้ดูว่าเปิดสม่ำเสมอไหม */
  const grid = useMemo(() => {
    const dates = [...new Set(daily.map((d) => d.trip_date))].sort().slice(-14)
    const byMat = new Map<string, { name: string; cells: Record<string, number>; total: number }>()
    daily.forEach((d) => {
      if (!dates.includes(d.trip_date)) return
      if (!byMat.has(d.mat_code))
        byMat.set(d.mat_code, { name: d.item_name, cells: {}, total: 0 })
      const e = byMat.get(d.mat_code)!
      e.cells[d.trip_date] = (e.cells[d.trip_date] ?? 0) + d.qty
      e.total += d.qty
    })
    return { dates, rows: [...byMat.entries()].sort((a, b) => b[1].total - a[1].total) }
  }, [daily])

  function exportPlan() {
    if (!rows.length) return
    const ws = XLSX.utils.json_to_sheet(rows.map((r) => ({
      'รหัสสินค้า': r.mat_code,
      'สินค้า': r.item_name,
      'หน่วย': r.uom,
      [`เปิดไป ${days} วัน`]: r.issued,
      'เฉลี่ย/วัน': r.per_day,
      'ช่วงก่อน/วัน': r.prev_per_day,
      'แนวโน้ม %': r.trend_pct,
      'คลังมี': r.depot_stock,
      'คลัง DOH': r.depot_doh,
      'ควรมี': r.target_stock,
      'ขาดอยู่ (ชิ้น)': r.suggest_qty,
      'ต่อลัง': r.pack_size,
      'ควรสั่ง (ลัง)': r.suggest_cases,
      'ได้จริง (ชิ้น)': r.order_pcs,
      'สถานะ': r.status,
    })))
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'สั่งเข้าคลัง')
    XLSX.writeFile(wb, `สั่งเข้าคลัง_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.xlsx`)
  }

  return (
    <>
      <h2>สั่งของเข้าคลัง</h2>
      <p className="lede">
        รวมยอดที่เปิดให้สถานีย้อนหลัง เทียบกับของที่คลังมี เพื่อตัดสินใจว่าต้องสั่งเข้าเท่าไหร่ ·
        นับเฉพาะรอบที่ดาวน์โหลดเทมเพลตไปแล้วจริง
      </p>

      <div className="card">
        <div className="row" style={{ gap: 20 }}>
          <span style={{ display: 'flex', gap: 9, alignItems: 'center' }}>
            <label style={{ fontSize: 13.5 }}>ย้อนหลัง</label>
            <StepNum value={days} step={1} min={1} max={90}
              onChange={(v) => saveSetting('depot_lookback_days', v, setDays)} />
            <span style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>วัน</span>
          </span>
          <span style={{ display: 'flex', gap: 9, alignItems: 'center' }}>
            <label style={{ fontSize: 13.5 }}>คลังควรมีพอจ่าย</label>
            <StepNum value={cover} step={1} min={1}
              onChange={(v) => saveSetting('depot_cover_days', v, setCover)} />
            <span style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>วัน</span>
          </span>
          <span style={{ display: 'flex', gap: 9, alignItems: 'center' }}>
            <label style={{ fontSize: 13.5 }}>สั่งถึงของถึง</label>
            <StepNum value={lead} step={1} min={0}
              onChange={(v) => saveSetting('depot_lead_days', v, setLead)} />
            <span style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>วัน</span>
          </span>
        </div>
        <p className="hint" style={{ margin: '12px 0 0' }}>
          ควรมี = เฉลี่ยต่อวัน × ({cover} + {lead}) = พอจ่าย {cover + lead} วัน ·
          จำนวนลังปัดขึ้นจากยอดที่ขาด ใช้ PACK SIZE จาก Master Item เป็นตัวหาร
        </p>
      </div>

      {rows.length > 0 && (
        <dl className="stats">
          <div className="stat">
            <dt>เปิดไปใน {days} วัน</dt>
            <dd>{totals.issued.toLocaleString()} <small>ชิ้น</small></dd>
          </div>
          <div className="stat"><dt>SKU ที่เคลื่อนไหว</dt><dd>{totals.skus}</dd></div>
          <div className="stat">
            <dt>ต้องสั่งด่วน</dt>
            <dd style={{ color: totals.urgent ? 'var(--alarm)' : 'var(--ok)' }}>{totals.urgent}</dd>
          </div>
          <div className="stat">
            <dt>รวมที่ควรสั่ง</dt>
            <dd>{totals.cases.toLocaleString()} <small>ลัง</small></dd>
          </div>
          <div className="stat">
            <dt>คิดเป็นชิ้น</dt>
            <dd>{totals.order.toLocaleString()} <small>ชิ้น</small></dd>
          </div>
        </dl>
      )}

      <div className="card" style={{ padding: 0 }}>
        <div className="row" style={{ padding: '16px 20px 12px' }}>
          <h3 style={{ margin: 0 }}>แผนสั่งเข้าคลัง</h3>
          <label style={{ display: 'flex', gap: 7, alignItems: 'center', cursor: 'pointer', fontSize: 13 }}>
            <input type="checkbox" checked={onlyNeed} onChange={(e) => setOnlyNeed(e.target.checked)} />
            เฉพาะที่ต้องสั่ง
          </label>
          <span style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>{shown.length} รายการ</span>
          <span style={{ flex: 1 }} />
          <button className="btn ghost" onClick={exportPlan} disabled={!rows.length}>
            ดาวน์โหลด Excel
          </button>
        </div>

        {busy ? (
          <div style={{ padding: '0 20px 20px' }}><div className="note">กำลังคำนวณ…</div></div>
        ) : rows.length === 0 ? (
          <div style={{ padding: '0 20px 20px' }}>
            <div className="note">
              ยังไม่มีประวัติการเปิด PO — ต้องกดคำนวณและดาวน์โหลดเทมเพลตอย่างน้อยหนึ่งรอบก่อน
            </div>
          </div>
        ) : (
          <div className="tw" style={{ maxHeight: '60vh', border: 0, borderTop: '1px solid var(--line)' }}>
            <table>
              <thead>
                <tr>
                  <th>สินค้า</th>
                  <th className="num">เปิดไป</th>
                  <th className="num">/วัน</th>
                  <th className="num">แนวโน้ม</th>
                  <th className="num">คลังมี</th>
                  <th className="num">คลัง DOH</th>
                  <th className="num">ควรมี</th>
                  <th className="num">ขาด</th>
                  <th className="num">ต่อลัง</th>
                  <th className="num">สั่ง (ลัง)</th>
                  <th className="num">ได้ (ชิ้น)</th>
                  <th>สถานะ</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.mat_code}>
                    <td>
                      {r.item_name}
                    </td>
                    <td className="num">{r.issued}</td>
                    <td className="num">{Number(r.per_day).toFixed(1)}</td>
                    <td className="num" style={{
                      color: r.trend_pct === null ? 'var(--ink-3)'
                        : r.trend_pct > 20 ? 'var(--alarm)'
                        : r.trend_pct < -20 ? 'var(--oil)' : 'var(--ink-3)',
                    }}>
                      {r.trend_pct === null ? '—'
                        : `${r.trend_pct > 0 ? '+' : ''}${r.trend_pct}%`}
                    </td>
                    <td className="num">{r.depot_stock}</td>
                    <td className="num" style={{
                      color: r.depot_doh !== null && r.depot_doh < lead ? 'var(--alarm)' : 'var(--ink-2)',
                    }}>
                      {r.depot_doh ?? '—'}
                    </td>
                    <td className="num" style={{ color: 'var(--ink-3)' }}>{r.target_stock}</td>
                    <td className="num" style={{ color: 'var(--ink-3)' }}>{r.suggest_qty || '—'}</td>
                    <td className="num" style={{ color: 'var(--ink-3)' }}>{r.pack_size}</td>
                    <td className="num">
                      <strong style={{ fontSize: 15 }}>{r.suggest_cases || '—'}</strong>
                    </td>
                    <td className="num" style={{ color: 'var(--ink-2)' }}>{r.order_pcs || '—'}</td>
                    <td><span className={`tag ${STATUS[r.status] ?? ''}`}>{r.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Fold title="ยอดที่เปิดรายวัน" note={`${grid.dates.length} วันล่าสุด`}
        hint="ดูว่าแต่ละ SKU เปิดสม่ำเสมอหรือกระจุกบางวัน — ตัวที่กระจุกควรเผื่อสต็อกมากกว่า">
        {grid.rows.length === 0 ? (
          <div className="note">ยังไม่มีข้อมูล</div>
        ) : (
          <div className="tw" style={{ maxHeight: '46vh' }}>
            <table>
              <thead>
                <tr>
                  <th>สินค้า</th>
                  {grid.dates.map((d) => (
                    <th key={d} className="num" style={{ fontSize: 10.5 }}>{d.slice(5)}</th>
                  ))}
                  <th className="num">รวม</th>
                </tr>
              </thead>
              <tbody>
                {grid.rows.map(([mat, r]) => (
                  <tr key={mat}>
                    <td style={{ fontSize: 12.5 }}>{r.name}</td>
                    {grid.dates.map((d) => (
                      <td key={d} className="num" style={{ color: r.cells[d] ? undefined : 'var(--ink-3)' }}>
                        {r.cells[d] ?? '·'}
                      </td>
                    ))}
                    <td className="num"><strong>{r.total}</strong></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Fold>

      <Fold title="ของนอนคลัง" note={`${idle.length} SKU`}
        hint="มีของในคลังแต่ไม่ได้เปิดออกเลยในช่วงที่ผ่านมา — ไม่ต้องสั่งเพิ่ม">
        {idle.length === 0 ? (
          <div className="note good">ไม่มี ทุก SKU ในคลังมีการเคลื่อนไหว</div>
        ) : (
          <div className="tw" style={{ maxHeight: '40vh' }}>
            <table>
              <thead><tr><th>รหัส</th><th>สินค้า</th><th className="num">คลังมี</th></tr></thead>
              <tbody>
                {idle.map((r) => (
                  <tr key={r.mat_code}>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{r.mat_code}</td>
                    <td>{r.item_name ?? <span style={{ color: 'var(--ink-3)' }}>ไม่มีใน Master Item</span>}</td>
                    <td className="num">{r.depot_stock}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Fold>

      {msg && <div className="note good" style={{ position: 'sticky', bottom: 16 }}>{msg}</div>}
    </>
  )
}
