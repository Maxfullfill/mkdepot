import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { StepNum, Switch, Fold } from './ui'

interface Setting { key: string; value: number; unit: string | null; note: string | null }
interface Cover {
  plant_code: string; branch_name: string
  n_intervals: number | null; avg_days: number | null
  p50: number | null; p75: number | null; p90: number | null; p95: number | null
  last_trip: string | null; override_day: number | null
  source: string; cover_day: number
}
interface Unmapped { alias_code: string; sample_name: string | null; last_seen: string }
interface Alias { alias_code: string; plant_code: string; branch_name: string }
interface Station { plant_code: string; branch_name: string }

/** ค่าที่มีหน้าตาเฉพาะ ไม่ต้องแสดงซ้ำในตารางรวม */
const OWN_UI = [
  'cover_mode', 'cover_fixed', 'cover_percentile', 'cycle_min_trips',
  'lead_time', 'ss_class_a', 'ss_class_b', 'ss_class_c',
  'include_class_a', 'include_class_b', 'include_class_c',
  'doh_ceiling', 'doh_budget_enabled', 'doh_budget_days',
  'doh_cap_enabled', 'skip_when_covered',
]

export default function Settings() {
  const [settings, setSettings] = useState<Setting[]>([])
  const [cover, setCover] = useState<Cover[]>([])
  const [unmapped, setUnmapped] = useState<Unmapped[]>([])
  const [alias, setAlias] = useState<Alias[]>([])
  const [stations, setStations] = useState<Station[]>([])
  const [q, setQ] = useState('')
  const [msg, setMsg] = useState('')

  useEffect(() => { void refresh() }, [])

  async function refresh() {
    const [s, c, u, a, st] = await Promise.all([
      supabase.from('settings').select('*').order('key'),
      supabase.from('v_cover_preview').select('*').order('branch_name'),
      supabase.from('unmapped_codes').select('*').order('last_seen', { ascending: false }),
      supabase.from('v_alias_map').select('*'),
      supabase.from('stations').select('plant_code, branch_name').eq('is_active', true).order('branch_name'),
    ])
    setSettings((s.data ?? []) as Setting[])
    setCover((c.data ?? []) as Cover[])
    setUnmapped((u.data ?? []) as Unmapped[])
    setAlias((a.data ?? []) as Alias[])
    setStations((st.data ?? []) as Station[])
  }

  async function reloadCover() {
    const { data } = await supabase.from('v_cover_preview').select('*').order('branch_name')
    setCover((data ?? []) as Cover[])
  }

  const get = (k: string) => settings.find((s) => s.key === k)?.value ?? 0
  const flash = (t: string) => { setMsg(t); setTimeout(() => setMsg(''), 2000) }

  async function save(key: string, value: number | null) {
    if (value === null) return
    setSettings((p) => p.map((s) => (s.key === key ? { ...s, value } : s)))
    const { error } = await supabase.from('settings')
      .update({ value, updated_at: new Date().toISOString() }).eq('key', key)
    if (error) { flash(`บันทึกไม่สำเร็จ: ${error.message}`); return }
    flash('บันทึกแล้ว')
    if (key.startsWith('cover') || key === 'cycle_min_trips') await reloadCover()
  }

  async function setOverride(plant: string, v: number | null) {
    if (v === null) await supabase.from('station_cover_override').delete().eq('plant_code', plant)
    else await supabase.from('station_cover_override').upsert({ plant_code: plant, cover_day: v })
    await reloadCover()
    flash('บันทึกแล้ว')
  }

  async function linkAlias(code: string, plant: string) {
    if (!plant) return
    const { error } = await supabase.from('station_alias').upsert({ alias_code: code, plant_code: plant })
    if (error) { flash(`ผูกไม่สำเร็จ: ${error.message}`); return }
    await supabase.from('unmapped_codes').delete().eq('alias_code', code)
    await refresh()
    flash(`ผูก ${code} แล้ว`)
  }

  async function unlinkAlias(code: string) {
    await supabase.from('station_alias').delete().eq('alias_code', code)
    await refresh()
    flash(`ยกเลิก ${code} แล้ว`)
  }

  const mode = get('cover_mode')
  const leadTime = get('lead_time')
  const fixed = get('cover_fixed')
  const minTrips = get('cycle_min_trips')
  const ready = cover.filter((c) => (c.n_intervals ?? 0) >= minTrips).length
  const overrides = cover.filter((c) => c.override_day !== null).length

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase()
    return t
      ? cover.filter((c) =>
          (c.branch_name ?? '').toLowerCase().includes(t) || c.plant_code.toLowerCase().includes(t))
      : cover
  }, [cover, q])

  const row = (label: string, node: React.ReactNode, hint?: string) => (
    <div className="row" style={{ marginBottom: 10 }}>
      <label style={{ fontSize: 13.5, minWidth: 210 }}>{label}</label>
      {node}
      {hint && <span style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>{hint}</span>}
    </div>
  )

  return (
    <>
      <h2>ตั้งค่าการคำนวณ</h2>
      <p className="lede">
        แก้แล้วมีผลกับการคำนวณรอบถัดไปทันที รอบที่คำนวณไปแล้วเก็บค่าเดิมไว้ ตรวจย้อนหลังได้เสมอ
      </p>

      <Fold title="CoverDay — ของต้องอยู่ได้กี่วัน" open
        note={mode === 1 ? 'ตามรอบส่งจริง' : `คงที่ ${fixed} วัน`}
        hint={`สูตรเติมให้พอขาย CoverDay + LeadTime ${leadTime} วัน`}>

        <div className="row" style={{ gap: 22, marginBottom: 16 }}>
          <label style={{ display: 'flex', gap: 7, alignItems: 'center', cursor: 'pointer' }}>
            <input type="radio" name="cm" checked={mode === 0} onChange={() => save('cover_mode', 0)} />
            กรอกตัวเลขเอง
          </label>
          <label style={{ display: 'flex', gap: 7, alignItems: 'center', cursor: 'pointer' }}>
            <input type="radio" name="cm" checked={mode === 1} onChange={() => save('cover_mode', 1)} />
            คิดจากรอบส่งจริงรายสาขา
          </label>
        </div>

        {mode === 0
          ? row('CoverDay ทุกสาขา',
              <StepNum value={fixed} step={0.1} min={1} decimals={1}
                onChange={(v) => save('cover_fixed', v)} />,
              `วัน → เติมให้พอขาย ${(fixed + leadTime).toFixed(1)} วัน`)
          : (<>
              {row('เปอร์เซ็นไทล์ของรอบส่ง',
                <select value={get('cover_percentile')}
                  onChange={(e) => save('cover_percentile', parseFloat(e.target.value))}>
                  <option value={50}>P50 — รอบกลาง ประหยัดของ</option>
                  <option value={75}>P75 — เผื่อพอประมาณ</option>
                  <option value={90}>P90 — เผื่อรอบยาว (แนะนำ)</option>
                  <option value={95}>P95 — เผื่อเกือบทุกกรณี</option>
                </select>)}
              {row('ต้องมีประวัติรถเข้าอย่างน้อย',
                <StepNum value={minTrips} step={1} min={1}
                  onChange={(v) => save('cycle_min_trips', v)} />,
                `ครั้ง — ผ่านเกณฑ์ ${ready} จาก ${cover.length} สาขา ที่เหลือใช้ ${fixed} วัน`)}
              {row('CoverDay สำรอง',
                <StepNum value={fixed} step={0.1} min={1} decimals={1}
                  onChange={(v) => save('cover_fixed', v)} />,
                'วัน — ใช้กับสาขาที่ข้อมูลยังไม่พอ')}
            </>)}

        {row('LeadTime', <StepNum value={leadTime} step={1} min={0}
          onChange={(v) => save('lead_time', v)} />, 'วัน — สั่งถึงของถึงสาขา')}
      </Fold>

      <Fold title="CoverDay รายสาขา" note={overrides ? `กำหนดเอง ${overrides} สาขา` : `${cover.length} สาขา`}
        hint="เปิดสวิตช์เพื่อกำหนดเจาะจง ทับค่าที่ระบบคิดให้ · ปิดคือกลับไปใช้ค่าอัตโนมัติ">
        <div className="row" style={{ marginBottom: 10 }}>
          <input type="text" placeholder="ค้นหาสาขา" value={q}
            onChange={(e) => setQ(e.target.value)} style={{ width: 200 }} />
          <span style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>{shown.length} รายการ</span>
        </div>
        <div className="tw" style={{ maxHeight: '48vh' }}>
          <table>
            <thead>
              <tr>
                <th>สาขา</th><th className="num">รถเข้า</th>
                <th className="num">P50</th><th className="num">P90</th><th className="num">P95</th>
                <th>ที่มา</th><th className="num">ใช้จริง</th><th>กำหนดเอง</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((c) => {
                const on = c.override_day !== null
                return (
                  <tr key={c.plant_code}>
                    <td>{c.branch_name || c.plant_code}</td>
                    <td className="num">{c.n_intervals ?? '—'}</td>
                    <td className="num" style={{ color: 'var(--ink-3)' }}>{c.p50 ?? '—'}</td>
                    <td className="num" style={{ color: 'var(--ink-3)' }}>{c.p90 ?? '—'}</td>
                    <td className="num" style={{ color: 'var(--ink-3)' }}>{c.p95 ?? '—'}</td>
                    <td>
                      <span className={`tag ${c.source === 'กำหนดเอง' ? 'oil' : c.source === 'รอบส่งจริง' ? 'ok' : ''}`}>
                        {c.source}
                      </span>
                    </td>
                    <td className="num"><strong>{c.cover_day}</strong></td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <Switch on={on} onChange={(v) =>
                          setOverride(c.plant_code, v ? (c.p90 ?? c.cover_day ?? fixed) : null)} />
                        <StepNum small disabled={!on} allowEmpty
                          value={c.override_day} step={0.5} min={0} decimals={1}
                          onChange={(v) => setOverride(c.plant_code, v)} />
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Fold>

      <Fold title="คลาสสินค้าและ Safety stock" note={
        ['A', 'B', 'C'].filter((x) => get(`include_class_${x.toLowerCase()}`) === 1)
          .map((x) => `Class ${x}`).join(', ') || 'ไม่ได้เปิดเลย'}
        hint="เปิดสวิตช์เพื่อนำคลาสนั้นมาคำนวณ · Safety stock เป็นจำนวนชิ้น ใช้เฉพาะบรรทัดที่ของไม่พอจริง">
        <table>
          <thead>
            <tr><th>คลาส</th><th>นำมาคำนวณ</th><th>Safety stock</th><th></th></tr>
          </thead>
          <tbody>
            {(['a', 'b', 'c'] as const).map((k) => (
              <tr key={k}>
                <td style={{ width: 90 }}>Class {k.toUpperCase()}</td>
                <td style={{ width: 110 }}>
                  <Switch on={get(`include_class_${k}`) === 1}
                    onChange={(v) => save(`include_class_${k}`, v ? 1 : 0)} />
                </td>
                <td style={{ width: 130 }}>
                  <StepNum small value={get(`ss_class_${k}`)} step={1} min={0}
                    onChange={(v) => save(`ss_class_${k}`, v)} />
                </td>
                <td style={{ color: 'var(--ink-3)', fontSize: 12.5 }}>ชิ้น</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Fold>

      <Fold title="DOH" note={`เพดาน ${get('doh_ceiling')} วัน · ${get('doh_budget_enabled') === 1 ? 'คุมงบอยู่' : 'ยังไม่คุม'}`}
        hint="เพดานใช้แสดงผลเสมอ ส่วนการคุมงบจะจำกัดยอดสั่งจริง">
        {row('เพดาน DOH (เส้น KPI)',
          <StepNum value={get('doh_ceiling')} step={1} min={1}
            onChange={(v) => save('doh_ceiling', v)} />, 'วัน — ใช้กับแถบวัดและการนับส่วนเกิน')}

        <div className="row" style={{ marginBottom: 10 }}>
          <label style={{ fontSize: 13.5, minWidth: 210 }}>คุมงบ DOH ภาพรวม</label>
          <Switch on={get('doh_budget_enabled') === 1}
            onChange={(v) => save('doh_budget_enabled', v ? 1 : 0)} />
          <StepNum value={get('doh_budget_days')} step={1} min={1}
            onChange={(v) => save('doh_budget_days', v)} />
          <span style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>วัน</span>
        </div>

        {get('doh_budget_enabled') === 1 && (
          <div className="note bad">
            ตอนนี้สต็อกเกินเพดานอยู่แล้ว เปิดไว้ระบบจะเติมเฉพาะของขาดกับเสี่ยงขาด
            แล้วตัดที่เหลือทิ้ง ซึ่งจะทำให้สาขาขาดกลางรอบในรอบถัดไป —
            ควรเปิดหลังโอนเกลี่ยลดสต็อกแล้ว
          </div>
        )}

        <div className="row" style={{ marginTop: 14 }}>
          <label style={{ fontSize: 13.5, minWidth: 210 }}>ข้ามบรรทัดที่ของพอถึงรอบหน้า</label>
          <Switch on={get('skip_when_covered') === 1}
            onChange={(v) => save('skip_when_covered', v ? 1 : 0)} />
          <span style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>กันสั่งซ้ำสินค้าที่ DOH ล้น</span>
        </div>
      </Fold>

      <Fold title="รหัสสาขาที่จับคู่ไม่ได้"
        note={unmapped.length ? `ค้าง ${unmapped.length} รหัส` : 'ครบแล้ว'}
        open={unmapped.length > 0}
        hint="บางสถานีมีหลายรหัส เลือกสาขาปลายทางให้ถูก ระบบจะจำไว้ใช้ทุกครั้งถัดไป">
        {unmapped.length === 0 ? (
          <div className="note good">ทุกรหัสในไฟล์เที่ยวรถจับคู่ได้ครบ</div>
        ) : (
          <table>
            <thead><tr><th>รหัส</th><th>ชื่อในไฟล์</th><th>เจอล่าสุด</th><th>ผูกกับสาขา</th></tr></thead>
            <tbody>
              {unmapped.map((u) => (
                <tr key={u.alias_code}>
                  <td style={{ fontFamily: 'var(--mono)' }}>{u.alias_code}</td>
                  <td style={{ color: 'var(--ink-2)' }}>{u.sample_name ?? '—'}</td>
                  <td style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-3)' }}>{u.last_seen}</td>
                  <td>
                    <select defaultValue="" style={{ maxWidth: 250 }}
                      onChange={(e) => void linkAlias(u.alias_code, e.target.value)}>
                      <option value="">— เลือกสาขา —</option>
                      {stations.map((s) => (
                        <option key={s.plant_code} value={s.plant_code}>
                          {s.branch_name} ({s.plant_code})
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {alias.length > 0 && (
          <>
            <p className="hint" style={{ marginTop: 18, marginBottom: 6 }}>
              ผูกไว้แล้ว {alias.length} รหัส
            </p>
            <div className="tw" style={{ maxHeight: '30vh' }}>
              <table>
                <tbody>
                  {alias.map((a) => (
                    <tr key={a.alias_code}>
                      <td style={{ fontFamily: 'var(--mono)', width: 80 }}>{a.alias_code}</td>
                      <td style={{ color: 'var(--ink-3)', width: 24 }}>→</td>
                      <td>{a.branch_name} <span style={{ color: 'var(--ink-3)' }}>({a.plant_code})</span></td>
                      <td style={{ width: 90 }}>
                        <button className="btn ghost" onClick={() => void unlinkAlias(a.alias_code)}>ยกเลิก</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Fold>

      <Fold title="ค่าอื่น" note={`${settings.filter((s) => !OWN_UI.includes(s.key)).length} รายการ`}>
        <table>
          <tbody>
            {settings.filter((s) => !OWN_UI.includes(s.key)).map((s) => (
              <tr key={s.key}>
                <td style={{ fontFamily: 'var(--mono)', fontSize: 12.5, width: 150 }}>{s.key}</td>
                <td style={{ width: 120 }}>
                  <StepNum small value={s.value} step={s.value < 5 ? 0.05 : 1} min={0}
                    decimals={s.value < 5 ? 2 : 0} onChange={(v) => save(s.key, v)} />
                </td>
                <td style={{ width: 44, color: 'var(--ink-3)', fontSize: 12.5 }}>{s.unit}</td>
                <td style={{ color: 'var(--ink-2)', fontSize: 12.5 }}>{s.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Fold>

      {msg && <div className="note good" style={{ position: 'sticky', bottom: 16, marginTop: 12 }}>{msg}</div>}
    </>
  )
}
