import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { Picker, type Option } from './ui'

interface Station { plant_code: string; branch_name: string }
interface Member { plant_code: string; branch_name: string; province: string }
interface Group {
  group_id: string; name: string
  host_plant: string | null; host_name: string | null
  is_active: boolean; member_count: number; members: Member[]
}
interface Preview {
  plant_code: string; branch_name: string
  host_plant: string; host_name: string
  group_name: string; days_no_trip: number
}

export default function StationGroups() {
  const [stations, setStations] = useState<Station[]>([])
  const [groups, setGroups] = useState<Group[]>([])
  const [busy, setBusy] = useState(true)
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')
  const [q, setQ] = useState('')
  const [only, setOnly] = useState<'all' | 'host'>('all')
  const [adding, setAdding] = useState<string | null>(null)
  const [pick, setPick] = useState('')
  const [proxyOn, setProxyOn] = useState(true)
  const [tripDate, setTripDate] = useState(new Date().toISOString().slice(0, 10))
  const [preview, setPreview] = useState<Preview[]>([])

  useEffect(() => { void init() }, [])

  async function init() {
    setBusy(true)
    const [st, g, s] = await Promise.all([
      supabase.from('stations').select('plant_code, branch_name').eq('is_active', true),
      supabase.from('v_station_groups').select('*'),
      supabase.from('settings').select('value').eq('key', 'proxy_enabled').maybeSingle(),
    ])
    if (st.error) setErr(st.error.message)
    setStations(((st.data ?? []) as Station[])
      .sort((a, b) => a.plant_code.localeCompare(b.plant_code, 'th')))
    setGroups((g.data ?? []) as Group[])
    if (s.data) setProxyOn(Number(s.data.value) === 1)
    setBusy(false)
  }

  const flash = (t: string) => { setMsg(t); setTimeout(() => setMsg(''), 2000) }

  async function reload() {
    const { data } = await supabase.from('v_station_groups').select('*')
    setGroups((data ?? []) as Group[])
  }

  /** สาขานี้รับฝากให้ใครบ้าง */
  const hostOf = useMemo(() => {
    const m = new Map<string, { gid: string; members: Member[]; active: boolean }>()
    groups.forEach((g) => {
      if (g.host_plant) m.set(g.host_plant, {
        gid: g.group_id, members: g.members, active: g.is_active,
      })
    })
    return m
  }, [groups])

  /** สาขานี้ถูกฝากไว้ที่ใคร — ใช้กันไม่ให้ฝากซ้อนกันหลายชั้น */
  const hostedBy = useMemo(() => {
    const m = new Map<string, string>()
    groups.forEach((g) => {
      if (!g.host_plant) return
      g.members.forEach((x) => m.set(x.plant_code, g.host_plant as string))
    })
    return m
  }, [groups])

  const nameOf = useMemo(
    () => new Map(stations.map((s) => [s.plant_code, s.branch_name])), [stations])

  async function toggleProxy(v: boolean) {
    setProxyOn(v)
    await supabase.from('settings').update({ value: v ? 1 : 0 }).eq('key', 'proxy_enabled')
    flash(v ? 'เปิดการฝากของแล้ว' : 'ปิดการฝากของแล้ว')
  }

  /** เพิ่มสาขาที่ฝากได้ — สร้างกลุ่มให้อัตโนมัติถ้ายังไม่มี */
  async function addMember(host: string, member: string) {
    setErr('')
    if (host === member) { setErr('เลือกสาขาเดียวกับตัวเองไม่ได้'); return }
    if (hostedBy.has(host)) {
      setErr(`${nameOf.get(host)} ถูกฝากไว้ที่ ${nameOf.get(hostedBy.get(host) as string)} อยู่แล้ว จะเป็นจุดรับฝากไม่ได้`)
      return
    }
    if (hostOf.has(member)) {
      setErr(`${nameOf.get(member)} เป็นจุดรับฝากให้สาขาอื่นอยู่ ต้องเอาออกก่อน`)
      return
    }
    if (hostedBy.has(member)) {
      setErr(`${nameOf.get(member)} ถูกฝากไว้ที่ ${nameOf.get(hostedBy.get(member) as string)} อยู่แล้ว`)
      return
    }

    let gid = hostOf.get(host)?.gid
    if (!gid) {
      const { data, error } = await supabase.from('station_groups')
        .insert({ name: nameOf.get(host) ?? host, host_plant: host })
        .select('group_id').single()
      if (error) { setErr(error.message); return }
      gid = data.group_id as string
    }
    const { error } = await supabase.from('station_group_members')
      .insert({ group_id: gid, plant_code: member })
    if (error) { setErr(error.message); return }
    setPick(''); setAdding(null)
    await reload(); flash('เพิ่มแล้ว')
  }

  async function removeMember(host: string, member: string) {
    const g = hostOf.get(host)
    if (!g) return
    await supabase.from('station_group_members')
      .delete().eq('group_id', g.gid).eq('plant_code', member)
    // ไม่เหลือสมาชิกแล้วลบกลุ่มทิ้ง ไม่ให้รกฐานข้อมูล
    if (g.members.length <= 1) {
      await supabase.from('station_groups').delete().eq('group_id', g.gid)
    }
    await reload()
  }

  async function toggleGroup(host: string) {
    const g = hostOf.get(host)
    if (!g) return
    await supabase.from('station_groups')
      .update({ is_active: !g.active }).eq('group_id', g.gid)
    await reload()
  }

  async function runPreview() {
    const { data, error } = await supabase.rpc('proxy_preview', { p_trip_date: tripDate })
    if (error) { setErr(error.message); return }
    setPreview((data ?? []) as Preview[])
  }

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase()
    return stations.filter((s) => {
      if (only === 'host' && !hostOf.has(s.plant_code)) return false
      if (t && !`${s.plant_code} ${s.branch_name}`.toLowerCase().includes(t)) return false
      return true
    })
  }, [stations, q, only, hostOf])

  const opts: Option[] = useMemo(
    () => stations.map((s) => ({ value: s.plant_code, label: s.branch_name })), [stations])

  const totalPairs = useMemo(
    () => groups.reduce((n, g) => n + (g.is_active ? g.member_count : 0), 0), [groups])

  if (busy) return <><h2>กลุ่มสถานี</h2><div className="note">กำลังโหลด…</div></>

  return (
    <>
      <h2>กลุ่มสถานี</h2>
      <p className="lede">
        กดที่สาขาไหนก็ได้ แล้วเพิ่มสาขาที่ฝากของไว้ที่นั่นได้ ·
        รอบไหนที่รถเข้าสาขาหลักแต่ไม่เข้าสาขาที่ฝาก ระบบจะคำนวณให้ด้วย
      </p>

      {err && <div className="note bad">{err}</div>}

      <dl className="stats">
        <div className="stat"><dt>สาขาทั้งหมด</dt><dd>{stations.length}</dd></div>
        <div className="stat">
          <dt>จุดรับฝาก</dt>
          <dd style={{ color: 'var(--ok)' }}>{hostOf.size}</dd>
        </div>
        <div className="stat">
          <dt>คู่ที่ฝากได้</dt>
          <dd style={{ color: 'var(--oil)' }}>{totalPairs}</dd>
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
            onChange={(e) => setQ(e.target.value)} style={{ width: 260 }} />
          <button className={`btn ${only === 'all' ? '' : 'ghost'}`}
            style={{ padding: '6px 14px', fontSize: 13.5 }}
            onClick={() => setOnly('all')}>ทั้งหมด</button>
          <button className={`btn ${only === 'host' ? '' : 'ghost'}`}
            style={{ padding: '6px 14px', fontSize: 13.5 }}
            onClick={() => setOnly('host')}>เฉพาะจุดรับฝาก {hostOf.size}</button>
          <span style={{ fontSize: 13, color: 'var(--ink-3)' }}>{shown.length} รายการ</span>
        </div>

        <div className="tw" style={{ border: 0, borderTop: '1px solid var(--rule)', maxHeight: '60vh' }}>
          <table>
            <thead>
              <tr>
                <th style={{ width: 250 }}>สาขา</th>
                <th>สาขาที่ฝากของไว้ที่นี่</th>
                <th style={{ width: 120 }}></th>
              </tr>
            </thead>
            <tbody>
              {shown.map((s) => {
                const host = hostOf.get(s.plant_code)
                const via = hostedBy.get(s.plant_code)
                return (
                  <tr key={s.plant_code}>
                    <td>
                      <span style={{ fontWeight: host ? 600 : 400 }}>{s.branch_name}</span>
                      {via && (
                        <div style={{ fontSize: 11.5, color: 'var(--oil)', marginTop: 2 }}>
                          ฝากไว้ที่ {nameOf.get(via) ?? via}
                        </div>
                      )}
                      {host && !host.active && (
                        <span className="tag" style={{ marginLeft: 6 }}>ปิดอยู่</span>
                      )}
                    </td>

                    <td>
                      <div className="row" style={{ gap: 6 }}>
                        {(host?.members ?? []).map((m) => (
                          <span key={m.plant_code} className="tag ok"
                            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                            {m.branch_name}
                            <button
                              style={{
                                border: 0, background: 'none', cursor: 'pointer', padding: 0,
                                color: 'inherit', fontSize: 13, lineHeight: 1, opacity: 0.7,
                              }}
                              title="เอาออก"
                              onClick={() => void removeMember(s.plant_code, m.plant_code)}>×</button>
                          </span>
                        ))}

                        {adding === s.plant_code ? (
                          <span className="row" style={{ gap: 6 }}>
                            <Picker options={opts.filter((o) =>
                              o.value !== s.plant_code
                              && !hostOf.has(o.value)
                              && !hostedBy.has(o.value))}
                              value={pick} onChange={setPick}
                              placeholder="เลือกสาขา" width={230} />
                            <button className="btn" style={{ padding: '5px 13px', fontSize: 13 }}
                              disabled={!pick}
                              onClick={() => void addMember(s.plant_code, pick)}>เพิ่ม</button>
                            <button className="btn ghost" style={{ padding: '5px 11px', fontSize: 13 }}
                              onClick={() => { setAdding(null); setPick('') }}>ยกเลิก</button>
                          </span>
                        ) : (
                          !via && (
                            <button className="btn ghost"
                              style={{ padding: '4px 12px', fontSize: 13 }}
                              onClick={() => { setAdding(s.plant_code); setPick(''); setErr('') }}>
                              + เพิ่มสาขาที่ฝากได้
                            </button>
                          )
                        )}
                      </div>
                    </td>

                    <td>
                      {host && (
                        <button className="btn ghost" style={{ padding: '4px 12px', fontSize: 13 }}
                          onClick={() => void toggleGroup(s.plant_code)}>
                          {host.active ? 'ปิดใช้' : 'เปิดใช้'}
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
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
        ฝากซ้อนกันหลายชั้นไม่ได้ — สาขาที่ถูกฝากไว้ที่อื่นแล้ว จะเป็นจุดรับฝากให้คนอื่นไม่ได้
        เพราะของจะไปไม่ถึง · บรรทัดที่เกิดจากการฝากมีป้าย <strong>ฝากที่ …</strong> ในหน้าคำนวณ
      </div>

      {msg && <div className="note good" style={{ position: 'sticky', bottom: 16, marginTop: 14 }}>{msg}</div>}
    </>
  )
}
