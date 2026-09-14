import { useEffect, useMemo, useState } from 'react'
import * as XLSX from 'xlsx'
import { supabase } from '../lib/supabase'
import { StepNum } from './ui'

interface Row {
  plant_code: string; branch_name: string; province: string
  mat_code: string; item_name: string; uom: string | null
  class_fix: string | null; class_dyna: string | null
  stock_pcs: number; incoming: number
  sales_per_day: number; doh_now: number | null
  target_pcs: number; need_pcs: number
  depot_pcs: number; can_ship: number; note: string
}
interface Sum {
  has_data: boolean; lines: number; stations: number; items: number
  out_of_stock: number; need_pcs: number; can_ship: number; snapshot: string | null
}
interface Avail {
  'ฐานที่ใช้': string; 'บรรทัด': number; 'มีของ': number
  'ขาด': number; 'availability': number
}

export default function ClassPrep() {
  const [sum, setSum] = useState<Sum | null>(null)
  const [avail, setAvail] = useState<Avail[]>([])
  const [rows, setRows] = useState<Row[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [ran, setRan] = useState(false)

  const [cover, setCover] = useState<number | null>(20)
  const [lead, setLead] = useState<number | null>(3)
  const [ss, setSs] = useState<number | null>(1)
  const [onlyShort, setOnlyShort] = useState(false)
  const [q, setQ] = useState('')

  useEffect(() => { void load() }, [])

  async function load() {
    const [s, a] = await Promise.all([
      supabase.rpc('class_prep_summary'),
      supabase.rpc('avail_preview'),
    ])
    if (s.error) setErr(s.error.message)
    setSum((s.data as Sum) ?? null)
    setAvail((a.data ?? []) as Avail[])
  }

  async function run() {
    setBusy(true); setErr('')
    const { data, error } = await supabase.rpc('class_prep', {
      p_cover: cover, p_lead: lead, p_ss: ss, p_only_short: onlyShort,
    })
    setBusy(false)
    if (error) { setErr(error.message); return }
    setRows((data ?? []) as Row[])
    setRan(true)
  }

  function exportRows() {
    if (!shown.length) return
    const ws = XLSX.utils.json_to_sheet(shown.map((r) => ({
      'สาขา': r.branch_name, 'รหัสสาขา': r.plant_code, 'จังหวัด': r.province,
      'สินค้า': r.item_name, 'รหัสสินค้า': r.mat_code,
      'คลาสตอนนี้': r.class_fix, 'คลาสที่จะปรับ': r.class_dyna,
      'คงเหลือ': r.stock_pcs, 'ระหว่างทาง': r.incoming,
      'ขาย/วัน': r.sales_per_day, 'DOH': r.doh_now,
      'ต้องเตรียม': r.need_pcs, 'คลังมี': r.depot_pcs < 0 ? '' : r.depot_pcs,
      'ส่งได้': r.can_ship, 'หมายเหตุ': r.note,
    })))
    ws['!cols'] = [{ wch: 26 }, { wch: 10 }, { wch: 14 }, { wch: 34 }, { wch: 12 },
      { wch: 11 }, { wch: 12 }, { wch: 9 }, { wch: 11 }, { wch: 9 },
      { wch: 8 }, { wch: 10 }, { wch: 9 }, { wch: 9 }, { wch: 26 }]
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'เตรียมปรับคลาส')
    XLSX.writeFile(wb, `เตรียมปรับคลาส_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.xlsx`)
  }

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase()
    if (!t) return rows
    return rows.filter((r) =>
      `${r.branch_name} ${r.item_name} ${r.plant_code} ${r.mat_code} ${r.note}`
        .toLowerCase().includes(t))
  }, [rows, q])

  const fix = avail.find((a) => a['ฐานที่ใช้'].includes('Fix'))
  const dyn = avail.find((a) => a['ฐานที่ใช้'].includes('Dyna'))
  const gap = fix && dyn ? Number((fix.availability - dyn.availability).toFixed(1)) : null

  return (
    <>
      <h2>เตรียมปรับคลาส</h2>
      <p className="lede">
        ใช้ตอนใกล้รอบปรับคลาสรายไตรมาส ไม่ใช่งานประจำวัน ·
        ดูว่าบรรทัดไหนกำลังจะขึ้นเป็น Class A และต้องเตรียมของไว้เท่าไหร่
      </p>

      {err && <div className="note bad">{err}</div>}

      {sum && !sum.has_data && (
        <div className="note bad">
          ยังไม่มีข้อมูลคลาสที่จะปรับ — อัปไฟล์ POWER_BI ใหม่อีกครั้ง
          ระบบจะอ่านคอลัมน์ Class-สาขา(3ด.Dyna) เข้ามาเอง
        </div>
      )}

      {fix && dyn && (
        <div className="card">
          <h3>Availability จะเปลี่ยนไปแค่ไหน</h3>
          <p className="hint">
            เทียบสองฐานบนข้อมูลชุดเดียวกัน ณ วันที่ {sum?.snapshot} ·
            ยังไม่ได้ปรับคลาสจริง เป็นการจำลองล่วงหน้า
          </p>
          <table>
            <thead>
              <tr>
                <th>ฐานที่ใช้</th><th className="num">บรรทัด</th>
                <th className="num">มีของ</th><th className="num">ขาด</th>
                <th className="num">Availability</th>
              </tr>
            </thead>
            <tbody>
              {avail.map((a, i) => (
                <tr key={i}>
                  <td>{a['ฐานที่ใช้']}</td>
                  <td className="num">{a['บรรทัด']?.toLocaleString()}</td>
                  <td className="num">{a['มีของ']?.toLocaleString()}</td>
                  <td className="num" style={{ color: 'var(--alarm)' }}>{a['ขาด']}</td>
                  <td className="num">
                    <strong style={{ fontSize: 15 }}>{a.availability}%</strong>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {gap !== null && (
            <div className={`note ${gap > 0 ? 'bad' : 'good'}`} style={{ marginTop: 14 }}>
              {gap > 0
                ? `ถ้าปรับคลาสวันนี้ Availability จะตกลง ${gap} จุด — เตรียมของตามรายการด้านล่างก่อนถึงรอบปรับ`
                : `ถ้าปรับคลาสวันนี้ Availability จะไม่ตก เตรียมของไว้พอแล้ว`}
            </div>
          )}
        </div>
      )}

      {sum && sum.has_data && (
        <dl className="stats">
          <div className="stat">
            <dt>บรรทัดที่จะขึ้นเป็น A</dt><dd>{sum.lines.toLocaleString()}</dd>
          </div>
          <div className="stat">
            <dt>ของหมดอยู่ตอนนี้</dt>
            <dd style={{ color: sum.out_of_stock ? 'var(--alarm)' : 'var(--ok)' }}>
              {sum.out_of_stock}
            </dd>
          </div>
          <div className="stat">
            <dt>ต้องเตรียมรวม</dt>
            <dd>{sum.need_pcs.toLocaleString()} <small>ชิ้น</small></dd>
          </div>
          <div className="stat">
            <dt>สาขาที่เกี่ยวข้อง</dt><dd>{sum.stations}</dd>
          </div>
        </dl>
      )}

      <div className="card">
        <h3>เกณฑ์ที่ใช้คำนวณ</h3>
        <p className="hint">
          แยกจากการคำนวณประจำวัน ปรับตรงนี้ไม่กระทบยอดเติมรายวันเลย
        </p>
        <div className="row" style={{ gap: 22 }}>
          <span style={{ display: 'flex', gap: 9, alignItems: 'center' }}>
            <label style={{ minWidth: 108 }}>จำนวนวันที่เผื่อ</label>
            <StepNum value={cover} step={1} min={1} max={90} onChange={setCover} />
            <span style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>วัน (ROP)</span>
          </span>
          <span style={{ display: 'flex', gap: 9, alignItems: 'center' }}>
            <label>LeadTime</label>
            <StepNum value={lead} step={1} min={0} max={30} onChange={setLead} />
            <span style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>วัน</span>
          </span>
          <span style={{ display: 'flex', gap: 9, alignItems: 'center' }}>
            <label>Safety stock</label>
            <StepNum value={ss} step={1} min={0} max={20} onChange={setSs} />
            <span style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>ชิ้น</span>
          </span>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="checkbox" checked={onlyShort}
              onChange={(e) => setOnlyShort(e.target.checked)} />
            เฉพาะที่ของหมดแล้ว
          </label>
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={() => void run()} disabled={busy || !sum?.has_data}>
            {busy ? 'กำลังคำนวณ…' : 'คำนวณรายการที่ต้องเตรียม'}
          </button>
        </div>
      </div>

      {ran && (
        <div className="card" style={{ padding: 0 }}>
          <div className="row" style={{ padding: '18px 22px 14px' }}>
            <h3 style={{ margin: 0 }}>รายการที่ต้องเตรียม</h3>
            <input type="text" placeholder="ค้นหาสาขาหรือสินค้า" value={q}
              onChange={(e) => setQ(e.target.value)} style={{ width: 230 }} />
            <span style={{ fontSize: 13, color: 'var(--ink-3)' }}>
              {shown.length} บรรทัด · {shown.reduce((a, r) => a + r.need_pcs, 0).toLocaleString()} ชิ้น
            </span>
            <span style={{ flex: 1 }} />
            <button className="btn ghost" onClick={exportRows} disabled={!shown.length}>
              ดาวน์โหลดรายการ
            </button>
          </div>

          {shown.length === 0 ? (
            <div className="note" style={{ margin: '0 22px 22px' }}>
              ไม่มีบรรทัดที่ต้องเตรียม — ของพอตามเกณฑ์ Class A อยู่แล้ว
            </div>
          ) : (
            <div className="tw" style={{ border: 0, borderTop: '1px solid var(--rule)' }}>
              <table>
                <thead>
                  <tr>
                    <th>สาขา</th><th>สินค้า</th>
                    <th className="num">คงเหลือ</th><th className="num">ระหว่างทาง</th>
                    <th className="num">ขาย/วัน</th><th className="num">DOH</th>
                    <th className="num">ต้องเตรียม</th><th className="num">คลังมี</th>
                    <th>หมายเหตุ</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r, i) => (
                    <tr key={i}>
                      <td>{r.branch_name}</td>
                      <td>{r.item_name}</td>
                      <td className="num" style={{
                        color: r.stock_pcs <= 0 ? 'var(--alarm)' : undefined,
                      }}>{r.stock_pcs}</td>
                      <td className="num">{r.incoming || ''}</td>
                      <td className="num">{Number(r.sales_per_day).toFixed(2)}</td>
                      <td className="num">{r.doh_now ?? '—'}</td>
                      <td className="num"><strong>{r.need_pcs}</strong></td>
                      <td className="num" style={{ color: 'var(--ink-3)' }}>
                        {r.depot_pcs < 0 ? 'ไม่มีในไฟล์' : r.depot_pcs}
                      </td>
                      <td style={{ fontSize: 12.5, color: 'var(--ink-2)' }}>{r.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <div className="note">
        หน้านี้ไม่ยุ่งกับการคำนวณประจำวัน ยอดที่คำนวณได้ยังไม่ถูกส่งเข้าระบบเติมสินค้า ·
        ใช้ไฟล์ที่ดาวน์โหลดไปสั่งของเตรียมไว้ หรือใช้หน้าโอนกำหนดเองถ้าจะดึงของจากสาขาอื่น
      </div>
    </>
  )
}
