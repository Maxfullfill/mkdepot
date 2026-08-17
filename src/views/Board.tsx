import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'

interface Kpi {
  snapshot_date: string; class_fix: string; active_lines: number
  availability_pct: number; doh_liter: number
}
interface Setting { key: string; value: number; unit: string | null; note: string | null }
interface Unmapped { alias_code: string; sample_name: string | null; last_seen: string }
interface Alias { alias_code: string; plant_code: string; branch_name: string }
interface Station { plant_code: string; branch_name: string }
interface Cover {
  plant_code: string; branch_name: string
  n_intervals: number | null; avg_days: number | null
  p50: number | null; p75: number | null; p90: number | null; p95: number | null
  last_trip: string | null; override_day: number | null
  source: string; cover_day: number
}

/** ค่าที่มีหน้าตาเฉพาะของตัวเอง ไม่ต้องแสดงซ้ำในตารางรวม */
const COVER_KEYS = ['cover_mode', 'cover_fixed', 'cover_percentile', 'cycle_min_trips']

export default function Board() {
  const [kpi, setKpi] = useState<Kpi[]>([])
  const [settings, setSettings] = useState<Setting[]>([])
  const [cover, setCover] = useState<Cover[]>([])
  const [q, setQ] = useState('')
  const [msg, setMsg] = useState('')
  const [unmapped, setUnmapped] = useState<Unmapped[]>([])
  const [alias, setAlias] = useState<Alias[]>([])
  const [stations, setStations] = useState<Station[]>([])

  useEffect(() => { void refresh() }, [])

  async function refresh() {
    const [k, s, c, u, a, st] = await Promise.all([
      supabase.from('v_kpi_daily').select('*').order('snapshot_date', { ascending: false }).limit(40),
      supabase.from('settings').select('*').order('key'),
      supabase.from('v_cover_preview').select('*').order('branch_name'),
      supabase.from('unmapped_codes').select('*').order('last_seen', { ascending: false }),
      supabase.from('v_alias_map').select('*'),
      supabase.from('stations').select('plant_code, branch_name').eq('is_active', true).order('branch_name'),
    ])
    setKpi((k.data ?? []) as Kpi[])
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

  const get = (key: string) => settings.find((s) => s.key === key)?.value ?? 0

  function flash(t: string) { setMsg(t); setTimeout(() => setMsg(''), 2200) }

  async function save(key: string, value: number) {
    setSettings((p) => p.map((s) => (s.key === key ? { ...s, value } : s)))
    const { error } = await supabase.from('settings')
      .update({ value, updated_at: new Date().toISOString() }).eq('key', key)
    if (error) { flash(`บันทึกไม่สำเร็จ: ${error.message}`); return }
    flash('บันทึกแล้ว')
    if (COVER_KEYS.includes(key)) await reloadCover()
  }

  async function setOverride(plant: string, raw: string) {
    if (raw.trim() === '') {
      await supabase.from('station_cover_override').delete().eq('plant_code', plant)
    } else {
      const v = parseFloat(raw)
      if (!Number.isFinite(v) || v < 0) return
      await supabase.from('station_cover_override').upsert({ plant_code: plant, cover_day: v })
    }
    await reloadCover()
    flash('บันทึกแล้ว')
  }

  async function linkAlias(code: string, plant: string) {
    if (!plant) return
    const { error } = await supabase.from('station_alias')
      .upsert({ alias_code: code, plant_code: plant })
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

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase()
    return t
      ? cover.filter((c) =>
          (c.branch_name ?? '').toLowerCase().includes(t) || c.plant_code.toLowerCase().includes(t))
      : cover
  }, [cover, q])

  return (
    <>
      <h2>KPI และค่าคำนวณ</h2>
      <p className="lede">
        นับเฉพาะสินค้า Class A ตามคอลัมน์ Class-สาขา(3ด.Fix) — คลาสของสินค้าตัวนั้นที่สาขานั้น
      </p>

      <div className="card">
        <h3>CoverDay — ของต้องอยู่ได้กี่วัน</h3>
        <p className="hint">
          สูตรเติมให้พอขาย <strong>CoverDay + LeadTime {leadTime} วัน</strong> ตั้ง 8 คือเติมให้พอ {8 + leadTime} วัน
        </p>

        <div className="row" style={{ gap: 22, marginBottom: 14 }}>
          <label style={{ display: 'flex', gap: 7, alignItems: 'center', cursor: 'pointer' }}>
            <input type="radio" name="cm" checked={mode === 0} onChange={() => save('cover_mode', 0)} />
            กรอกตัวเลขเอง
          </label>
          <label style={{ display: 'flex', gap: 7, alignItems: 'center', cursor: 'pointer' }}>
            <input type="radio" name="cm" checked={mode === 1} onChange={() => save('cover_mode', 1)} />
            คิดจากรอบส่งจริงรายสาขา
          </label>
        </div>

        {mode === 0 ? (
          <div className="row">
            <label style={{ fontSize: 13.5 }}>ใช้กับทุกสาขา</label>
            <input type="number" min={1} step={1} style={{ width: 84 }} value={fixed}
              onChange={(e) => save('cover_fixed', parseFloat(e.target.value || '1'))} />
            <span style={{ fontSize: 13, color: 'var(--ink-3)' }}>
              วัน → เติมให้พอขาย {fixed + leadTime} วัน
            </span>
          </div>
        ) : (
          <>
            <div className="row" style={{ marginBottom: 10 }}>
              <label style={{ fontSize: 13.5 }}>ใช้รอบส่งที่เปอร์เซ็นไทล์</label>
              <select value={get('cover_percentile')}
                onChange={(e) => save('cover_percentile', parseFloat(e.target.value))}>
                <option value={50}>P50 — รอบกลาง ประหยัดของ</option>
                <option value={75}>P75 — เผื่อพอประมาณ</option>
                <option value={90}>P90 — เผื่อรอบยาว (แนะนำ)</option>
                <option value={95}>P95 — เผื่อเกือบทุกกรณี</option>
              </select>
            </div>
            <div className="row">
              <label style={{ fontSize: 13.5 }}>ต้องมีประวัติรถเข้าอย่างน้อย</label>
              <input type="number" min={1} step={1} style={{ width: 68 }} value={minTrips}
                onChange={(e) => save('cycle_min_trips', parseFloat(e.target.value || '1'))} />
              <span style={{ fontSize: 13, color: 'var(--ink-3)' }}>
                ครั้ง — ผ่านเกณฑ์ {ready} จาก {cover.length} สาขา ที่เหลือใช้ค่ากลาง {fixed} วัน
              </span>
            </div>
            <div className="note" style={{ marginTop: 12 }}>
              รอบส่งไม่สม่ำเสมอ บางสาขาเข้าติดกัน 2 วันแล้วหายไป 13 วัน
              ถ้าใช้ค่าเฉลี่ยจะพอแค่ครึ่งหนึ่งของรอบ P90 จึงเหมาะกว่า
            </div>
          </>
        )}
      </div>

      <div className="card">
        <div className="spread">
          <div>
            <h3>CoverDay รายสาขา</h3>
            <p className="hint">กรอกช่องขวาสุดเพื่อกำหนดเจาะจง ทับค่าที่ระบบคิดให้ · ปล่อยว่างคือใช้ค่าอัตโนมัติ</p>
          </div>
          <input type="text" placeholder="ค้นหาสาขา" value={q}
            onChange={(e) => setQ(e.target.value)} style={{ width: 176 }} />
        </div>

        <div className="tw" style={{ maxHeight: '46vh', marginTop: 12 }}>
          <table>
            <thead>
              <tr>
                <th>สาขา</th><th className="num">รถเข้า</th>
                <th className="num">P50</th><th className="num">P90</th><th className="num">P95</th>
                <th>ล่าสุด</th><th>ที่มา</th>
                <th className="num">ใช้จริง</th><th className="num">กำหนดเอง</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((c) => (
                <tr key={c.plant_code}>
                  <td>{c.branch_name || c.plant_code}</td>
                  <td className="num">{c.n_intervals ?? '—'}</td>
                  <td className="num" style={{ color: 'var(--ink-3)' }}>{c.p50 ?? '—'}</td>
                  <td className="num" style={{ color: 'var(--ink-3)' }}>{c.p90 ?? '—'}</td>
                  <td className="num" style={{ color: 'var(--ink-3)' }}>{c.p95 ?? '—'}</td>
                  <td style={{ color: 'var(--ink-3)', fontFamily: 'var(--mono)', fontSize: 12 }}>
                    {c.last_trip ?? '—'}
                  </td>
                  <td>
                    <span className={`tag ${c.source === 'กำหนดเอง' ? 'oil' : c.source === 'รอบส่งจริง' ? 'ok' : ''}`}>
                      {c.source}
                    </span>
                  </td>
                  <td className="num"><strong>{c.cover_day}</strong></td>
                  <td className="num">
                    <input type="number" min={0} step={1} placeholder="—"
                      defaultValue={c.override_day ?? ''}
                      onBlur={(e) => {
                        const cur = c.override_day === null ? '' : String(c.override_day)
                        if (e.target.value !== cur) void setOverride(c.plant_code, e.target.value)
                      }} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h3>รหัสสาขาที่จับคู่ไม่ได้</h3>
        <p className="hint">
          บางสถานีมีหลายรหัส รหัสในไฟล์เที่ยวรถอาจไม่ตรงกับ PlantCode ใน POWER_BI
          เลือกสาขาปลายทางให้ถูก ระบบจะจำไว้ใช้ทุกครั้งถัดไป
        </p>

        {unmapped.length === 0 ? (
          <div className="note good">ไม่มีรหัสค้าง ทุกรหัสในไฟล์เที่ยวรถจับคู่ได้ครบ</div>
        ) : (
          <table>
            <thead>
              <tr><th>รหัส</th><th>ชื่อในไฟล์</th><th>เจอล่าสุด</th><th>ผูกกับสาขา</th></tr>
            </thead>
            <tbody>
              {unmapped.map((u) => (
                <tr key={u.alias_code}>
                  <td style={{ fontFamily: 'var(--mono)' }}>{u.alias_code}</td>
                  <td style={{ color: 'var(--ink-2)' }}>{u.sample_name ?? '—'}</td>
                  <td style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-3)' }}>
                    {u.last_seen}
                  </td>
                  <td>
                    <select defaultValue="" style={{ maxWidth: 260 }}
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
            <p className="hint" style={{ marginTop: 18, marginBottom: 6 }}>รหัสที่ผูกไว้แล้ว</p>
            <table>
              <tbody>
                {alias.map((a) => (
                  <tr key={a.alias_code}>
                    <td style={{ fontFamily: 'var(--mono)', width: 80 }}>{a.alias_code}</td>
                    <td style={{ color: 'var(--ink-3)', width: 24 }}>→</td>
                    <td>{a.branch_name} <span style={{ color: 'var(--ink-3)' }}>({a.plant_code})</span></td>
                    <td style={{ width: 90 }}>
                      <button className="btn ghost" onClick={() => void unlinkAlias(a.alias_code)}>
                        ยกเลิก
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>

      <div className="card">
        <h3>Availability และ DOH ย้อนหลัง</h3>
        <p className="hint">
          เป้า Availability ไม่ต่ำกว่า 97% ควรเกิน 98% · DOH แสดงไว้ดูแนวโน้ม ยังไม่ได้คุมในสูตร
        </p>
        {kpi.length === 0 ? (
          <div className="note">ยังไม่มีข้อมูล — นำเข้าไฟล์ POWER_BI ก่อน</div>
        ) : (
          <div className="tw" style={{ maxHeight: '34vh' }}>
            <table>
              <thead>
                <tr><th>วันที่</th><th>Class</th><th className="num">บรรทัด</th><th className="num">Availability</th><th className="num">DOH (ลิตร)</th></tr>
              </thead>
              <tbody>
                {kpi.map((k, i) => (
                  <tr key={i} style={{ opacity: k.class_fix === 'Class A' ? 1 : 0.5 }}>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{k.snapshot_date}</td>
                    <td>{k.class_fix}</td>
                    <td className="num">{k.active_lines}</td>
                    <td className="num" style={{ color: k.availability_pct >= 97 ? 'var(--ok)' : 'var(--alarm)' }}>
                      {k.availability_pct?.toFixed(1)}%
                    </td>
                    <td className="num" style={{ color: 'var(--ink-3)' }}>{k.doh_liter?.toFixed(1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <h3>ค่าอื่น</h3>
        <p className="hint">
          แก้แล้วมีผลรอบถัดไปทันที รอบที่คำนวณไปแล้วเก็บค่าเดิมไว้ ตรวจย้อนหลังได้ ·
          include_class_a / b / c ใส่ 1 เพื่อนำคลาสนั้นมาคำนวณ
        </p>
        <table>
          <tbody>
            {settings.filter((s) => !COVER_KEYS.includes(s.key)).map((s) => (
              <tr key={s.key}>
                <td style={{ fontFamily: 'var(--mono)', fontSize: 12.5, width: 156 }}>{s.key}</td>
                <td style={{ width: 104 }}>
                  <input type="number" step="0.05" value={s.value} style={{ width: 80 }}
                    onChange={(e) => save(s.key, parseFloat(e.target.value || '0'))} />
                </td>
                <td style={{ width: 44, color: 'var(--ink-3)', fontSize: 12.5 }}>{s.unit}</td>
                <td style={{ color: 'var(--ink-2)', fontSize: 12.5 }}>{s.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {msg && <div className="note good" style={{ position: 'sticky', bottom: 16, marginTop: 12 }}>{msg}</div>}
    </>
  )
}
