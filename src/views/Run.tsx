import { useEffect, useMemo, useState } from 'react'
import * as XLSX from 'xlsx'
import { supabase } from '../lib/supabase'

interface Line {
  id: number; plant_code: string; mat_code: string
  sales_per_day: number; cover_day: number; safety_stock: number
  on_hand_pcs: number; in_transit_pcs: number
  suggested_pcs: number; manual_add: number; final_pcs: number
  uom: string | null; doh_before: number | null; doh_after: number | null
  priority: number; flag: string | null
  branch_name?: string; item_desc?: string
}

const PRIORITY = {
  1: { label: 'ขาดจริง', cls: 'alarm' },
  2: { label: 'เสี่ยงขาด', cls: 'oil' },
  3: { label: 'ไม่พอถึงรอบหน้า', cls: '' },
  4: { label: 'ปกติ', cls: '' },
} as const

/** มาตรวัด DOH — ยาวตามจำนวนวันที่ของจะอยู่ได้ ขีดดำคือเส้น KPI 25 วัน */
function Gauge({ days }: { days: number | null }) {
  if (days === null || !Number.isFinite(days)) return <span style={{ color: 'var(--ink-3)' }}>—</span>
  const max = 50
  const pct = Math.min(days / max, 1) * 100
  const cls = days < 7 ? 'low' : days > 25 ? 'over' : 'good'
  return (
    <div className="gauge" title={`${days.toFixed(1)} วัน`}>
      <div className={`fill ${cls}`} style={{ width: `${pct}%` }} />
      <div className="kpi" style={{ left: `${(25 / max) * 100}%` }} />
      <div className="val">{days > max ? `${max}+` : days.toFixed(0)}</div>
    </div>
  )
}

export default function Run({ snapshotDate }: { snapshotDate: string }) {
  const [tripDate, setTripDate] = useState(snapshotDate)
  const [runId, setRunId] = useState<string | null>(null)
  const [lines, setLines] = useState<Line[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [only, setOnly] = useState<'order' | 'all'>('order')

  useEffect(() => setTripDate(snapshotDate), [snapshotDate])

  async function calculate() {
    setBusy(true); setErr(''); setLines([]); setRunId(null)
    try {
      const { data, error } = await supabase.rpc('calculate_replenishment', {
        p_trip_date: tripDate,
        p_snapshot_date: snapshotDate,
        p_created_by: (await supabase.auth.getUser()).data.user?.id ?? null,
      })
      if (error) throw new Error(error.message)
      setRunId(data as string)
      await load(data as string)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally { setBusy(false) }
  }

  async function load(id: string) {
    const { data, error } = await supabase
      .from('calc_lines')
      .select('*, stations(branch_name), items(desc_en)')
      .eq('run_id', id)
      .order('priority').order('plant_code')
    if (error) { setErr(error.message); return }
    setLines((data ?? []).map((r: Record<string, unknown>) => ({
      ...(r as unknown as Line),
      branch_name: (r.stations as { branch_name: string } | null)?.branch_name,
      item_desc: (r.items as { desc_en: string } | null)?.desc_en,
    })))
  }

  async function adjust(line: Line, value: number) {
    const add = value - line.suggested_pcs
    setLines((p) => p.map((l) => l.id === line.id
      ? { ...l, manual_add: add, final_pcs: Math.max(value, 0) } : l))
    await supabase.from('calc_lines').update({ manual_add: add }).eq('id', line.id)
  }

  const shown = useMemo(
    () => only === 'order' ? lines.filter((l) => l.final_pcs > 0) : lines,
    [lines, only]
  )

  const stats = useMemo(() => {
    const ordered = lines.filter((l) => l.final_pcs > 0)
    const after = lines.filter((l) => l.on_hand_pcs + l.in_transit_pcs + l.final_pcs > 0).length
    return {
      lines: lines.length,
      stations: new Set(ordered.map((l) => l.plant_code)).size,
      pieces: ordered.reduce((s, l) => s + l.final_pcs, 0),
      short: lines.filter((l) => l.priority === 1).length,
      avail: lines.length ? (100 * after) / lines.length : 0,
    }
  }, [lines])

  function exportTemplate() {
    const rows = lines.filter((l) => l.final_pcs > 0).map((l) => ({
      'Plant': l.plant_code,
      'สาขา': l.branch_name ?? '',
      '*ITEM': l.mat_code,
      'Item Descr': l.item_desc ?? '',
      'QTY(TransferUOM)': l.final_pcs,
      'UOM': l.uom ?? '',
      'SchedShipDate': tripDate,
      'หมายเหตุ': l.flag ?? '',
    }))
    const ws = XLSX.utils.json_to_sheet(rows)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'PO')
    XLSX.writeFile(wb, `PO_${tripDate.replace(/-/g, '')}.xlsx`)
    if (runId) supabase.from('calc_runs').update({ exported_at: new Date().toISOString() }).eq('run_id', runId)
  }

  return (
    <>
      <h2>คำนวณยอดเติม</h2>
      <p className="lede">
        คำนวณเฉพาะสาขาที่มีรถเข้าในวันที่เลือก ปรับยอดรายบรรทัดได้ก่อน export
      </p>

      <div className="card">
        <div className="row">
          <label style={{ fontSize: 13 }}>รถออกวันที่</label>
          <input type="date" value={tripDate} onChange={(e) => setTripDate(e.target.value)} />
          <span style={{ color: 'var(--ink-3)', fontSize: 12.5 }}>ใช้สต็อก ณ {snapshotDate}</span>
          <button className="btn" onClick={calculate} disabled={busy}>
            {busy ? 'กำลังคำนวณ…' : 'คำนวณ'}
          </button>
        </div>
        {err && <div className="note bad" style={{ marginTop: 12, whiteSpace: 'pre-line' }}>{err}</div>}
      </div>

      {lines.length > 0 && (
        <>
          <dl className="stats">
            <div className="stat"><dt>บรรทัดที่คำนวณ</dt><dd>{stats.lines}</dd></div>
            <div className="stat"><dt>สาขาที่ต้องส่ง</dt><dd>{stats.stations}</dd></div>
            <div className="stat"><dt>รวมที่ต้องเติม</dt><dd>{stats.pieces.toLocaleString()} <small>ชิ้น</small></dd></div>
            <div className="stat"><dt>ของขาดตอนนี้</dt><dd style={{ color: stats.short ? 'var(--alarm)' : undefined }}>{stats.short}</dd></div>
            <div className="stat"><dt>Availability หลังเติม</dt><dd style={{ color: stats.avail >= 97 ? 'var(--ok)' : 'var(--oil)' }}>{stats.avail.toFixed(1)}<small>%</small></dd></div>
          </dl>

          <div className="row" style={{ marginBottom: 10 }}>
            <button className={`btn ${only === 'order' ? '' : 'ghost'}`} onClick={() => setOnly('order')}>เฉพาะที่ต้องเติม</button>
            <button className={`btn ${only === 'all' ? '' : 'ghost'}`} onClick={() => setOnly('all')}>ทั้งหมด</button>
            <span style={{ flex: 1 }} />
            <button className="btn" onClick={exportTemplate} disabled={!stats.pieces}>ดาวน์โหลดเทมเพลต</button>
          </div>

          <div className="tw">
            <table>
              <thead>
                <tr>
                  <th>สาขา</th><th>สินค้า</th><th>สถานะ</th>
                  <th className="num">คงเหลือ</th><th className="num">ระหว่างทาง</th>
                  <th className="num">ขาย/วัน</th><th className="num">คุ้ม(วัน)</th>
                  <th>DOH ก่อน</th><th className="num">ระบบคำนวณ</th>
                  <th className="num">ยอดส่งจริง</th><th>DOH หลัง</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((l) => {
                  const p = PRIORITY[l.priority as 1 | 2 | 3 | 4] ?? PRIORITY[4]
                  return (
                    <tr key={l.id}>
                      <td>{l.branch_name ?? l.plant_code}</td>
                      <td>{l.item_desc ?? l.mat_code}</td>
                      <td><span className={`tag ${p.cls}`}>{l.flag ?? p.label}</span></td>
                      <td className="num">{l.on_hand_pcs}</td>
                      <td className="num">{l.in_transit_pcs || ''}</td>
                      <td className="num">{l.sales_per_day.toFixed(2)}</td>
                      <td className="num">{l.cover_day.toFixed(0)}</td>
                      <td><Gauge days={l.doh_before} /></td>
                      <td className="num" style={{ color: 'var(--ink-3)' }}>{l.suggested_pcs}</td>
                      <td className="num">
                        <input
                          type="number" min={0} value={l.final_pcs}
                          onChange={(e) => adjust(l, parseInt(e.target.value || '0', 10))}
                        />
                      </td>
                      <td><Gauge days={l.doh_after} /></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <p className="hint" style={{ marginTop: 8 }}>
            แถบวัดยาวตามจำนวนวันที่ของจะอยู่ได้ ขีดดำคือเส้น KPI 25 วัน — แดงคือต่ำกว่า 7 วัน เหลืองคือเกินเส้น
          </p>
        </>
      )}
    </>
  )
}
