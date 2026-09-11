import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { Picker, type Option } from './ui'

interface Member { plant_code: string; branch_name: string; province: string }
interface Group {
  group_id: string; name: string
  host_plant: string | null; host_name: string | null
  note: string | null; is_active: boolean
  member_count: number; members: Member[]
}
interface Preview {
  plant_code: string; branch_name: string
  host_plant: string; host_name: string
  group_name: string; days_no_trip: number
}

export default function StationGroups() {
  const [groups, setGroups] = useState<Group[]>([])
  const [stOpts, setStOpts] = useState<Option[]>([])
  const [busy, setBusy] = useState(true)
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')
  const [open, setOpen] = useState<string | null>(null)

  const [nName, setNName] = useState('')
  const [nHost, setNHost] = useState('')
  const [nNote, setNNote] = useState('')

  const [addTo, setAddTo] = useState<Record<string, string>>({})
  const [tripDate, setTripDate] = useState(new Date().toISOString().slice(0, 10))
  const [preview, setPreview] = useState<Preview[]>([])
  const [proxyOn, setProxyOn] = useState(true)

  useEffect(() => { void init() }, [])

  async function init() {
    setBusy(true)
    const [g, st, s] = await Promise.all([
      supabase.from('v_station_groups').select('*'),
      supabase.from('stations').select('plant_code, branch_name')
        .eq('is_active', true).order('branch_name'),
      supabase.from('settings').select('value').eq('key', 'proxy_enabled').maybeSingle(),
    ])
    if (g.error) setErr(g.error.message)
    setGroups((g.data ?? []) as Group[])
    setStOpts((st.data ?? []).map((r) => ({
      value: r.plant_code as string,
      label: (r.branch_name as string) || (r.plant_code as string),
    })))
    if (s.data) setProxyOn(Number(s.data.value) === 1)
    setBusy(false)
  }

  const flash = (t: string) => { setMsg(t); setTimeout(() => setMsg(''), 2200) }

  async function reload() {
    const { data } = await supabase.from('v_station_groups').select('*')
    setGroups((data ?? []) as Group[])
  }

  async function toggleProxy(v: boolean) {
    setProxyOn(v)
    await supabase.from('settings').update({ value: v ? 1 : 0 }).eq('key', 'proxy_enabled')
    flash(v ? 'เปิดการฝากของแล้ว' : 'ปิดการฝากของแล้ว')
  }

  async function createGroup() {
    if (!nName.trim() || !nHost) return
    const { error } = await supabase.from('station_groups').insert({
      name: nName.trim(), host_plant: nHost, note: nNote.trim() || null,
    })
    if (error) { setErr(error.message); return }
    setNName(''); setNHost(''); setNNote('')
    await reload(); flash('สร้างกลุ่มแล้ว')
  }

  async function addMember(gid: string) {
    const plant = addTo[gid]
    if (!plant) return
    const { error } = await supabase.from('station_group_members')
      .insert({ group_id: gid, plant_code: plant })
    if (error) { setErr(error.message); return }
    setAddTo((p) => ({ ...p, [gid]: '' }))
    await reload(); flash('เพิ่มสาขาแล้ว')
  }

  async function removeMember(gid: string, plant: string) {
    await supabase.from('station_group_members').delete()
      .eq('group_id', gid).eq('plant_code', plant)
    await reload()
  }

  async function setActive(gid: string, v: boolean) {
    await supabase.from('station_groups').update({ is_active: v }).eq('group_id', gid)
    await reload()
  }

  async function delGroup(gid: string, name: string) {
    if (!confirm(`ลบกลุ่ม "${name}" ทั้งกลุ่ม สมาชิกทั้งหมดจะถูกลบด้วย`)) return
    await supabase.from('station_groups').delete().eq('group_id', gid)
    await reload(); flash('ลบกลุ่มแล้ว')
  }

  async function runPreview() {
    const { data, error } = await supabase.rpc('proxy_preview', { p_trip_date: tripDate })
    if (error) { setErr(error.message); return }
    setPreview((data ?? []) as Preview[])
  }

  /** สาขาที่ยังไม่ได้อยู่กลุ่มไหนเลย ใช้เตือนว่ายังเหลืออีกเท่าไหร่ */
  const assigned = useMemo(() => {
    const s = new Set<string>()
    groups.forEach((g) => {
      g.members.forEach((m) => s.add(m.plant_code))
      if (g.host_plant) s.add(g.host_plant)
    })
    return s
  }, [groups])

  if (busy) return <><h2>กลุ่มสถานี</h2><div className="note">กำลังโหลด…</div></>

  return (
    <>
      <h2>กลุ่มสถานี</h2>
      <p className="lede">
        จัดกลุ่มสาขาเองได้ กำหนดสาขาทางผ่านเป็นหัวกลุ่ม ·
        รอบไหนที่รถเข้าหัวกลุ่มแต่ไม่เข้าสมาชิก ระบบจะคำนวณให้สมาชิกด้วยและระบุว่าฝากไว้ที่ไหน
      </p>

      {err && <div className="note bad">{err}</div>}

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

      <div className="card">
        <h3>สร้างกลุ่มใหม่</h3>
        <p className="hint">
          หัวกลุ่มคือสาขาที่รถผ่านประจำ ใช้เป็นจุดฝากของให้สมาชิกในกลุ่ม
        </p>
        <div className="row">
          <input type="text" placeholder="ชื่อกลุ่ม เช่น สายเพชรบุรี" value={nName}
            onChange={(e) => setNName(e.target.value)} style={{ width: 210 }} />
          <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <label style={{ color: 'var(--ink-3)', fontSize: 13 }}>หัวกลุ่ม</label>
            <Picker options={stOpts} value={nHost} onChange={setNHost}
              placeholder="สาขาทางผ่าน" width={250} />
          </span>
          <input type="text" placeholder="หมายเหตุ" value={nNote}
            onChange={(e) => setNNote(e.target.value)} style={{ width: 200 }} />
          <button className="btn" onClick={() => void createGroup()}
            disabled={!nName.trim() || !nHost}>สร้างกลุ่ม</button>
        </div>
      </div>

      <dl className="stats">
        <div className="stat"><dt>กลุ่มทั้งหมด</dt><dd>{groups.length}</dd></div>
        <div className="stat">
          <dt>กลุ่มที่เปิดใช้</dt>
          <dd style={{ color: 'var(--ok)' }}>{groups.filter((g) => g.is_active).length}</dd>
        </div>
        <div className="stat">
          <dt>สาขาที่อยู่ในกลุ่ม</dt><dd>{assigned.size}</dd>
        </div>
        <div className="stat">
          <dt>ยังไม่ได้จัดกลุ่ม</dt>
          <dd style={{ color: 'var(--ink-3)' }}>{Math.max(stOpts.length - assigned.size, 0)}</dd>
        </div>
      </dl>

      {groups.length === 0 ? (
        <div className="card">
          <h3>ยังไม่มีกลุ่ม</h3>
          <p className="hint" style={{ marginBottom: 0 }}>
            สร้างกลุ่มแรกด้านบน แล้วเพิ่มสาขาที่อยู่ระหว่างทางหรือใกล้เคียงเข้าไป
          </p>
        </div>
      ) : groups.map((g) => (
        <div className="card" key={g.group_id} style={{ opacity: g.is_active ? 1 : 0.55 }}>
          <div className="spread">
            <div>
              <h3 style={{ marginBottom: 4 }}>
                {g.name}
                {!g.is_active && <span className="tag" style={{ marginLeft: 8 }}>ปิดอยู่</span>}
              </h3>
              <p className="hint" style={{ marginBottom: 0 }}>
                ฝากของที่ <strong>{g.host_name ?? g.host_plant ?? '—'}</strong>
                {' · '}สมาชิก {g.member_count} สาขา
                {g.note && ` · ${g.note}`}
              </p>
            </div>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn ghost" style={{ padding: '6px 14px', fontSize: 13 }}
                onClick={() => setOpen(open === g.group_id ? null : g.group_id)}>
                {open === g.group_id ? 'ปิด' : 'จัดการสมาชิก'}
              </button>
              <button className="btn ghost" style={{ padding: '6px 14px', fontSize: 13 }}
                onClick={() => void setActive(g.group_id, !g.is_active)}>
                {g.is_active ? 'ปิดใช้' : 'เปิดใช้'}
              </button>
              <button className="btn ghost" style={{ padding: '6px 14px', fontSize: 13 }}
                onClick={() => void delGroup(g.group_id, g.name)}>ลบ</button>
            </div>
          </div>

          {open === g.group_id && (
            <div style={{ marginTop: 16 }}>
              <div className="row" style={{ marginBottom: 12 }}>
                <Picker options={stOpts.filter((o) => o.value !== g.host_plant
                  && !g.members.some((m) => m.plant_code === o.value))}
                  value={addTo[g.group_id] ?? ''}
                  onChange={(v) => setAddTo((p) => ({ ...p, [g.group_id]: v }))}
                  placeholder="เลือกสาขาที่จะฝากของ" width={280} />
                <button className="btn" onClick={() => void addMember(g.group_id)}
                  disabled={!addTo[g.group_id]}>เพิ่มเข้ากลุ่ม</button>
              </div>

              {g.members.length === 0 ? (
                <div className="note">ยังไม่มีสมาชิก — เพิ่มสาขาที่รถไม่ค่อยเข้าหรืออยู่ระหว่างทาง</div>
              ) : (
                <table>
                  <thead>
                    <tr><th>สาขา</th><th>จังหวัด</th><th>รหัส</th><th></th></tr>
                  </thead>
                  <tbody>
                    {g.members.map((m) => (
                      <tr key={m.plant_code}>
                        <td>{m.branch_name}</td>
                        <td style={{ color: 'var(--ink-3)' }}>
                          {m.province?.replace('จังหวัด', '')}
                        </td>
                        <td className="num" style={{ color: 'var(--ink-3)' }}>{m.plant_code}</td>
                        <td style={{ width: 90 }}>
                          <button className="btn ghost" style={{ padding: '4px 12px', fontSize: 13 }}
                            onClick={() => void removeMember(g.group_id, m.plant_code)}>
                            เอาออก
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>
      ))}

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
            <div className="tw" style={{ maxHeight: '40vh' }}>
              <table>
                <thead>
                  <tr>
                    <th>สาขาที่ได้ของ</th><th>ฝากไว้ที่</th>
                    <th>กลุ่ม</th><th className="num">รถไม่เข้ามา</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.map((r, i) => (
                    <tr key={i}>
                      <td>{r.branch_name}</td>
                      <td>{r.host_name}</td>
                      <td><span className="tag ok">{r.group_name}</span></td>
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
        บรรทัดที่เกิดจากการฝากจะมีป้าย <strong>ฝากที่ …</strong> กำกับในหน้าคำนวณ
        และในไฟล์เทมเพลตยังใช้รหัสสาขาปลายทางจริง ไม่ใช่สาขาที่ฝาก
      </div>

      {msg && <div className="note good" style={{ position: 'sticky', bottom: 16, marginTop: 14 }}>{msg}</div>}
    </>
  )
}
