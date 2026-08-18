import { useEffect, useMemo, useState } from 'react'
import * as XLSX from 'xlsx'
import { supabase } from '../lib/supabase'
import { Fold } from './ui'

interface TLine {
  id: number; mat_code: string; from_plant: string; to_plant: string
  area: string | null; qty: number
  tier: string | null; from_area: string | null; to_area: string | null
  from_stock: number; from_doh: number; to_stock: number; to_doh: number
  uom: string | null; status: string; match_level: string | null
  station_group: string | null
  from_name?: string; to_name?: string; item_name?: string
}
interface Hot {
  plant_code: string; branch_name: string; area: string
  province: string; district: string
  mat_code: string; item_name: string; uom: string | null
  stock_pcs: number; sales_per_day: number; doh: number | null
  excess_pcs: number; stock_liters: number; no_sale_30d: boolean
}

type HotKey = keyof Hot
interface Zone {
  area: string; mat_code: string; item_name: string
  lines: number; stock_pcs: number; short_lines: number
  doh: number | null; excess_pcs: number; room_pcs: number
}

export default function Transfers({ snapshotDate }: { snapshotDate: string }) {
  const [runId, setRunId] = useState<string | null>(null)
  const [lines, setLines] = useState<TLine[]>([])
  const [hot, setHot] = useState<Hot[]>([])
  const [zone, setZone] = useState<Zone[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [q, setQ] = useState('')
  const [sortKey, setSortKey] = useState<HotKey>('excess_pcs')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [onlyDead, setOnlyDead] = useState(false)

  useEffect(() => { void loadDash() }, [])

  async function loadDash() {
    const [h, z] = await Promise.all([
      supabase.from('v_doh_hotspot').select('*').order('excess_pcs', { ascending: false }).limit(3000),
      supabase.from('v_zone_balance').select('*'),
    ])
    setHot((h.data ?? []) as Hot[])
    setZone((z.data ?? []) as Zone[])
  }

  async function run() {
    setBusy(true); setErr(''); setLines([]); setRunId(null)
    try {
      const { data, error } = await supabase.rpc('calculate_transfers', {
        p_snapshot_date: snapshotDate,
        p_created_by: (await supabase.auth.getUser()).data.user?.id ?? null,
      })
      if (error) throw new Error(error.message)
      setRunId(data as string)
      await loadLines(data as string)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally { setBusy(false) }
  }

  async function loadLines(id: string) {
    const { data, error } = await supabase
      .from('transfer_lines')
      .select('*, items(template_descr, desc_th)')
      .eq('run_id', id).order('area').order('mat_code')
    if (error) { setErr(error.message); return }
    const names = new Map(
      (await supabase.from('stations').select('plant_code, branch_name')).data
        ?.map((s) => [s.plant_code as string, s.branch_name as string]) ?? []
    )
    setLines((data ?? []).map((r: Record<string, unknown>) => {
      const it = r.items as { template_descr: string | null; desc_th: string | null } | null
      const l = r as unknown as TLine
      return {
        ...l,
        from_name: names.get(l.from_plant) ?? l.from_plant,
        to_name: names.get(l.to_plant) ?? l.to_plant,
        item_name: it?.template_descr ?? it?.desc_th ?? l.mat_code,
      }
    }))
  }

  async function setStatus(id: number, status: string) {
    setLines((p) => p.map((l) => (l.id === id ? { ...l, status } : l)))
    await supabase.from('transfer_lines').update({ status }).eq('id', id)
  }

  const active = useMemo(() => lines.filter((l) => l.status !== 'ยกเลิก'), [lines])

  const summary = useMemo(() => ({
    qty: active.reduce((s, l) => s + l.qty, 0),
    pairs: new Set(active.map((l) => `${l.from_plant}>${l.to_plant}`)).size,
    areas: new Set(active.map((l) => l.area)).size,
    byTier: active.reduce<Record<string, number>>((a, l) => {
      const k = l.tier ?? '—'; a[k] = (a[k] ?? 0) + l.qty; return a
    }, {}),
  }), [active])

  function exportTransfers() {
    if (!active.length) return
    const ws = XLSX.utils.json_to_sheet(active.map((l) => ({
      'ระยะ': l.tier,
      'กลุ่ม': l.area,
      'สาขาต้นทาง': l.from_name,
      'รหัสต้นทาง': l.from_plant,
      'DOH ต้นทาง': l.from_doh,
      'สาขาปลายทาง': l.to_name,
      'รหัสปลายทาง': l.to_plant,
      'DOH ปลายทาง': l.to_doh,
      'รหัสสินค้า': l.mat_code,
      'สินค้า': l.item_name,
      'จำนวนโอน': l.qty,
      'หน่วย': l.uom,
    })))
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'โอนเกลี่ย')
    XLSX.writeFile(wb, `โอนเกลี่ย_${snapshotDate.replace(/-/g, '')}.xlsx`)
  }

  /** กดหัวคอลัมน์เพื่อเรียง กดซ้ำเพื่อสลับมากสุด/น้อยสุด */
  function sortBy(k: HotKey) {
    if (k === sortKey) setSortDir(sortDir === 'desc' ? 'asc' : 'desc')
    else { setSortKey(k); setSortDir(typeof hot[0]?.[k] === 'number' ? 'desc' : 'asc') }
  }

  const shownHot = useMemo(() => {
    const t = q.trim().toLowerCase()
    let rows = hot
    if (t) rows = rows.filter((h) =>
      `${h.branch_name} ${h.item_name} ${h.area} ${h.province} ${h.district} ${h.mat_code}`
        .toLowerCase().includes(t))
    if (onlyDead) rows = rows.filter((h) => h.no_sale_30d)
    const dir = sortDir === 'asc' ? 1 : -1
    return [...rows].sort((a, b) => {
      const x = a[sortKey], y = b[sortKey]
      if (x === null || x === undefined) return 1
      if (y === null || y === undefined) return -1
      if (typeof x === 'number' && typeof y === 'number') return (x - y) * dir
      return String(x).localeCompare(String(y), 'th') * dir
    })
  }, [hot, q, sortKey, sortDir, onlyDead])

  function exportHot() {
    if (!shownHot.length) return
    const ws = XLSX.utils.json_to_sheet(shownHot.map((h) => ({
      'จังหวัด': h.province,
      'อำเภอ': h.district,
      'ผจก.เขต': h.area,
      'PlantCode': h.plant_code,
      'สาขา': h.branch_name,
      'รหัสสินค้า': h.mat_code,
      'สินค้า': h.item_name,
      'คงเหลือ': h.stock_pcs,
      'หน่วย': h.uom,
      'ขาย/วัน': h.sales_per_day,
      'DOH': h.doh,
      'ของเกิน': h.excess_pcs,
      'ลิตร': h.stock_liters,
      'ไม่ขายเลย 30 วัน': h.no_sale_30d ? 'ใช่' : '',
    })))
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'ของกอง')
    XLSX.writeFile(wb, `ของกอง_${snapshotDate.replace(/-/g, '')}.xlsx`)
  }

  // จับคู่ข้ามเขต: SKU ที่เขตหนึ่งล้น อีกเขตยังมีที่ว่าง
  const crossPairs = useMemo(() => {
    const byMat = new Map<string, Zone[]>()
    zone.forEach((z) => {
      if (!byMat.has(z.mat_code)) byMat.set(z.mat_code, [])
      byMat.get(z.mat_code)!.push(z)
    })
    const out: { item: string; from: Zone; to: Zone; qty: number }[] = []
    byMat.forEach((zs) => {
      const donors = zs.filter((z) => z.excess_pcs > 0).sort((a, b) => b.excess_pcs - a.excess_pcs)
      const takers = zs.filter((z) => z.room_pcs > 0 || z.short_lines > 0)
        .sort((a, b) => b.short_lines - a.short_lines || b.room_pcs - a.room_pcs)
      donors.forEach((d) => takers.forEach((t) => {
        if (d.area === t.area) return
        const qty = Math.min(d.excess_pcs, Math.max(t.room_pcs, t.short_lines))
        if (qty >= 5) out.push({ item: d.item_name, from: d, to: t, qty })
      }))
    })
    return out.sort((a, b) => b.qty - a.qty).slice(0, 40)
  }, [zone])

  const totalExcess = hot.reduce((s, h) => s + h.excess_pcs, 0)
  const deadLines = hot.filter((h) => h.no_sale_30d)

  return (
    <>
      <h2>โอนเกลี่ยสินค้า</h2>
      <p className="lede">
        เอาของเกินจากสาขาหนึ่งไปอุดสาขาที่ขาด แทนการเบิกใหม่จากคลัง
        ของในเครือข่ายไม่เพิ่ม DOH จึงค่อย ๆ ลงตามยอดขาย ·
        จับคู่ไล่จากใกล้ไปไกล อำเภอ → จังหวัด → เขตผู้จัดการ → ข้ามเขต ·
        เฉพาะ Class A ไม่รวมหัวเชื้อ
      </p>

      <div className="card">
        <div className="row">
          <button className="btn" onClick={run} disabled={busy}>
            {busy ? 'กำลังคำนวณ…' : 'คำนวณรายการโอน'}
          </button>
          <span style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>ใช้สต็อก ณ {snapshotDate}</span>
          {active.length > 0 && (
            <>
              <span style={{ flex: 1 }} />
              <button className="btn ghost" onClick={exportTransfers}>ดาวน์โหลดใบโอน</button>
            </>
          )}
        </div>
        {err && <div className="note bad" style={{ marginTop: 12 }}>{err}</div>}
        {runId && lines.length === 0 && !busy && (
          <div className="note" style={{ marginTop: 12 }}>
            ไม่มีคู่ที่โอนกันได้ภายใต้ผู้จัดการเขตคนเดียวกัน — สาขาในเขตมีสถานะคล้ายกันหมด
            ลองดูตารางจับคู่ข้ามเขตด้านล่าง
          </div>
        )}
      </div>

      {active.length > 0 && (
        <>
          <dl className="stats">
            <div className="stat"><dt>รายการโอน</dt><dd>{active.length}</dd></div>
            <div className="stat"><dt>รวมจำนวน</dt><dd>{summary.qty.toLocaleString()} <small>ชิ้น</small></dd></div>
            <div className="stat"><dt>คู่สาขา</dt><dd>{summary.pairs}</dd></div>
            <div className="stat"><dt>กลุ่มที่เกี่ยวข้อง</dt><dd>{summary.areas}</dd></div>
          </dl>

          <div className="note" style={{ marginBottom: 12 }}>
            แยกตามระยะ: {Object.entries(summary.byTier).map(([k, v]) => `${k} ${v} ชิ้น`).join(' · ')}
          </div>

          <div className="tw" style={{ marginBottom: 20 }}>
            <table>
              <thead>
                <tr>
                  <th>ระยะ</th><th>กลุ่ม</th><th>สินค้า</th>
                  <th>ต้นทาง</th><th className="num">DOH</th>
                  <th>ปลายทาง</th><th className="num">DOH</th>
                  <th className="num">โอน</th><th></th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.id} style={{ opacity: l.status === 'ยกเลิก' ? 0.4 : 1 }}>
                    <td>
                      <span className={`tag ${l.tier === 'อำเภอ' ? 'ok' : l.tier === 'จังหวัด' ? '' : 'oil'}`}>
                        {l.tier ?? '—'}
                      </span>
                    </td>
                    <td style={{ color: 'var(--ink-2)', fontSize: 12.5 }}>{l.area}</td>
                    <td>{l.item_name}</td>
                    <td>{l.from_name}</td>
                    <td className="num" style={{ color: 'var(--oil)' }}>{l.from_doh}</td>
                    <td>{l.to_name}</td>
                    <td className="num" style={{ color: l.to_stock <= 0 ? 'var(--alarm)' : undefined }}>
                      {l.to_stock <= 0 ? 'ขาด' : l.to_doh}
                    </td>
                    <td className="num"><strong>{l.qty}</strong></td>
                    <td>
                      <button className="btn ghost"
                        onClick={() => setStatus(l.id, l.status === 'ยกเลิก' ? 'เสนอ' : 'ยกเลิก')}>
                        {l.status === 'ยกเลิก' ? 'คืนค่า' : 'ตัดออก'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <Fold title="จับคู่ข้ามจังหวัด" note={`${crossPairs.length} คู่ที่เป็นไปได้`}
        hint="SKU ที่จังหวัดหนึ่งกองอยู่ แต่อีกจังหวัดมีสาขาขาด — ใช้ตัดสินใจโอนข้ามจังหวัดเอง">
        {crossPairs.length === 0 ? (
          <div className="note">ไม่มีคู่ข้ามเขตที่ชัดเจน</div>
        ) : (
          <div className="tw" style={{ maxHeight: '46vh' }}>
            <table>
              <thead>
                <tr>
                  <th>สินค้า</th>
                  <th>จังหวัดต้นทาง</th><th className="num">DOH</th><th className="num">ของเกิน</th>
                  <th>จังหวัดปลายทาง</th><th className="num">DOH</th><th className="num">สาขาขาด</th>
                  <th className="num">โอนได้</th>
                </tr>
              </thead>
              <tbody>
                {crossPairs.map((p, i) => (
                  <tr key={i}>
                    <td>{p.item}</td>
                    <td><span className="tag oil">{p.from.area}</span></td>
                    <td className="num" style={{ color: 'var(--oil)' }}>{p.from.doh ?? '—'}</td>
                    <td className="num">{p.from.excess_pcs}</td>
                    <td><span className="tag ok">{p.to.area}</span></td>
                    <td className="num">{p.to.doh ?? '—'}</td>
                    <td className="num" style={{ color: p.to.short_lines ? 'var(--alarm)' : undefined }}>
                      {p.to.short_lines || '—'}
                    </td>
                    <td className="num"><strong>{p.qty}</strong></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Fold>

      <Fold title="ของกองรายสาขา"
        note={`${hot.length} บรรทัด · เกิน ${totalExcess.toLocaleString()} ชิ้น`}
        hint="กดหัวคอลัมน์เพื่อเรียง กดซ้ำเพื่อสลับมากสุด/น้อยสุด">
        <div className="row" style={{ marginBottom: 10 }}>
          <input type="text" placeholder="ค้นหาสาขา สินค้า จังหวัด หรือ ผจก." value={q}
            onChange={(e) => setQ(e.target.value)} style={{ width: 260 }} />
          <label style={{ display: 'flex', gap: 7, alignItems: 'center', cursor: 'pointer', fontSize: 13 }}>
            <input type="checkbox" checked={onlyDead} onChange={(e) => setOnlyDead(e.target.checked)} />
            เฉพาะที่ไม่ขายเลย 30 วัน
          </label>
          <span style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>
            {shownHot.length} รายการ · เกินรวม{' '}
            {shownHot.reduce((s, h) => s + h.excess_pcs, 0).toLocaleString()} ชิ้น
          </span>
          <span style={{ flex: 1 }} />
          <button className="btn ghost" onClick={exportHot} disabled={!shownHot.length}>
            ดาวน์โหลด Excel
          </button>
        </div>
        <div className="tw" style={{ maxHeight: '58vh' }}>
          <table>
            <thead>
              <tr>
                {([
                  ['province', 'จังหวัด', false],
                  ['district', 'อำเภอ', false],
                  ['area', 'ผจก.เขต', false],
                  ['branch_name', 'สาขา', false],
                  ['item_name', 'สินค้า', false],
                  ['stock_pcs', 'คงเหลือ', true],
                  ['sales_per_day', 'ขาย/วัน', true],
                  ['doh', 'DOH', true],
                  ['excess_pcs', 'ของเกิน', true],
                  ['stock_liters', 'ลิตร', true],
                ] as [HotKey, string, boolean][]).map(([k, label, num]) => (
                  <th key={k} className={num ? 'num' : undefined}
                    style={{ cursor: 'pointer', userSelect: 'none' }}
                    onClick={() => sortBy(k)}
                    title="กดเพื่อเรียง">
                    {label}
                    {sortKey === k && (
                      <span style={{ marginLeft: 4, color: 'var(--act)' }}>
                        {sortDir === 'desc' ? '▼' : '▲'}
                      </span>
                    )}
                  </th>
                ))}
                <th></th>
              </tr>
            </thead>
            <tbody>
              {shownHot.slice(0, 800).map((h, i) => (
                <tr key={i}>
                  <td style={{ fontSize: 12.5 }}>{h.province?.replace('จังหวัด', '')}</td>
                  <td style={{ fontSize: 12.5, color: 'var(--ink-2)' }}>
                    {h.district?.replace(/^อำเภอ|^เขต/, '')}
                  </td>
                  <td><span className="tag">{h.area}</span></td>
                  <td>{h.branch_name}</td>
                  <td>{h.item_name}</td>
                  <td className="num">{h.stock_pcs}</td>
                  <td className="num">{h.sales_per_day?.toFixed(2)}</td>
                  <td className="num" style={{ color: 'var(--oil)' }}>{h.doh ?? '∞'}</td>
                  <td className="num"><strong>{h.excess_pcs}</strong></td>
                  <td className="num" style={{ color: 'var(--ink-3)' }}>{h.stock_liters}</td>
                  <td>{h.no_sale_30d && <span className="tag alarm">ไม่ขายเลย</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {shownHot.length > 800 && (
          <p className="hint" style={{ marginTop: 8 }}>
            แสดง 800 แถวแรกจาก {shownHot.length} — ดาวน์โหลด Excel เพื่อดูครบ
          </p>
        )}
      </Fold>
    </>
  )
}
