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

interface Kpi {
  total_lines: number; in_stock_before: number
  short_total: number; short_on_trip: number; short_off_trip: number
  fixed_here: number; stations_total: number; stations_on_trip: number
  avail_before: number; avail_after: number
  doh_before: number; doh_after: number
  over_doh_lines: number; excess_liters: number
  dead_lines: number; dead_liters: number
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
  const [diag, setDiag] = useState<string[] | null>(null)
  const [kpi, setKpi] = useState<Kpi | null>(null)
  const [only, setOnly] = useState<'order' | 'all'>('order')

  useEffect(() => setTripDate(snapshotDate), [snapshotDate])

  async function calculate() {
    setBusy(true); setErr(''); setLines([]); setRunId(null); setDiag(null); setKpi(null)
    try {
      const { data, error } = await supabase.rpc('calculate_replenishment', {
        p_trip_date: tripDate,
        p_snapshot_date: snapshotDate,
        p_created_by: (await supabase.auth.getUser()).data.user?.id ?? null,
      })
      if (error) throw new Error(error.message)
      setRunId(data as string)
      const n = await load(data as string)
      if (n === 0) await explainEmpty()
      else {
        // KPI ต้องนับทั้งพอร์ต ไม่ใช่เฉพาะสาขาที่รถเข้ารอบนี้
        const { data: k } = await supabase.rpc('kpi_for_run', { p_run_id: data })
        if (Array.isArray(k) && k.length) setKpi(k[0] as Kpi)
      }
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
    if (error) { setErr(error.message); return 0 }
    const rows = (data ?? []).map((r: Record<string, unknown>) => ({
      ...(r as unknown as Line),
      branch_name: (r.stations as { branch_name: string } | null)?.branch_name,
      item_desc: (r.items as { desc_en: string } | null)?.desc_en,
    }))
    setLines(rows)
    return rows.length
  }

  /** คำนวณแล้วได้ 0 บรรทัด — ไล่หาว่าติดตรงไหน แทนที่จะเงียบ */
  async function explainEmpty() {
    const snaps = await supabase.from('stock_snapshots')
      .select('class_fix', { count: 'exact' }).eq('snapshot_date', snapshotDate)
    const trips = await supabase.from('delivery_plan')
      .select('plant_code', { count: 'exact', head: true }).eq('trip_date', tripDate)
    const settings = await supabase.from('settings')
      .select('key, value').in('key', ['include_class_a', 'include_class_b', 'include_class_c'])

    const rows = (snaps.data ?? []) as { class_fix: string | null }[]
    const byClass = rows.reduce<Record<string, number>>((a, r) => {
      const k = r.class_fix ?? 'ไม่มีคลาส'; a[k] = (a[k] ?? 0) + 1; return a
    }, {})
    const on = (settings.data ?? [])
      .filter((s) => Number(s.value) === 1)
      .map((s) => s.key.replace('include_class_', 'Class ').toUpperCase())

    const msgs: string[] = []
    if (!rows.length) {
      msgs.push(`ไม่มีข้อมูลสต็อกของวันที่ ${snapshotDate} — อัปโหลดไฟล์ POWER_BI ก่อน`)
    } else {
      msgs.push('สต็อกที่มี: ' + Object.entries(byClass).map(([k, v]) => `${k} ${v}`).join(' · '))
      if (byClass['ไม่มีคลาส']) {
        msgs.push(`มี ${byClass['ไม่มีคลาส']} แถวที่ไม่มีคลาส — เป็นข้อมูลเก่าก่อนอัปเดตระบบ ให้อัปโหลดไฟล์ POWER_BI ใหม่อีกครั้ง`)
      }
    }
    if (!trips.count) {
      msgs.push(`ไม่มีแผนเที่ยวรถของวันที่ ${tripDate} — อัปโหลดไฟล์เที่ยวรถ โดยตั้งวันที่ให้ตรงกัน`)
    } else {
      msgs.push(`สาขาที่รถเข้าวันนี้: ${trips.count} แห่ง`)
    }
    msgs.push('คลาสที่เปิดให้คำนวณ: ' + (on.length ? on.join(', ') : 'ไม่ได้เปิดเลย — ตั้งค่าที่หน้า KPI และค่าคำนวณ'))
    setDiag(msgs)
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
    return {
      lines: lines.length,
      stations: new Set(ordered.map((l) => l.plant_code)).size,
      pieces: ordered.reduce((s, l) => s + l.final_pcs, 0),
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

      {diag && (
        <div className="card">
          <h3>คำนวณแล้วไม่พบรายการ</h3>
          <p className="hint">ไม่มีบรรทัดไหนเข้าเงื่อนไขครบทั้งสามข้อ: มีสต็อก · รถเข้าวันนี้ · อยู่ในคลาสที่เปิดไว้</p>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: 'var(--ink-2)' }}>
            {diag.map((m, i) => <li key={i} style={{ marginBottom: 4 }}>{m}</li>)}
          </ul>
        </div>
      )}

      {lines.length > 0 && (
        <>
          <dl className="stats">
            <div className="stat">
              <dt>สาขาที่ต้องส่ง</dt>
              <dd>{stats.stations}{kpi && <small> / {kpi.stations_total}</small>}</dd>
            </div>
            <div className="stat">
              <dt>รวมที่ต้องเติม</dt>
              <dd>{stats.pieces.toLocaleString()} <small>ชิ้น</small></dd>
            </div>
            <div className="stat">
              <dt>Availability ก่อนส่ง</dt>
              <dd style={{ color: 'var(--ink-2)' }}>
                {kpi ? kpi.avail_before?.toFixed(1) : '—'}<small>%</small>
              </dd>
            </div>
            <div className="stat">
              <dt>Availability หลังส่ง</dt>
              <dd style={{ color: kpi && kpi.avail_after >= 97 ? 'var(--ok)' : 'var(--alarm)' }}>
                {kpi ? kpi.avail_after?.toFixed(1) : '—'}<small>%</small>
              </dd>
            </div>
            <div className="stat">
              <dt>ยังขาดหลังส่ง</dt>
              <dd style={{ color: kpi && kpi.short_off_trip ? 'var(--alarm)' : undefined }}>
                {kpi ? kpi.short_off_trip : '—'}
              </dd>
            </div>
            <div className="stat">
              <dt>DOH ก่อน → หลัง</dt>
              <dd style={{ color: 'var(--oil)', fontSize: 19 }}>
                {kpi ? `${kpi.doh_before?.toFixed(0)} → ${kpi.doh_after?.toFixed(0)}` : '—'}
                <small> วัน</small>
              </dd>
            </div>
          </dl>

          {kpi && (
            <div className={`note ${kpi.avail_after >= 97 ? 'good' : 'bad'}`} style={{ marginBottom: 14 }}>
              นับทั้ง {kpi.stations_total} สาขาที่ดูแล {kpi.total_lines.toLocaleString()} บรรทัด —
              รอบนี้รถเข้า {kpi.stations_on_trip} สาขา
              {' · '}ของขาดตอนนี้ {kpi.short_total} บรรทัด
              {' '}(รอบนี้แก้ได้ {kpi.fixed_here}
              {kpi.short_off_trip > 0 && <>, อีก {kpi.short_off_trip} อยู่ในสาขาที่รถไม่ได้เข้า ต้องรอรอบหน้า</>})
              {kpi.avail_after < 97 && <> — ยังไม่ถึงเป้า 97%</>}
            </div>
          )}

          {kpi && (
            <div className="card" style={{ marginBottom: 14 }}>
              <h3>DOH — ดูแนวโน้ม ไม่ได้คุมในสูตร</h3>
              <p className="hint">
                รอบนี้ทำให้ DOH ขยับจาก {kpi.doh_before?.toFixed(1)} เป็น {kpi.doh_after?.toFixed(1)} วัน
                ({kpi.doh_after > kpi.doh_before ? '+' : ''}
                {(kpi.doh_after - kpi.doh_before).toFixed(1)})
              </p>
              <table>
                <tbody>
                  <tr>
                    <td style={{ width: 260 }}>บรรทัดที่ DOH เกิน 25 วัน</td>
                    <td className="num" style={{ width: 90, color: 'var(--oil)' }}>
                      {kpi.over_doh_lines}
                    </td>
                    <td style={{ color: 'var(--ink-3)', fontSize: 12.5 }}>
                      จาก {kpi.total_lines.toLocaleString()} บรรทัด
                    </td>
                  </tr>
                  <tr>
                    <td>ส่วนเกินเทียบเพดาน 25 วัน</td>
                    <td className="num" style={{ color: 'var(--oil)' }}>
                      {kpi.excess_liters?.toLocaleString()}
                    </td>
                    <td style={{ color: 'var(--ink-3)', fontSize: 12.5 }}>ลิตร</td>
                  </tr>
                  <tr>
                    <td>ของไม่ขายเลยใน 30 วัน</td>
                    <td className="num" style={{ color: 'var(--alarm)' }}>{kpi.dead_lines}</td>
                    <td style={{ color: 'var(--ink-3)', fontSize: 12.5 }}>
                      บรรทัด · {kpi.dead_liters?.toLocaleString()} ลิตร
                    </td>
                  </tr>
                </tbody>
              </table>
              <div className="note" style={{ marginTop: 12 }}>
                DOH ลดด้วยการสั่งน้อยลงไม่ได้ — ต่อให้หยุดสั่งทั้งเดือนก็ยังเกินเป้า
                เพราะส่วนใหญ่เป็นของที่กองอยู่แล้ว ต้องดึงออกหรือโอนเกลี่ยเท่านั้น
              </div>
            </div>
          )}

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
