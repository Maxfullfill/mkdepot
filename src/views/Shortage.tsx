import { useEffect, useMemo, useState } from 'react'
import * as XLSX from 'xlsx'
import { supabase } from '../lib/supabase'

interface Row {
  group_kind: string
  plant_code: string; branch_name: string; province: string; area: string
  station_group: string
  mat_code: string; item_name: string; uom: string | null
  sales_per_day: number; incoming: number; depot_stock: number
  days_since_trip: number; last_trip: string | null; reason: string
}
interface Sum {
  group_kind: string; mat_code: string; item_name: string
  stations: number; incoming_lines: number; depot_ok: number; stuck: number
}
interface Explain {
  found: boolean; reason?: string
  branch_name?: string; item_name?: string; class_fix?: string
  stock_pcs?: number; in_transit?: number; depot_stock?: number | null
  sales_per_day?: number; doh_now?: number | null
  cover_day?: number; lead_time?: number; safety_stock?: number
  demand_cover?: number; target?: number; skipped?: boolean
  need?: number; need_rounded?: number; oldest_po_days?: number | null
  notes?: string[]
  incoming_detail?: {
    source: string; po_no: string | null; po_date: string | null
    age_days: number | null; qty: number; note: string | null
  }[]
}

const TONE: Record<string, string> = {
  'ของกำลังมา': 'oil',
  'คลังมีของ รอรถ': 'ok',
  'ไม่มีในไฟล์คลัง': '',
  'คลังไม่มีของ': 'alarm',
  'ไม่มีประวัติรถเข้า': 'alarm',
}

export default function Shortage({ preset }: {
  preset?: { kind?: string; name?: string }
}) {
  const [rows, setRows] = useState<Row[]>([])
  const [sum, setSum] = useState<Sum[]>([])
  const [busy, setBusy] = useState(true)
  const [err, setErr] = useState('')
  const [q, setQ] = useState('')

  const [kind, setKind] = useState<string>('ทั้งหมด')
  const [pickMats, setPickMats] = useState<Set<string>>(new Set())
  const [dropMats, setDropMats] = useState<Set<string>>(new Set())
  const [reason, setReason] = useState('ทั้งหมด')

  const [ex, setEx] = useState<Explain | null>(null)
  const [exErr, setExErr] = useState('')
  const [exKey, setExKey] = useState('')

  useEffect(() => { void load() }, [])

  /** รับตัวกรองที่กดมาจากหน้าภาพรวม — เทียบด้วยชื่อสินค้า
   *  ต้องรอให้รายการสรุปโหลดเสร็จก่อนจึงจะแปลงชื่อเป็นรหัสได้ */
  useEffect(() => {
    if (!preset) return
    if (preset.kind) setKind(preset.kind)
    if (preset.name && sum.length) {
      const hit = sum.filter((x) => x.item_name === preset.name).map((x) => x.mat_code)
      if (hit.length) setPickMats(new Set(hit))
    }
  }, [preset, sum])

  async function load() {
    setBusy(true)
    const [r, s] = await Promise.all([
      supabase.from('v_short_all').select('*'),
      supabase.rpc('short_summary'),
    ])
    if (r.error) setErr(r.error.message)
    setRows((r.data ?? []) as Row[])
    setSum(Array.isArray(s.data) ? (s.data as Sum[]) : [])
    setBusy(false)
  }

  async function check(plant: string, mat: string) {
    setExKey(`${plant}|${mat}`); setEx(null); setExErr('')
    const { data, error } = await supabase.rpc('explain_line', {
      p_plant: plant, p_mat: mat, p_trip: null,
    })
    if (error) { setExErr(error.message); return }
    setEx(data as Explain)
  }

  const toggle = (set: Set<string>, v: string, fn: (s: Set<string>) => void) => {
    const n = new Set(set)
    n.has(v) ? n.delete(v) : n.add(v)
    fn(n)
  }

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase()
    return rows.filter((r) => {
      if (kind !== 'ทั้งหมด' && r.group_kind !== kind) return false
      if (pickMats.size && !pickMats.has(r.mat_code)) return false
      if (dropMats.has(r.mat_code)) return false
      if (reason !== 'ทั้งหมด' && r.reason !== reason) return false
      if (t && !`${r.branch_name} ${r.item_name} ${r.province} ${r.area} ${r.mat_code}`
        .toLowerCase().includes(t)) return false
      return true
    }).sort((a, b) => b.days_since_trip - a.days_since_trip)
  }, [rows, kind, pickMats, dropMats, reason, q])

  const matList = useMemo(() => {
    const s = kind === 'ทั้งหมด' ? sum : sum.filter((x) => x.group_kind === kind)
    return s.sort((a, b) => b.stations - a.stations)
  }, [sum, kind])

  const byReason = useMemo(() => {
    const m: Record<string, number> = {}
    shown.forEach((r) => { m[r.reason] = (m[r.reason] ?? 0) + 1 })
    return Object.entries(m).sort((a, b) => b[1] - a[1])
  }, [shown])

  function exportRows() {
    if (!shown.length) return
    const ws = XLSX.utils.json_to_sheet(shown.map((r) => ({
      'กลุ่ม': r.group_kind, 'จังหวัด': r.province, 'ผจก.เขต': r.area,
      'PlantCode': r.plant_code, 'สาขา': r.branch_name,
      'รหัสสินค้า': r.mat_code, 'สินค้า': r.item_name,
      'ขาย/วัน': r.sales_per_day, 'ของกำลังมา': r.incoming,
      'คลังมี': r.depot_stock < 0 ? 'ไม่มีในไฟล์' : r.depot_stock,
      'รถเข้าล่าสุด': r.last_trip, 'รถไม่เข้า(วัน)': r.days_since_trip,
      'สาเหตุ': r.reason,
    })))
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'ของขาด')
    XLSX.writeFile(wb, `ของขาด_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.xlsx`)
  }

  if (busy) return <><h2>ของขาด</h2><div className="note">กำลังโหลด…</div></>

  return (
    <>
      <h2>ของขาด</h2>
      <p className="lede">
        ทุกบรรทัดที่สต็อกเป็นศูนย์ · Class A นับเฉพาะที่ยังมียอดขาย ·
        หัวเชื้อนับทุกสาขาเพราะ KPI บังคับว่าต้องมีครบ
      </p>

      {err && <div className="note bad">{err}</div>}

      <dl className="stats">
        <div className="stat"><dt>บรรทัดที่แสดง</dt><dd>{shown.length}</dd></div>
        <div className="stat">
          <dt>สาขาที่เกี่ยวข้อง</dt>
          <dd>{new Set(shown.map((r) => r.plant_code)).size}</dd>
        </div>
        <div className="stat">
          <dt>มีของกำลังมา</dt>
          <dd style={{ color: 'var(--oil)' }}>{shown.filter((r) => r.incoming > 0).length}</dd>
        </div>
        <div className="stat">
          <dt>คลังไม่มีของ</dt>
          <dd style={{ color: 'var(--alarm)' }}>
            {shown.filter((r) => r.depot_stock === 0).length}
          </dd>
        </div>
      </dl>

      <div className="card">
        <h3>ตัวกรอง</h3>

        <div className="row" style={{ marginBottom: 14 }}>
          {['ทั้งหมด', 'Class A', 'หัวเชื้อ', 'สั่งแยก'].map((k) => (
            <button key={k} className={`btn ${kind === k ? '' : 'ghost'}`}
              style={{ padding: '6px 14px', fontSize: 13.5 }}
              onClick={() => { setKind(k); setPickMats(new Set()) }}>
              {k}
              {k !== 'ทั้งหมด' && (
                <span style={{ opacity: .6, marginLeft: 6 }}>
                  {rows.filter((r) => r.group_kind === k).length}
                </span>
              )}
            </button>
          ))}
        </div>

        <p className="hint" style={{ marginBottom: 8 }}>
          กดชื่อสินค้าเพื่อดูเฉพาะตัวนั้น กดหลายตัวได้ ·
          กดปุ่มกากบาทเพื่อตัดสินค้านั้นออกจากรายการ
        </p>

        <div className="row" style={{ gap: 6, marginBottom: 14 }}>
          {matList.map((m) => {
            const on = pickMats.has(m.mat_code)
            const off = dropMats.has(m.mat_code)
            return (
              <span key={m.mat_code} style={{ display: 'inline-flex', alignItems: 'center' }}>
                <button
                  className={`btn ${on ? '' : 'ghost'}`}
                  style={{
                    padding: '5px 11px', fontSize: 13, borderRadius: '6px 0 0 6px',
                    opacity: off ? 0.35 : 1,
                    textDecoration: off ? 'line-through' : undefined,
                  }}
                  onClick={() => toggle(pickMats, m.mat_code, setPickMats)}>
                  {m.item_name}
                  <span style={{ opacity: .6, marginLeft: 7 }}>{m.stations}</span>
                </button>
                <button
                  className="btn ghost"
                  title={off ? 'เอากลับเข้ารายการ' : 'ตัดสินค้านี้ออก'}
                  style={{
                    padding: '5px 9px', fontSize: 13, borderRadius: '0 6px 6px 0',
                    borderLeft: 0, color: off ? 'var(--alarm)' : 'var(--ink-3)',
                  }}
                  onClick={() => toggle(dropMats, m.mat_code, setDropMats)}>
                  {off ? '↺' : '×'}
                </button>
              </span>
            )
          })}
        </div>

        <div className="row">
          <input type="text" placeholder="ค้นหาสาขา จังหวัด หรือ ผจก.เขต" value={q}
            onChange={(e) => setQ(e.target.value)} style={{ width: 260 }} />
          <select value={reason} onChange={(e) => setReason(e.target.value)}>
            <option>ทั้งหมด</option>
            {byReason.map(([r]) => <option key={r}>{r}</option>)}
          </select>
          {(pickMats.size > 0 || dropMats.size > 0 || reason !== 'ทั้งหมด' || q) && (
            <button className="btn ghost" onClick={() => {
              setPickMats(new Set()); setDropMats(new Set())
              setReason('ทั้งหมด'); setQ('')
            }}>ล้างตัวกรอง</button>
          )}
          <span style={{ flex: 1 }} />
          <button className="btn ghost" onClick={exportRows} disabled={!shown.length}>
            ดาวน์โหลด Excel
          </button>
        </div>

        <div className="row" style={{ gap: 8, marginTop: 14 }}>
          {byReason.map(([r, n]) => (
            <span key={r} className={`tag ${TONE[r] ?? ''}`}>{r} {n}</span>
          ))}
        </div>
      </div>

      <div className="tw">
        <table>
          <thead>
            <tr>
              <th>กลุ่ม</th><th>สาขา</th><th>สินค้า</th>
              <th className="num">ขาย/วัน</th>
              <th className="num">กำลังมา</th><th className="num">คลังมี</th>
              <th className="num">รถไม่เข้า</th><th>สาเหตุ</th><th></th>
            </tr>
          </thead>
          <tbody>
            {shown.slice(0, 500).map((r, i) => {
              const k = `${r.plant_code}|${r.mat_code}`
              return (
                <tr key={i} style={{ background: exKey === k ? 'var(--wash)' : undefined }}>
                  <td>
                    <span className={`tag ${r.group_kind === 'หัวเชื้อ' ? 'oil'
                      : r.group_kind === 'สั่งแยก' ? '' : 'ok'}`}>
                      {r.group_kind}
                    </span>
                  </td>
                  <td>
                    {r.branch_name}
                    <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>
                      {r.province?.replace('จังหวัด', '')} · {r.area}
                    </div>
                  </td>
                  <td>{r.item_name}</td>
                  <td className="num">{Number(r.sales_per_day).toFixed(2)}</td>
                  <td className="num" style={{ color: r.incoming ? 'var(--oil)' : 'var(--ink-3)' }}>
                    {r.incoming || '—'}
                  </td>
                  <td className="num" style={{
                    color: r.depot_stock === 0 ? 'var(--alarm)'
                      : r.depot_stock < 0 ? 'var(--ink-3)' : 'var(--ok)',
                  }}>
                    {r.depot_stock < 0 ? '—' : r.depot_stock}
                  </td>
                  <td className="num" style={{
                    color: r.days_since_trip > 14 ? 'var(--alarm)' : 'var(--ink-3)',
                  }}>
                    {r.days_since_trip > 9000 ? '—' : `${r.days_since_trip} วัน`}
                  </td>
                  <td><span className={`tag ${TONE[r.reason] ?? ''}`}>{r.reason}</span></td>
                  <td>
                    <button className="btn ghost" style={{ padding: '4px 12px', fontSize: 13 }}
                      onClick={() => void check(r.plant_code, r.mat_code)}>ตรวจ</button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {shown.length > 500 && (
        <p className="hint" style={{ marginTop: 10 }}>
          แสดง 500 แถวแรกจาก {shown.length} — ดาวน์โหลด Excel เพื่อดูครบ
        </p>
      )}

      {(ex || exErr) && (
        <div className="card" style={{ marginTop: 18 }}>
          <div className="spread">
            <h3>ผลตรวจบรรทัด</h3>
            <button className="btn ghost" onClick={() => { setEx(null); setExErr(''); setExKey('') }}>
              ปิด
            </button>
          </div>

          {exErr && <div className="note bad" style={{ whiteSpace: 'pre-wrap' }}>{exErr}</div>}

          {ex?.found && (
            <>
              <p style={{ margin: '0 0 12px', fontWeight: 600 }}>
                {ex.branch_name} · {ex.item_name}
                <span className="tag" style={{ marginLeft: 8 }}>{ex.class_fix}</span>
              </p>
              <table>
                <tbody>
                  <tr><td style={{ width: 240 }}>คงเหลือที่สาขา</td>
                    <td className="num" style={{ width: 110 }}>{ex.stock_pcs}</td>
                    <td style={{ color: 'var(--ink-3)' }}>ชิ้น</td></tr>
                  <tr><td>ของระหว่างทาง</td>
                    <td className="num" style={{ color: ex.in_transit ? 'var(--oil)' : undefined }}>
                      {ex.in_transit}</td>
                    <td style={{ color: 'var(--ink-3)' }}>
                      ชิ้น — หักออกจากยอดสั่ง
                      {(ex.oldest_po_days ?? 0) > 30 && (
                        <span style={{ color: 'var(--alarm)', marginLeft: 8 }}>
                          ใบเก่าสุดค้างมา {ex.oldest_po_days} วัน
                        </span>
                      )}
                    </td></tr>
                  <tr><td>ยอดขายต่อวัน</td>
                    <td className="num">{ex.sales_per_day}</td><td /></tr>
                  <tr><td>CoverDay + LeadTime</td>
                    <td className="num">{ex.cover_day} + {ex.lead_time}</td>
                    <td style={{ color: 'var(--ink-3)' }}>วัน</td></tr>
                  <tr><td>เป้าหมายรวม</td>
                    <td className="num"><strong>{ex.target}</strong></td>
                    <td style={{ color: 'var(--ink-3)' }}>
                      รวม safety stock {ex.safety_stock} ชิ้น
                    </td></tr>
                  <tr><td><strong>ควรสั่ง</strong></td>
                    <td className="num"><strong style={{ fontSize: 16 }}>{ex.need_rounded}</strong></td>
                    <td style={{ color: 'var(--ink-3)' }}>
                      {ex.skipped ? 'ถูกข้าม' : 'ชิ้น'}
                    </td></tr>
                  <tr><td>คลังมีของ</td>
                    <td className="num" style={{
                      color: ex.depot_stock === 0 ? 'var(--alarm)' : undefined,
                    }}>
                      {ex.depot_stock === null ? 'ไม่มีข้อมูล' : ex.depot_stock}
                    </td><td /></tr>
                </tbody>
              </table>

              {(ex.incoming_detail ?? []).length > 0 && (
                <div style={{ marginTop: 16 }}>
                  <p className="hint" style={{ margin: '0 0 8px' }}>
                    ของระหว่างทาง {ex.in_transit} ชิ้น มาจากใบไหนบ้าง
                  </p>
                  <table>
                    <thead>
                      <tr>
                        <th>แหล่ง</th><th>เลขที่</th><th>วันที่</th>
                        <th className="num">อายุ</th><th className="num">จำนวน</th><th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {ex.incoming_detail!.map((d, i) => (
                        <tr key={i}>
                          <td>
                            <span className={`tag ${d.source === 'ME2N' ? ''
                              : d.source === 'โอนจากสาขา' ? 'ok' : 'oil'}`}>{d.source}</span>
                          </td>
                          <td style={{ fontFamily: 'var(--mono)', fontSize: 13 }}>{d.po_no ?? '—'}</td>
                          <td style={{ fontFamily: 'var(--mono)', fontSize: 12.5, color: 'var(--ink-3)' }}>
                            {d.po_date ?? '—'}
                          </td>
                          <td className="num" style={{
                            color: (d.age_days ?? 0) > 60 ? 'var(--alarm)'
                              : (d.age_days ?? 0) > 30 ? 'var(--oil)' : 'var(--ink-3)',
                          }}>
                            {d.age_days !== null ? `${d.age_days} วัน` : '—'}
                          </td>
                          <td className="num"><strong>{Number(d.qty)}</strong></td>
                          <td style={{ fontSize: 12.5, color: 'var(--oil)' }}>{d.note}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="note" style={{ marginTop: 14 }}>
                {(ex.notes ?? []).map((n, i) => <div key={i}>{n}</div>)}
              </div>
            </>
          )}

          {ex && !ex.found && <div className="note bad">{ex.reason}</div>}
        </div>
      )}
    </>
  )
}
