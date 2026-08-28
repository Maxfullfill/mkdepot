import { useEffect, useMemo, useState } from 'react'
import * as XLSX from 'xlsx'
import { supabase } from '../lib/supabase'
import { StepNum } from './ui'

interface Line {
  id: number; mat_code: string; from_plant: string; to_plant: string
  area: string | null; qty: number
  from_stock: number; from_doh: number; to_stock: number; to_doh: number
  uom: string | null; status: string; match_level: string | null
  from_name?: string; to_name?: string; item_name?: string
}

export default function TransfersB({ snapshotDate }: { snapshotDate: string }) {
  const [runId, setRunId] = useState<string | null>(null)
  const [lines, setLines] = useState<Line[]>([])
  const [pending, setPending] = useState<Line[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [days, setDays] = useState(30)
  const [level, setLevel] = useState(2)
  const [msg, setMsg] = useState('')

  useEffect(() => { void init() }, [])

  async function init() {
    const { data } = await supabase.from('settings').select('key, value')
      .in('key', ['transfer_b_max_days', 'transfer_b_max_level'])
    const m = Object.fromEntries((data ?? []).map((x) => [x.key, Number(x.value)]))
    if (m.transfer_b_max_days) setDays(m.transfer_b_max_days)
    if (m.transfer_b_max_level) setLevel(m.transfer_b_max_level)
    await loadPending()
  }

  const flash = (t: string) => { setMsg(t); setTimeout(() => setMsg(''), 2000) }

  async function names() {
    const { data } = await supabase.from('stations').select('plant_code, branch_name')
    return new Map((data ?? []).map((s) => [s.plant_code as string, s.branch_name as string]))
  }

  function shape(rows: Record<string, unknown>[], nm: Map<string, string>): Line[] {
    return rows.map((r) => {
      const it = r.items as { template_descr: string | null; desc_th: string | null } | null
      const l = r as unknown as Line
      return {
        ...l,
        from_name: nm.get(l.from_plant) ?? l.from_plant,
        to_name: nm.get(l.to_plant) ?? l.to_plant,
        item_name: it?.template_descr ?? it?.desc_th ?? l.mat_code,
      }
    })
  }

  async function loadPending() {
    const nm = await names()
    const { data } = await supabase
      .from('transfer_lines')
      .select('*, items(template_descr, desc_th), transfer_runs!inner(kind)')
      .eq('status', 'ยืนยัน').eq('to_class', 'Class B')
    setPending(shape((data ?? []) as Record<string, unknown>[], nm))
  }

  async function run() {
    setBusy(true); setErr(''); setLines([]); setRunId(null)
    try {
      const { data, error } = await supabase.rpc('calculate_transfers_b', {
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
    const nm = await names()
    const { data, error } = await supabase
      .from('transfer_lines').select('*, items(template_descr, desc_th)')
      .eq('run_id', id).order('match_level').order('mat_code')
    if (error) { setErr(error.message); return }
    setLines(shape((data ?? []) as Record<string, unknown>[], nm))
  }

  async function save(key: string, v: number | null, set: (n: number) => void) {
    if (v === null) return
    set(v)
    await supabase.from('settings').update({ value: v }).eq('key', key)
    flash('บันทึกแล้ว')
  }

  async function setStatus(id: number, status: string) {
    setLines((p) => p.map((l) => (l.id === id ? { ...l, status } : l)))
    await supabase.from('transfer_lines').update({ status }).eq('id', id)
  }

  const active = useMemo(() => lines.filter((l) => l.status !== 'ยกเลิก'), [lines])

  async function confirmRun() {
    if (!runId) return
    const drop = lines.filter((l) => l.status === 'ยกเลิก').map((l) => l.id)
    if (drop.length) await supabase.from('transfer_lines')
      .update({ status: 'ยกเลิก' }).in('id', drop)
    const { error } = await supabase.rpc('confirm_transfer_run', {
      p_run_id: runId,
      p_by: (await supabase.auth.getUser()).data.user?.id ?? null,
    })
    if (error) { setErr(error.message); return }
    await Promise.all([loadLines(runId), loadPending()])
    flash('ยืนยันแล้ว')
  }

  function exportRows() {
    if (!active.length) return
    const ws = XLSX.utils.json_to_sheet(active.map((l) => ({
      'ชั้นที่จับคู่': l.match_level,
      'ผจก.เขต': l.area,
      'สาขาต้นทาง (Class A)': l.from_name,
      'รหัสต้นทาง': l.from_plant,
      'DOH ต้นทาง': l.from_doh,
      'สาขาปลายทาง (Class B)': l.to_name,
      'รหัสปลายทาง': l.to_plant,
      'รหัสสินค้า': l.mat_code,
      'สินค้า': l.item_name,
      'จำนวนโอน': l.qty,
      'หน่วย': l.uom,
    })))
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'โอนข้ามคลาส')
    XLSX.writeFile(wb, `โอนข้ามคลาส_${snapshotDate.replace(/-/g, '')}.xlsx`)
  }

  const sum = useMemo(() => ({
    qty: active.reduce((s, l) => s + l.qty, 0),
    to: new Set(active.map((l) => l.to_plant)).size,
    from: new Set(active.map((l) => l.from_plant)).size,
    amphoe: active.filter((l) => l.match_level === 'อำเภอ').length,
  }), [active])

  return (
    <>
      <h2>โอนข้ามคลาส</h2>
      <p className="lede">
        เอาของเกินจากสาขาที่สินค้าเป็น Class A ไปเติมสาขาที่สินค้าเป็น Class B และของหมด
        แต่ยังขายได้ · จำกัดไม่เกินยอดขาย {days} วัน และไม่ข้ามเขต
      </p>

      <div className="card">
        <h3>เงื่อนไข</h3>
        <div className="row" style={{ gap: 24 }}>
          <span style={{ display: 'flex', gap: 9, alignItems: 'center' }}>
            <label>โอนได้ไม่เกิน</label>
            <StepNum value={days} step={5} min={5} max={90}
              onChange={(v) => save('transfer_b_max_days', v, setDays)} />
            <span style={{ fontSize: 13, color: 'var(--ink-3)' }}>วันของยอดขาย</span>
          </span>
          <span style={{ display: 'flex', gap: 9, alignItems: 'center' }}>
            <label>ขอบเขต</label>
            <select value={level}
              onChange={(e) => save('transfer_b_max_level', Number(e.target.value), setLevel)}>
              <option value={1}>อำเภอเดียวกันเท่านั้น</option>
              <option value={2}>ถึงจังหวัดเดียวกัน</option>
            </select>
          </span>
        </div>
        <p className="hint" style={{ margin: '14px 0 0' }}>
          ปลายทางต้องเป็น Class B · สต็อกเป็น 0 · ยังมียอดขาย ·
          ต้นทางใช้กติกาเดิม DOH เกินเกณฑ์และโอนแล้วยังพอถึงรอบหน้า ·
          ของที่หน้าโอนหลักเสนอไว้แล้วจะถูกหักออก ไม่เสนอซ้ำ
        </p>
      </div>

      {pending.length > 0 && (
        <div className="card">
          <h3>ของระหว่างโอน</h3>
          <p className="hint">ยืนยันแล้วยังไม่ได้รับ · กดรับของที่หน้าโอนหลัก</p>
          <div className="row" style={{ gap: 20 }}>
            <span>{pending.length} รายการ</span>
            <span>{pending.reduce((s, l) => s + l.qty, 0).toLocaleString()} ชิ้น</span>
            <span>{new Set(pending.map((l) => l.to_plant)).size} สาขาปลายทาง</span>
          </div>
        </div>
      )}

      <div className="card">
        <div className="row">
          <button className="btn" onClick={run} disabled={busy}>
            {busy ? 'กำลังคำนวณ…' : 'คำนวณรายการโอนข้ามคลาส'}
          </button>
          <span style={{ fontSize: 13, color: 'var(--ink-3)' }}>ใช้สต็อก ณ {snapshotDate}</span>
          {active.length > 0 && (
            <>
              <span style={{ flex: 1 }} />
              <button className="btn ghost" onClick={exportRows}>ดาวน์โหลดใบโอน</button>
              {active.some((l) => l.status === 'เสนอ') && (
                <button className="btn" onClick={confirmRun}>
                  ยืนยัน {active.filter((l) => l.status === 'เสนอ').length} รายการ
                </button>
              )}
            </>
          )}
        </div>
        {err && <div className="note bad" style={{ marginTop: 12 }}>{err}</div>}
        {runId && lines.length === 0 && !busy && (
          <div className="note" style={{ marginTop: 12 }}>
            ไม่มีคู่ที่โอนได้ — อาจเพราะของเกินถูกจองไปกับหน้าโอนหลักแล้ว
            หรือไม่มี Class B ที่ของหมดในอำเภอ/จังหวัดเดียวกับสาขาที่มีของเกิน
          </div>
        )}
      </div>

      {active.length > 0 && (
        <>
          <dl className="stats">
            <div className="stat"><dt>รายการ</dt><dd>{active.length}</dd></div>
            <div className="stat">
              <dt>รวมจำนวน</dt><dd>{sum.qty.toLocaleString()} <small>ชิ้น</small></dd>
            </div>
            <div className="stat"><dt>สาขาที่ได้ของ</dt><dd>{sum.to}</dd></div>
            <div className="stat">
              <dt>ในอำเภอ / จังหวัด</dt>
              <dd style={{ fontSize: 26 }}>
                {sum.amphoe} / {active.length - sum.amphoe}
              </dd>
            </div>
          </dl>

          <div className="tw">
            <table>
              <thead>
                <tr>
                  <th>ชั้น</th><th>สินค้า</th>
                  <th>ต้นทาง · Class A</th><th className="num">DOH</th>
                  <th>ปลายทาง · Class B</th><th className="num">ขาย/วัน</th>
                  <th className="num">โอน</th><th></th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.id} style={{ opacity: l.status === 'ยกเลิก' ? 0.4 : 1 }}>
                    <td>
                      <span className={`tag ${l.match_level === 'อำเภอ' ? 'ok' : ''}`}>
                        {l.match_level}
                      </span>
                    </td>
                    <td>{l.item_name}</td>
                    <td>{l.from_name}</td>
                    <td className="num" style={{ color: 'var(--oil)' }}>{l.from_doh}</td>
                    <td>{l.to_name}</td>
                    <td className="num" style={{ color: 'var(--ink-3)' }}>
                      {l.to_doh ?? '—'}
                    </td>
                    <td className="num"><strong>{l.qty}</strong></td>
                    <td>
                      {l.status === 'ยืนยัน' ? (
                        <span className="tag ok">สั่งแล้ว</span>
                      ) : (
                        <button className="btn ghost"
                          onClick={() => setStatus(l.id, l.status === 'ยกเลิก' ? 'เสนอ' : 'ยกเลิก')}>
                          {l.status === 'ยกเลิก' ? 'คืนค่า' : 'ตัดออก'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="note" style={{ marginTop: 16 }}>
            การโอนแบบนี้ไม่ได้ลดของในเครือข่าย แต่ย้ายของไปอยู่ที่ที่ขายออก —
            DOH จะลดลงตามยอดขายที่เกิดขึ้นจริง และสาขาปลายทางกลับมามีของขาย
          </div>
        </>
      )}

      {msg && <div className="note good" style={{ position: 'sticky', bottom: 16, marginTop: 14 }}>{msg}</div>}
    </>
  )
}
