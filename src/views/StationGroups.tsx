import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { Picker, type Option } from './ui'

interface Host {
  host_plant: string; host_name: string
  priority: number; is_active: boolean
}
interface Row {
  plant_code: string; branch_name: string
  hosts: Host[]; host_count: number; serves_count: number
}
interface Preview {
  plant_code: string; branch_name: string
  host_plant: string; host_name: string
  days_no_trip: number
}

export default function StationGroups() {
  const [rows, setRows] = useState<Row[]>([])
  const [busy, setBusy] = useState(true)
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')
  const [q, setQ] = useState('')
  const [only, setOnly] = useState<'all' | 'set'>('all')
  const [adding, setAdding] = useState<string | null>(null)
  const [pick, setPick] = useState('')
  const [proxyOn, setProxyOn] = useState(true)
  const [tripDate, setTripDate] = useState(new Date().toISOString().slice(0, 10))
  const [preview, setPreview] = useState<Preview[]>([])

  useEffect(() => { void init() }, [])

  async function init() {
    setBusy(true)
    const [r, s] = await Promise.all([
      supabase.from('v_proxy_list').select('*'),
      supabase.from('settings').select('value').eq('key', 'proxy_enabled').maybeSingle(),
    ])
    if (r.error) setErr(r.error.message)
    setRows((r.data ?? []) as Row[])
    if (s.data) setProxyOn(Number(s.data.value) === 1)
    setBusy(false)
  }

  const flash = (t: string) => { setMsg(t); setTimeout(() => setMsg(''), 2000) }

  async function reload() {
    const { data } = await supabase.from('v_proxy_list').select('*')
    setRows((data ?? []) as Row[])
  }

  async function toggleProxy(v: boolean) {
    setProxyOn(v)
    await supabase.from('settings').update({ value: v ? 1 : 0 }).eq('key', 'proxy_enabled')
    flash(v ? 'เปิดการฝากของแล้ว' : 'ปิดการฝากของแล้ว')
  }

  /** เพิ่มจุดที่ฝากได้ ลำดับต่อจากที่มีอยู่ */
  async function addHost(plant: string, host: string) {
    setErr('')
    const cur = rows.find((r) => r.plant_code === plant)
    const next = (cur?.hosts.length ?? 0) + 1
    const { error } = await supabase.from('station_proxy')
      .insert({ plant_code: plant, host_plant: host, priority: next })
    if (error) { setErr(error.message); return }
    setPick(''); setAdding(null)
    await reload(); flash('เพิ่มจุดฝากแล้ว')
  }

  async function removeHost(plant: string, host: string) {
    await supabase.from('station_proxy').delete()
      .eq('plant_code', plant).eq('host_plant', host)
    await reload()
  }

  /** เลื่อนลำดับความสะดวก — ตัวที่ลำดับดีกว่าถูกเลือกก่อนเมื่อรถเข้าหลายจุด */
  async function moveUp(plant: string, host: string) {
    const r = rows.find((x) => x.plant_code === plant)
    if (!r) return
    const i = r.hosts.findIndex((h) => h.host_plant === host)
    if (i <= 0) return
    const a = r.hosts[i], b = r.hosts[i - 1]
    await Promise.all([
      supabase.from('station_proxy').update({ priority: b.priority })
        .eq('plant_code', plant).eq('host_plant', a.host_plant),
      supabase.from('station_proxy').update({ priority: a.priority })
        .eq('plant_code', plant).eq('host_plant', b.host_plant),
    ])
    await reload()
  }

  async function runPreview() {
    const { data, error } = await supabase.rpc('proxy_preview', { p_trip_date: tripDate })
    if (error) { setErr(error.message); return }
    setPreview((data ?? []) as Preview[])
  }

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase()
    return rows.filter((r) => {
      if (only === 'set' && r.host_count === 0) return false
      if (t && !`${r.plant_code} ${r.branch_name}`.toLowerCase().includes(t)) return false
      return true
    })
  }, [rows, q, only])

  const opts: Option[] = useMemo(
    () => rows.map((r) => ({ value: r.plant_code, label: r.branch_name })), [rows])

  const stat = useMemo(() => ({
    set: rows.filter((r) => r.host_count > 0).length,
    pairs: rows.reduce((n, r) => n + r.host_count, 0),
    serves: rows.filter((r) => r.serves_count > 0).length,
  }), [rows])

  if (busy) return <><h2>กลุ่มสถานี</h2><div className="note">กำลังโหลด…</div></>

  return (
    <>
      <h2>กลุ่มสถานี</h2>
      <p className="lede">
        กำหนดว่าสาขาไหนฝากของไว้ที่ไหนได้บ้าง · ใส่ได้หลายจุด
        รอบไหนรถเข้าจุดไหน ระบบเลือกจุดนั้นให้เอง
      </p>

      {err && <div className="note bad">{err}</div>}

      <dl className="stats">
        <div className="stat"><dt>สาขาทั้งหมด</dt><dd>{rows.length}</dd></div>
        <div className="stat">
          <dt>สาขาที่ตั้งจุดฝากแล้ว</dt>
          <dd style={{ color: 'var(--ok)' }}>{stat.set}</dd>
        </div>
        <div className="stat">
          <dt>จุดที่รับฝากให้คนอื่น</dt>
          <dd style={{ color: 'var(--oil)' }}>{stat.serves}</dd>
        </div>
        <div className="stat">
          <dt>การฝากของ</dt>
          <dd style={{ fontSize: 20, color: proxyOn ? 'var(--ok)' : 'var(--ink-3)' }}>
            {proxyOn ? 'เปิดอยู่' : 'ปิดอยู่'}
          </dd>
        </div>
      </dl>

      <div className="card">
        <div className="spread">
          <div>
            <h3>เปิดใช้การฝากของ</h3>
            <p className="hint" style={{ marginBottom: 0 }}>
              ปิดเมื่อไหร่ ระบบจะคำนวณเฉพาะสาขาที่รถเข้าตรงเท่านั้น เหมือนเดิม
            </p>
          </div>
          <label className="sw" style={{ marginTop: 4 }}>
            <input type="checkbox" checked={proxyOn}
              onChange={(e) => void toggleProxy(e.target.checked)} />
            <span />
          </label>
        </div>
      </div>

      <div className="card" style={{ padding: 0 }}>
        <div className="row" style={{ padding: '18px 22px 14px' }}>
          <input type="text" placeholder="ค้นหาสาขา" value={q}
            onChange={(e) => setQ(e.target.value)} style={{ width: 250 }} />
          <button className={`btn ${only === 'all' ? '' : 'ghost'}`}
            style={{ padding: '6px 14px', fontSize: 13.5 }}
            onClick={() => setOnly('all')}>ทั้งหมด</button>
          <button className={`btn ${only === 'set' ? '' : 'ghost'}`}
            style={{ padding: '6px 14px', fontSize: 13.5 }}
            onClick={() => setOnly('set')}>ตั้งแล้ว {stat.set}</button>
          <span style={{ fontSize: 13, color: 'var(--ink-3)' }}>{shown.length} รายการ</span>
        </div>

        <div className="tw" style={{ border: 0, borderTop: '1px solid var(--rule)', maxHeight: '58vh' }}>
          <table>
            <thead>
              <tr>
                <th style={{ width: 260 }}>สาขาที่ฝากของ</th>
                <th>ฝากไว้ที่สาขาไหนได้บ้าง · เรียงตามความสะดวก</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.plant_code}>
                  <td>
                    <span style={{ fontWeight: r.host_count ? 600 : 400 }}>{r.branch_name}</span>
                    {r.serves_count > 0 && (
                      <div style={{ fontSize: 11.5, color: 'var(--oil)', marginTop: 2 }}>
                        รับฝากให้ {r.serves_count} สาขา
                      </div>
                    )}
                  </td>
                  <td>
                    <div className="row" style={{ gap: 6 }}>
                      {r.hosts.map((h, i) => (
                        <span key={h.host_plant} className="tag ok"
                          style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                          <span style={{ opacity: .6, fontSize: 10.5 }}>{i + 1}</span>
                          {h.host_name}
                          {i > 0 && (
                            <button title="เลื่อนขึ้น"
                              style={{
                                border: 0, background: 'none', cursor: 'pointer', padding: 0,
                                color: 'inherit', fontSize: 11, lineHeight: 1, opacity: .65,
                              }}
                              onClick={() => void moveUp(r.plant_code, h.host_plant)}>▲</button>
                          )}
                          <button title="เอาออก"
                            style={{
                              border: 0, background: 'none', cursor: 'pointer', padding: 0,
                              color: 'inherit', fontSize: 13, lineHeight: 1, opacity: .7,
                            }}
                            onClick={() => void removeHost(r.plant_code, h.host_plant)}>×</button>
                        </span>
                      ))}

                      {adding === r.plant_code ? (
                        <span className="row" style={{ gap: 6 }}>
                          <Picker options={opts.filter((o) =>
                            o.value !== r.plant_code
                            && !r.hosts.some((h) => h.host_plant === o.value))}
                            value={pick} onChange={setPick}
                            placeholder="เลือกจุดที่ฝากได้" width={230} />
                          <button className="btn" style={{ padding: '5px 13px', fontSize: 13 }}
                            disabled={!pick}
                            onClick={() => void addHost(r.plant_code, pick)}>เพิ่ม</button>
                          <button className="btn ghost" style={{ padding: '5px 11px', fontSize: 13 }}
                            onClick={() => { setAdding(null); setPick('') }}>ยกเลิก</button>
                        </span>
                      ) : (
                        <button className="btn ghost"
                          style={{ padding: '4px 12px', fontSize: 13 }}
                          onClick={() => { setAdding(r.plant_code); setPick(''); setErr('') }}>
                          + เพิ่มจุดที่ฝากได้
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div className="spread">
          <div>
            <h3>ทดลองดูผล</h3>
            <p className="hint" style={{ marginBottom: 0 }}>
              เลือกวันที่รถออก แล้วดูว่ารอบนั้นมีสาขาไหนจะได้ของจากการฝากบ้าง
            </p>
          </div>
          <div className="row" style={{ gap: 10 }}>
            <input type="date" value={tripDate} onChange={(e) => setTripDate(e.target.value)} />
            <button className="btn" onClick={() => void runPreview()}>ดูผล</button>
          </div>
        </div>

        {preview.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <p className="hint">
              {preview.length} สาขาจะได้ของในรอบนี้ทั้งที่รถไม่ได้เข้าโดยตรง
            </p>
            <div className="tw" style={{ maxHeight: '38vh' }}>
              <table>
                <thead>
                  <tr>
                    <th>สาขาที่ได้ของ</th><th>ฝากไว้ที่</th>
                    <th className="num">รถไม่เข้ามา</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.map((r, i) => (
                    <tr key={i}>
                      <td>{r.branch_name}</td>
                      <td>{r.host_name}</td>
                      <td className="num" style={{
                        color: r.days_no_trip > 14 ? 'var(--alarm)' : 'var(--ink-3)',
                      }}>
                        {r.days_no_trip > 9000 ? '—' : `${r.days_no_trip} วัน`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      <div className="note">
        ตัวเลขหน้าป้ายคือลำดับความสะดวก กดลูกศรเลื่อนขึ้นได้ ·
        ถ้ารอบนั้นรถเข้าหลายจุดพร้อมกัน ระบบเลือกจุดที่ลำดับดีที่สุด ·
        บรรทัดที่เกิดจากการฝากมีป้าย <strong>ฝากที่ …</strong> ในหน้าคำนวณ
      </div>

      {msg && <div className="note good" style={{ position: 'sticky', bottom: 16, marginTop: 14 }}>{msg}</div>}
    </>
  )
}
