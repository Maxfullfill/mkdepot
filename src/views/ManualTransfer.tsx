import { useEffect, useMemo, useState } from 'react'
import * as XLSX from 'xlsx'
import { supabase } from '../lib/supabase'
import { Picker, StepNum, type Option } from './ui'

interface Look {
  plant_code: string; branch_name: string; station_group: string
  province: string; district: string; area: string
  mat_code: string; item_name: string; uom: string | null; class_fix: string | null
  stock_pcs: number; pending_out: number; pending_in: number
  available: number; sales_per_day: number; cover_day: number
  keep_pcs: number; doh: number | null; can_give: number
}
interface Line {
  id: number; mat_code: string; from_plant: string; to_plant: string
  qty: number; uom: string | null; status: string
  match_level: string | null; note: string | null
  from_stock: number; from_doh: number; to_stock: number; to_doh: number
  from_name?: string; to_name?: string; item_name?: string
}
interface AddResult {
  ok: boolean; error?: string; confirm?: boolean
  warnings?: string[]; id?: number; match_level?: string
}

export default function ManualTransfer() {
  const [stOpts, setStOpts] = useState<Option[]>([])
  const [itOpts, setItOpts] = useState<Option[]>([])

  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [mat, setMat] = useState('')
  const [qty, setQty] = useState<number | null>(1)
  const [note, setNote] = useState('')

  const [fInfo, setFInfo] = useState<Look | null>(null)
  const [tInfo, setTInfo] = useState<Look | null>(null)
  const [warn, setWarn] = useState<string[]>([])
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)

  const [runId, setRunId] = useState<string | null>(null)
  const [lines, setLines] = useState<Line[]>([])

  useEffect(() => { void init() }, [])

  async function init() {
    const [st, it] = await Promise.all([
      supabase.from('stations').select('plant_code, branch_name')
        .eq('is_active', true).order('branch_name'),
      supabase.from('items').select('mat_code, template_descr, desc_th, desc_en')
        .eq('is_active', true).order('mat_code'),
    ])
    setStOpts((st.data ?? []).map((r) => ({
      value: r.plant_code as string,
      label: (r.branch_name as string) || (r.plant_code as string),
    })))
    setItOpts((it.data ?? []).map((r) => ({
      value: r.mat_code as string,
      label: (r.template_descr ?? r.desc_th ?? r.desc_en ?? r.mat_code) as string,
    })))
    await loadRun()
  }

  /** ใบโอนกำหนดเองของวันนี้ ถ้ามีอยู่แล้วโหลดมาต่อ */
  async function loadRun() {
    const { data } = await supabase.from('transfer_runs')
      .select('run_id').eq('kind', 'M')
      .eq('run_date', new Date().toISOString().slice(0, 10))
      .order('created_at', { ascending: false }).limit(1).maybeSingle()
    if (data?.run_id) { setRunId(data.run_id as string); await loadLines(data.run_id as string) }
  }

  async function loadLines(id: string) {
    const [{ data }, { data: st }] = await Promise.all([
      supabase.from('transfer_lines').select('*, items(template_descr, desc_th)')
        .eq('run_id', id).order('id', { ascending: false }),
      supabase.from('stations').select('plant_code, branch_name'),
    ])
    const nm = new Map((st ?? []).map((s) => [s.plant_code as string, s.branch_name as string]))
    setLines((data ?? []).map((r: Record<string, unknown>) => {
      const it = r.items as { template_descr: string | null; desc_th: string | null } | null
      const l = r as unknown as Line
      return {
        ...l,
        from_name: nm.get(l.from_plant) ?? l.from_plant,
        to_name: nm.get(l.to_plant) ?? l.to_plant,
        item_name: it?.template_descr ?? it?.desc_th ?? l.mat_code,
      }
    }))
  }

  /** ดึงข้อมูลสต็อกทั้งสองฝั่งทันทีที่เลือกครบ */
  useEffect(() => {
    setWarn([]); setErr('')
    if (!mat) { setFInfo(null); setTInfo(null); return }
    if (from) supabase.rpc('stock_lookup', { p_plant: from, p_mat: mat })
      .then(({ data }) => setFInfo(data as Look))
    else setFInfo(null)
    if (to) supabase.rpc('stock_lookup', { p_plant: to, p_mat: mat })
      .then(({ data }) => setTInfo(data as Look))
    else setTInfo(null)
  }, [from, to, mat])

  const flash = (t: string) => { setMsg(t); setTimeout(() => setMsg(''), 2200) }

  async function add(force = false) {
    if (!from || !to || !mat || !qty) return
    setBusy(true); setErr('')
    const { data, error } = await supabase.rpc('add_manual_transfer', {
      p_from: from, p_to: to, p_mat: mat, p_qty: qty,
      p_note: note || null, p_force: force,
      p_by: (await supabase.auth.getUser()).data.user?.id ?? null,
    })
    setBusy(false)
    if (error) { setErr(error.message); return }
    const r = data as AddResult
    if (!r.ok && r.confirm) { setWarn(r.warnings ?? []); return }
    if (!r.ok) { setErr(r.error ?? 'เพิ่มไม่สำเร็จ'); return }
    setWarn([]); setNote(''); setQty(1)
    flash(`เพิ่มแล้ว · จับคู่ระดับ${r.match_level}`)
    await loadRun()
  }

  async function remove(id: number) {
    await supabase.from('transfer_lines').delete().eq('id', id)
    if (runId) await loadLines(runId)
  }

  async function confirmAll() {
    if (!runId) return
    const { error } = await supabase.rpc('confirm_transfer_run', {
      p_run_id: runId,
      p_by: (await supabase.auth.getUser()).data.user?.id ?? null,
    })
    if (error) { setErr(error.message); return }
    flash('ยืนยันแล้ว — ระบบจะหักของจากต้นทางและบวกให้ปลายทาง')
    await loadLines(runId)
  }

  function exportRows() {
    const rows = lines.filter((l) => l.status !== 'ยกเลิก')
    if (!rows.length) return
    const ws = XLSX.utils.json_to_sheet(rows.map((l) => ({
      'ชั้นที่จับคู่': l.match_level,
      'สาขาต้นทาง': l.from_name, 'รหัสต้นทาง': l.from_plant,
      'คงเหลือต้นทาง': l.from_stock, 'DOH ต้นทาง': l.from_doh,
      'สาขาปลายทาง': l.to_name, 'รหัสปลายทาง': l.to_plant,
      'คงเหลือปลายทาง': l.to_stock, 'DOH ปลายทาง': l.to_doh,
      'รหัสสินค้า': l.mat_code, 'สินค้า': l.item_name,
      'จำนวนโอน': l.qty, 'หน่วย': l.uom,
      'หมายเหตุ': l.note, 'สถานะ': l.status,
    })))
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'โอนกำหนดเอง')
    XLSX.writeFile(wb, `โอนกำหนดเอง_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.xlsx`)
  }

  const active = useMemo(() => lines.filter((l) => l.status !== 'ยกเลิก'), [lines])
  const ready = !!(from && to && mat && qty && qty > 0)

  const card = (i: Look | null, role: 'ต้นทาง' | 'ปลายทาง') => {
    if (!i) return (
      <div className="card" style={{ margin: 0, background: 'var(--wash)' }}>
        <h3>{role}</h3>
        <p className="hint" style={{ margin: 0 }}>เลือกสาขาและสินค้าเพื่อดูข้อมูล</p>
      </div>
    )
    const give = role === 'ต้นทาง'
    return (
      <div className="card" style={{ margin: 0 }}>
        <div className="spread">
          <h3>{role}</h3>
          <span className={`tag ${i.station_group === 'OLP' ? 'oil' : ''}`}>
            {i.station_group}
          </span>
        </div>
        <p style={{ margin: '0 0 12px', fontWeight: 600 }}>{i.branch_name}</p>
        <table>
          <tbody>
            <tr><td>คงเหลือ</td>
              <td className="num"><strong>{i.stock_pcs}</strong></td>
              <td style={{ color: 'var(--ink-3)', fontSize: 12.5 }}>{i.uom}</td></tr>
            <tr><td>ขาย/วัน</td>
              <td className="num">{i.sales_per_day}</td><td /></tr>
            <tr><td>DOH</td>
              <td className="num" style={{
                color: (i.doh ?? 0) > 25 ? 'var(--oil)' : undefined,
              }}>{i.doh ?? '—'}</td>
              <td style={{ color: 'var(--ink-3)', fontSize: 12.5 }}>วัน</td></tr>
            {give ? (
              <>
                <tr><td>กำลังโอนออกอยู่</td>
                  <td className="num" style={{ color: i.pending_out ? 'var(--oil)' : undefined }}>
                    {i.pending_out || '—'}</td><td /></tr>
                <tr style={{ background: 'var(--wash)' }}>
                  <td><strong>โอนได้สูงสุด</strong></td>
                  <td className="num"><strong style={{ fontSize: 16 }}>{i.available}</strong></td>
                  <td style={{ color: 'var(--ink-3)', fontSize: 12.5 }}>ชิ้น</td></tr>
                <tr><td>ส่วนที่เหลือใช้จริง</td>
                  <td className="num" style={{ color: 'var(--ok)' }}>{i.can_give}</td>
                  <td style={{ color: 'var(--ink-3)', fontSize: 12.5 }}>
                    เก็บไว้ขาย {i.keep_pcs}
                  </td></tr>
              </>
            ) : (
              <>
                <tr><td>กำลังโอนมาแล้ว</td>
                  <td className="num" style={{ color: i.pending_in ? 'var(--oil)' : undefined }}>
                    {i.pending_in || '—'}</td><td /></tr>
                <tr><td>ควรมีถึงรอบหน้า</td>
                  <td className="num">{i.keep_pcs}</td>
                  <td style={{ color: 'var(--ink-3)', fontSize: 12.5 }}>ชิ้น</td></tr>
                <tr><td>คลาสสินค้า</td>
                  <td className="num">{i.class_fix ?? '—'}</td><td /></tr>
              </>
            )}
          </tbody>
        </table>
      </div>
    )
  }

  return (
    <>
      <h2>โอนกำหนดเอง</h2>
      <p className="lede">
        เลือกต้นทาง ปลายทาง และสินค้าเอง · บันทึกลงระบบเดียวกับการโอนปกติ
        จึงนับเป็นของระหว่างโอนและหักจากยอดเบิกให้อัตโนมัติ
      </p>

      <div className="card">
        <h3>สร้างรายการโอน</h3>
        <div className="row" style={{ marginBottom: 14 }}>
          <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <label style={{ color: 'var(--ink-3)', fontSize: 13 }}>จาก</label>
            <Picker options={stOpts} value={from} onChange={setFrom}
              placeholder="สาขาต้นทาง" width={230} />
          </span>
          <span style={{ color: 'var(--ink-3)' }}>→</span>
          <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <label style={{ color: 'var(--ink-3)', fontSize: 13 }}>ไป</label>
            <Picker options={stOpts} value={to} onChange={setTo}
              placeholder="สาขาปลายทาง" width={230} />
          </span>
          <Picker options={itOpts} value={mat} onChange={setMat}
            placeholder="สินค้า" width={280} />
          <StepNum value={qty} step={1} min={1}
            max={fInfo?.available ?? undefined} onChange={setQty} />
          <input type="text" placeholder="หมายเหตุ" value={note}
            onChange={(e) => setNote(e.target.value)} style={{ width: 180 }} />
          <button className="btn" onClick={() => void add(false)} disabled={!ready || busy}>
            {busy ? 'กำลังเพิ่ม…' : 'เพิ่มรายการ'}
          </button>
        </div>

        {err && <div className="note bad" style={{ marginBottom: 12 }}>{err}</div>}

        {warn.length > 0 && (
          <div className="note bad" style={{ marginBottom: 12 }}>
            <strong>ต้องยืนยันก่อน</strong>
            {warn.map((w, i) => <div key={i}>· {w}</div>)}
            <div className="row" style={{ marginTop: 10 }}>
              <button className="btn" onClick={() => void add(true)}>ยืนยัน เพิ่มเลย</button>
              <button className="btn ghost" onClick={() => setWarn([])}>ยกเลิก</button>
            </div>
          </div>
        )}

        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 14,
        }}>
          {card(fInfo, 'ต้นทาง')}
          {card(tInfo, 'ปลายทาง')}
        </div>
      </div>

      {active.length > 0 && (
        <>
          <dl className="stats">
            <div className="stat"><dt>รายการ</dt><dd>{active.length}</dd></div>
            <div className="stat">
              <dt>รวมจำนวน</dt>
              <dd>{active.reduce((s, l) => s + l.qty, 0).toLocaleString()} <small>ชิ้น</small></dd>
            </div>
            <div className="stat">
              <dt>สาขาต้นทาง</dt>
              <dd>{new Set(active.map((l) => l.from_plant)).size}</dd>
            </div>
            <div className="stat">
              <dt>ยังไม่ยืนยัน</dt>
              <dd style={{ color: active.some((l) => l.status === 'เสนอ') ? 'var(--oil)' : 'var(--ok)' }}>
                {active.filter((l) => l.status === 'เสนอ').length}
              </dd>
            </div>
          </dl>

          <div className="card" style={{ padding: 0 }}>
            <div className="row" style={{ padding: '16px 22px 12px' }}>
              <h3 style={{ margin: 0 }}>ใบโอนวันนี้</h3>
              <span style={{ flex: 1 }} />
              <button className="btn ghost" onClick={exportRows}>ดาวน์โหลดใบโอน</button>
              {active.some((l) => l.status === 'เสนอ') && (
                <button className="btn" onClick={confirmAll}>
                  ยืนยัน {active.filter((l) => l.status === 'เสนอ').length} รายการ
                </button>
              )}
            </div>

            <div className="tw" style={{ border: 0, borderTop: '1px solid var(--rule)' }}>
              <table>
                <thead>
                  <tr>
                    <th>ชั้น</th><th>สินค้า</th>
                    <th>ต้นทาง</th><th className="num">DOH</th>
                    <th>ปลายทาง</th><th className="num">DOH</th>
                    <th className="num">โอน</th><th>หมายเหตุ</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {active.map((l) => (
                    <tr key={l.id}>
                      <td>
                        <span className={`tag ${l.match_level === 'อำเภอ' ? 'ok'
                          : l.match_level === 'ข้ามเขต' ? 'alarm' : ''}`}>
                          {l.match_level}
                        </span>
                      </td>
                      <td>{l.item_name}</td>
                      <td>{l.from_name}</td>
                      <td className="num" style={{ color: 'var(--oil)' }}>{l.from_doh ?? '—'}</td>
                      <td>{l.to_name}</td>
                      <td className="num">{l.to_doh ?? '—'}</td>
                      <td className="num"><strong>{l.qty}</strong></td>
                      <td style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>{l.note}</td>
                      <td>
                        {l.status === 'ยืนยัน' ? (
                          <span className="tag ok">สั่งแล้ว</span>
                        ) : (
                          <button className="btn ghost" style={{ padding: '4px 12px', fontSize: 13 }}
                            onClick={() => void remove(l.id)}>ลบ</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="note" style={{ marginTop: 14 }}>
            กดยืนยันแล้วระบบจะนับเป็นของระหว่างโอนทันที — หักจากต้นทาง บวกให้ปลายทาง
            และหักออกจากยอดที่ต้องเบิกจากคลัง · กดรับของได้ที่หน้าโอนเกลี่ยสินค้า
          </div>
        </>
      )}

      {msg && <div className="note good" style={{ position: 'sticky', bottom: 16, marginTop: 14 }}>{msg}</div>}
    </>
  )
}
