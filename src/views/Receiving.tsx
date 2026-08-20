import { useEffect, useMemo, useState } from 'react'
import * as XLSX from 'xlsx'
import { supabase } from '../lib/supabase'

interface Row {
  plant_code: string; branch_name: string; province: string; area: string
  mat_code: string; item_name: string | null; uom: string | null
  me2n_pending: number; station_transit: number; gap: number
  oldest_po: string | null; age_days: number | null
  po_list: string | null; station_stock: number; status: string
}
interface Sum { status: string; lines: number; qty: number; stations: number; max_age: number }

const TONE: Record<string, string> = {
  'สาขายังไม่เห็นของ': 'alarm',
  'PO ปิดแล้วแต่สาขายังค้าง': 'oil',
  'สาขาเห็นไม่ครบ': 'oil',
  'สาขาเห็นเกิน': 'oil',
  'ตรงกัน': 'ok',
}

const EXPLAIN: Record<string, string> = {
  'สาขายังไม่เห็นของ': 'ME2N มี PO ค้างส่ง แต่ระบบสาขาไม่แสดงว่ามีของกำลังมา — อาจยังไม่ได้ส่งออกจากคลัง หรือส่งแล้วแต่ยังไม่ทำรับ',
  'PO ปิดแล้วแต่สาขายังค้าง': 'ระบบสาขายังแสดงว่ามีของกำลังมา แต่ ME2N ไม่มี PO ค้างแล้ว — น่าจะทำรับไปแล้วแต่ค้างในระบบสาขา',
  'สาขาเห็นไม่ครบ': 'จำนวนที่สาขาเห็นน้อยกว่าที่ ME2N ค้างส่ง',
  'สาขาเห็นเกิน': 'จำนวนที่สาขาเห็นมากกว่าที่ ME2N ค้างส่ง',
  'ตรงกัน': 'สองระบบตรงกัน ไม่ต้องทำอะไร',
}

export default function Receiving() {
  const [rows, setRows] = useState<Row[]>([])
  const [sum, setSum] = useState<Sum[]>([])
  const [busy, setBusy] = useState(true)
  const [err, setErr] = useState('')
  const [q, setQ] = useState('')
  const [pick, setPick] = useState<string>('ทั้งหมด')
  const [sortAge, setSortAge] = useState(true)

  useEffect(() => { void load() }, [])

  async function load() {
    setBusy(true)
    const [r, s] = await Promise.all([
      supabase.from('v_receiving').select('*'),
      supabase.rpc('receiving_summary'),
    ])
    if (r.error) setErr(r.error.message)
    setRows((r.data ?? []) as Row[])
    setSum(Array.isArray(s.data) ? (s.data as Sum[]) : [])
    setBusy(false)
  }

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase()
    let out = rows
    if (pick !== 'ทั้งหมด') out = out.filter((r) => r.status === pick)
    if (t) out = out.filter((r) =>
      `${r.branch_name} ${r.item_name ?? ''} ${r.province} ${r.mat_code} ${r.po_list ?? ''}`
        .toLowerCase().includes(t))
    return [...out].sort((a, b) => sortAge
      ? (b.age_days ?? -1) - (a.age_days ?? -1)
      : b.me2n_pending - a.me2n_pending)
  }, [rows, q, pick, sortAge])

  const totals = useMemo(() => ({
    pending: rows.reduce((s, r) => s + r.me2n_pending, 0),
    mismatch: rows.filter((r) => r.status !== 'ตรงกัน').length,
    oldest: Math.max(0, ...rows.map((r) => r.age_days ?? 0)),
    stations: new Set(rows.filter((r) => r.status !== 'ตรงกัน').map((r) => r.plant_code)).size,
  }), [rows])

  function exportRows() {
    if (!shown.length) return
    const ws = XLSX.utils.json_to_sheet(shown.map((r) => ({
      'จังหวัด': r.province, 'ผจก.เขต': r.area,
      'PlantCode': r.plant_code, 'สาขา': r.branch_name,
      'รหัสสินค้า': r.mat_code, 'สินค้า': r.item_name,
      'ME2N ค้างส่ง': r.me2n_pending,
      'สาขาเห็นระหว่างทาง': r.station_transit,
      'ต่าง': r.gap,
      'เลข PO': r.po_list,
      'PO เก่าสุด': r.oldest_po,
      'ค้างมา(วัน)': r.age_days,
      'คงเหลือที่สาขา': r.station_stock,
      'สถานะ': r.status,
    })))
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'ยังไม่ทำรับ')
    XLSX.writeFile(wb, `ยังไม่ทำรับ_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.xlsx`)
  }

  if (busy) return <><h2>สินค้ายังไม่ได้ทำรับ</h2><div className="note">กำลังโหลด…</div></>

  return (
    <>
      <h2>สินค้ายังไม่ได้ทำรับ</h2>
      <p className="lede">
        เทียบ PO ที่ค้างส่งใน ME2N กับของระหว่างทางที่ระบบสาขาเห็น ·
        ความต่างบอกว่าติดขั้นตอนไหน
      </p>

      {err && <div className="note bad">{err}</div>}

      {rows.length === 0 ? (
        <div className="card">
          <h3>ยังไม่มีข้อมูลให้เทียบ</h3>
          <p className="hint" style={{ marginBottom: 0 }}>
            ต้องนำเข้าทั้งไฟล์ ME2N และ POWER_BI ก่อน ·
            ถ้าเพิ่งรัน migration ล่าสุด ต้องอัปไฟล์ POWER_BI ใหม่อีกครั้ง
            เพราะข้อมูลเดิมยังไม่มีคอลัมน์ระหว่างทาง
          </p>
        </div>
      ) : (
        <>
          <dl className="stats">
            <div className="stat">
              <dt>ME2N ค้างส่งรวม</dt>
              <dd>{totals.pending.toLocaleString()} <small>ชิ้น</small></dd>
            </div>
            <div className="stat">
              <dt>รายการที่ไม่ตรงกัน</dt>
              <dd style={{ color: totals.mismatch ? 'var(--alarm)' : 'var(--ok)' }}>
                {totals.mismatch}
              </dd>
            </div>
            <div className="stat">
              <dt>สาขาที่เกี่ยวข้อง</dt>
              <dd>{totals.stations}</dd>
            </div>
            <div className="stat">
              <dt>ค้างนานสุด</dt>
              <dd style={{ color: totals.oldest > 30 ? 'var(--alarm)' : 'var(--oil)' }}>
                {totals.oldest} <small>วัน</small>
              </dd>
            </div>
          </dl>

          <div className="card">
            <h3>แยกตามสถานะ</h3>
            <p className="hint">กดเพื่อกรองเฉพาะสถานะนั้น</p>
            <table>
              <tbody>
                {sum.map((s) => (
                  <tr key={s.status} style={{ cursor: 'pointer' }}
                    onClick={() => setPick(pick === s.status ? 'ทั้งหมด' : s.status)}>
                    <td style={{ width: 220 }}>
                      <span className={`tag ${TONE[s.status] ?? ''}`}>{s.status}</span>
                      {pick === s.status && (
                        <span style={{ marginLeft: 8, color: 'var(--act)', fontSize: 13 }}>กรองอยู่</span>
                      )}
                    </td>
                    <td className="num" style={{ width: 90 }}>{s.lines}</td>
                    <td className="num" style={{ width: 100 }}>{s.qty?.toLocaleString()} ชิ้น</td>
                    <td className="num" style={{ width: 90 }}>{s.stations} สาขา</td>
                    <td style={{ color: 'var(--ink-3)', fontSize: 13.5 }}>
                      {EXPLAIN[s.status] ?? ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="card" style={{ padding: 0 }}>
            <div className="row" style={{ padding: '18px 22px 14px' }}>
              <input type="text" placeholder="ค้นหาสาขา สินค้า หรือเลข PO" value={q}
                onChange={(e) => setQ(e.target.value)} style={{ width: 280 }} />
              {pick !== 'ทั้งหมด' && (
                <button className="btn ghost" onClick={() => setPick('ทั้งหมด')}>
                  ล้างตัวกรอง
                </button>
              )}
              <button className={`btn ${sortAge ? '' : 'ghost'}`}
                style={{ padding: '7px 15px', fontSize: 14 }}
                onClick={() => setSortAge(!sortAge)}>
                {sortAge ? 'เรียงตามค้างนาน' : 'เรียงตามจำนวน'}
              </button>
              <span style={{ fontSize: 13.5, color: 'var(--ink-3)' }}>{shown.length} รายการ</span>
              <span style={{ flex: 1 }} />
              <button className="btn ghost" onClick={exportRows}>ดาวน์โหลด Excel</button>
            </div>

            <div className="tw" style={{ border: 0, borderTop: '1px solid var(--line)', maxHeight: '58vh' }}>
              <table>
                <thead>
                  <tr>
                    <th>สาขา</th><th>สินค้า</th>
                    <th className="num">ME2N</th>
                    <th className="num">สาขาเห็น</th>
                    <th className="num">ต่าง</th>
                    <th className="num">คงเหลือ</th>
                    <th className="num">ค้างมา</th>
                    <th>สถานะ</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.slice(0, 600).map((r, i) => (
                    <tr key={i}>
                      <td>
                        {r.branch_name}
                        {r.po_list && (
                          <div style={{ fontSize: 12, color: 'var(--ink-3)', fontFamily: 'var(--mono)' }}>
                            {r.po_list.slice(0, 40)}
                          </div>
                        )}
                      </td>
                      <td>{r.item_name ?? r.mat_code}</td>
                      <td className="num">{r.me2n_pending || '—'}</td>
                      <td className="num">{r.station_transit || '—'}</td>
                      <td className="num" style={{
                        color: r.gap === 0 ? 'var(--ink-3)'
                          : r.gap > 0 ? 'var(--alarm)' : 'var(--oil)',
                      }}>
                        {r.gap > 0 ? `+${r.gap}` : r.gap || '—'}
                      </td>
                      <td className="num" style={{
                        color: r.station_stock <= 0 ? 'var(--alarm)' : 'var(--ink-2)',
                      }}>
                        {r.station_stock}
                      </td>
                      <td className="num" style={{
                        color: (r.age_days ?? 0) > 30 ? 'var(--alarm)'
                          : (r.age_days ?? 0) > 14 ? 'var(--oil)' : 'var(--ink-3)',
                      }}>
                        {r.age_days !== null ? `${r.age_days} วัน` : '—'}
                      </td>
                      <td><span className={`tag ${TONE[r.status] ?? ''}`}>{r.status}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {shown.length > 600 && (
              <p className="hint" style={{ padding: '12px 22px 18px', margin: 0 }}>
                แสดง 600 แถวแรกจาก {shown.length} — ดาวน์โหลด Excel เพื่อดูครบ
              </p>
            )}
          </div>

          <div className="note" style={{ marginTop: 18 }}>
            แถวที่ <strong>คงเหลือเป็น 0 และค้างมานาน</strong> คือกลุ่มที่กระทบ Availability โดยตรง —
            ของออกไปแล้วแต่ยังไม่ถึงหรือยังไม่ทำรับ สาขาจึงขายไม่ได้ทั้งที่ระบบคิดว่ามีของกำลังมา
          </div>
        </>
      )}
    </>
  )
}
