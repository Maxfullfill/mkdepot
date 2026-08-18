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

interface OffT {
  mat_code: string; item_descr: string
  stations_total: number; in_stock: number; short: number; no_record: number
  coverage_pct: number; order_lines: number; order_qty: number
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

interface OffAlert {
  mat_code: string; item_descr: string
  stations_total: number; in_stock: number
  short_total: number; short_on_trip: number
  order_lines: number; order_qty: number; uom: string | null
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
  const [offT, setOffT] = useState<OffT[]>([])
  const [off, setOff] = useState<OffAlert[]>([])
  const [only, setOnly] = useState<'order' | 'all'>('order')

  useEffect(() => setTripDate(snapshotDate), [snapshotDate])

  async function calculate() {
    setBusy(true); setErr(''); setLines([]); setRunId(null); setDiag(null); setKpi(null); setOffT([]); setOff([])
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
        const [{ data: k }, { data: o }] = await Promise.all([
          supabase.rpc('kpi_for_run', { p_run_id: data }),
          supabase.rpc('offtemplate_alert', { p_run_id: data }),
        ])
        if (Array.isArray(k) && k.length) setKpi(k[0] as Kpi)
        setOff((o ?? []) as OffAlert[])
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

  /** ออกไฟล์ตามเทมเพลต 25 คอลัมน์ที่ใช้กับระบบจริง */
  async function exportTemplate() {
    if (!runId) return
    setBusy(true)
    try {
      const [{ data: rows, error }, { data: cfgRows }] = await Promise.all([
        supabase.from('v_order_template').select('*').eq('run_id', runId)
          .order('po_group').order('mat_code'),
        supabase.from('template_config').select('key, value'),
      ])
      if (error) throw new Error(error.message)
      if (!rows?.length) { setErr('ไม่มีรายการที่ต้องส่ง'); return }

      const cfg = Object.fromEntries((cfgRows ?? []).map((c) => [c.key, c.value]))

      // วันที่รูปแบบ 17.08.2026 — วันและเดือนสองหลักเสมอ
      const [yy, mm, dd] = tripDate.split('-')
      const d = `${dd.padStart(2, '0')}.${mm.padStart(2, '0')}.${yy}`

      // PO GROUP เริ่มนับ 1 ใหม่ทุกครั้ง เรียงตามสาขา
      const groups = new Map<string, number>()
      const out = rows.map((r) => {
        if (!groups.has(r.plant_code)) groups.set(r.plant_code, groups.size + 1)
        return {
          'UDC_POTYPE': cfg['UDC_POTYPE'] ?? 'ZIN3',
          'UDC_Vendor_Code': cfg['UDC_Vendor_Code'] ?? 'Z1101',
          'Descr': cfg['Descr'] ?? '',
          'Pur org': cfg['Pur org'] ?? '1000',
          'Pur group': cfg['Pur group'] ?? '140',
          'Currency': cfg['Currency'] ?? 'THB',
          '*PO GROUP': groups.get(r.plant_code),
          'Multi Group': '',
          'Sequence No.': cfg['Sequence No.'] ?? '1',
          '': r.plant_code,
          ' ': r.shipto_name,
          '*ITEM': r.mat_code,
          'Item Descr': r.item_descr,
          'QTY(TransferUOM)': r.qty,
          'UOM': r.uom,
          'UDC_FREEMARK': '',
          'SchedShipDate': d,
          'SCHEDARRIVDATE': d,
          'UDC_STORLOC': cfg['UDC_STORLOC'] ?? '4001',
          'UDC_TAXCODE': cfg['UDC_TAXCODE'] ?? 'V7',
          'UDC_VALUTYPE': '',
          'UDC_SHIPPOINT': '',
          'UDC_TRUCKSIZE': '',
          '*Shipto': '',
          'UDC_SEPARATE': '',
        }
      })

      const ws = XLSX.utils.json_to_sheet(out)
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, ws, 'template')
      XLSX.writeFile(wb, `PO_${tripDate.replace(/-/g, '')}.xlsx`)
      await supabase.from('calc_runs')
        .update({ exported_at: new Date().toISOString() }).eq('run_id', runId)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally { setBusy(false) }
  }

  /** สินค้าที่ใช้เทมเพลตคนละแบบ ออกเป็นไฟล์ต่างหาก */
  async function exportOffTemplate() {
    if (!runId) return
    const { data, error } = await supabase.from('v_offtemplate_lines')
      .select('*').eq('run_id', runId).order('branch_name')
    if (error) { setErr(error.message); return }
    if (!data?.length) return
    const [yy, mm, dd] = tripDate.split('-')
    const d = `${dd.padStart(2, '0')}.${mm.padStart(2, '0')}.${yy}`
    const ws = XLSX.utils.json_to_sheet(data.map((r) => ({
      'วันที่ส่ง': d,
      'PlantCode': r.plant_code,
      'สาขา': r.branch_name,
      'รหัสสินค้า': r.mat_code,
      'สินค้า': r.item_descr,
      'คงเหลือ': r.on_hand_pcs,
      'ระหว่างทาง': r.in_transit_pcs,
      'จำนวนที่ต้องสั่ง': r.qty,
      'หน่วย': r.uom,
    })))
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'สั่งแยก')
    XLSX.writeFile(wb, `สั่งแยก_${tripDate.replace(/-/g, '')}.xlsx`)
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

          {off.length > 0 && (
            <div className="card" style={{ marginBottom: 14, borderColor: 'var(--oil)' }}>
              <div className="spread">
                <div>
                  <h3>ต้องสั่งแยก — ใช้เทมเพลตนี้ไม่ได้</h3>
                  <p className="hint">
                    ไม่รวมอยู่ในไฟล์เทมเพลตหลัก ต้องสั่งด้วยรูปแบบอื่นต่างหาก
                    · นับของขาดจากทุกสาขาที่ดูแล ไม่ใช่เฉพาะรอบนี้
                  </p>
                </div>
                <button className="btn ghost" onClick={() => void exportOffTemplate()}>
                  ดาวน์โหลดรายการ
                </button>
              </div>
              <table>
                <thead>
                  <tr>
                    <th>สินค้า</th><th className="num">มีของ</th>
                    <th className="num">ขาด</th><th className="num">ขาดในสาขาที่รถเข้า</th>
                    <th className="num">รอบนี้ต้องสั่ง</th>
                  </tr>
                </thead>
                <tbody>
                  {off.map((o) => (
                    <tr key={o.mat_code}>
                      <td>{o.item_descr}</td>
                      <td className="num">{o.in_stock} / {o.stations_total}</td>
                      <td className="num" style={{
                        color: o.short_total ? 'var(--alarm)' : undefined, fontWeight: 600,
                      }}>
                        {o.short_total}
                      </td>
                      <td className="num" style={{ color: 'var(--ink-3)' }}>{o.short_on_trip}</td>
                      <td className="num">
                        {o.order_qty ? `${o.order_qty.toLocaleString()} ${o.uom ?? ''}` : '—'}
                        {o.order_lines ? (
                          <span style={{ color: 'var(--ink-3)' }}> · {o.order_lines} สาขา</span>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {off.some((o) => o.short_total > 0) && (
                <div className="note bad" style={{ marginTop: 12 }}>
                  ของขาดรวม {off.reduce((s, o) => s + o.short_total, 0)} สาขา —
                  อย่าลืมสั่งแยก ไม่งั้นจะขาดต่อไปเพราะไม่ได้อยู่ในไฟล์เทมเพลต
                </div>
              )}
            </div>
          )}

          {offT.length > 0 && (
            <div className="card" style={{ marginBottom: 14 }}>
              <div className="spread">
                <div>
                  <h3>ต้องสั่งแยก ไม่อยู่ในเทมเพลตนี้</h3>
                  <p className="hint">
                    สินค้ากลุ่มนี้ใช้เทมเพลตคนละแบบ ไม่ถูกใส่ในไฟล์ export ปกติ
                    ต้องสั่งด้วยวิธีอื่น แต่ยังนับใน KPI ตามเดิม
                  </p>
                </div>
                {offT.some((o) => o.order_qty > 0) && (
                  <button className="btn ghost" onClick={() => void exportOffTemplate()}>
                    ดาวน์โหลดรายการ
                  </button>
                )}
              </div>
              <table>
                <thead>
                  <tr>
                    <th>สินค้า</th><th className="num">มีของ</th><th className="num">ขาด</th>
                    <th className="num">ครบ</th><th className="num">รอบนี้ต้องสั่ง</th>
                  </tr>
                </thead>
                <tbody>
                  {offT.map((o) => (
                    <tr key={o.mat_code}>
                      <td>{o.item_descr}</td>
                      <td className="num">{o.in_stock} / {o.stations_total}</td>
                      <td className="num" style={{ color: o.short ? 'var(--alarm)' : undefined }}>
                        {o.short}
                      </td>
                      <td className="num" style={{
                        color: o.coverage_pct >= 100 ? 'var(--ok)' : 'var(--alarm)', fontWeight: 600,
                      }}>
                        {o.coverage_pct?.toFixed(1)}%
                      </td>
                      <td className="num">
                        {o.order_qty ? `${o.order_qty} ชิ้น / ${o.order_lines} สาขา` : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {offT.some((o) => o.short > 0) ? (
                <div className="note bad" style={{ marginTop: 12 }}>
                  ของขาดรวม {offT.reduce((s, o) => s + o.short, 0)} สาขา —
                  ต้องสั่งแยกนอกเทมเพลตนี้ อย่าลืมทำ ไม่งั้นจะสะสมไปรอบหน้า
                </div>
              ) : (
                <div className="note good" style={{ marginTop: 12 }}>มีของครบทุกสาขา</div>
              )}
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
