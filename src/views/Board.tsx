import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

interface Kpi { snapshot_date: string; class_fix: string; active_lines: number; availability_pct: number; doh_liter: number }
interface Setting { key: string; value: number; unit: string | null; note: string | null }

export default function Board() {
  const [kpi, setKpi] = useState<Kpi[]>([])
  const [settings, setSettings] = useState<Setting[]>([])
  const [saved, setSaved] = useState('')

  useEffect(() => { void refresh() }, [])

  async function refresh() {
    const [k, s] = await Promise.all([
      supabase.from('v_kpi_daily').select('*').order('snapshot_date', { ascending: false }).limit(30),
      supabase.from('settings').select('*').order('key'),
    ])
    setKpi((k.data ?? []) as Kpi[])
    setSettings((s.data ?? []) as Setting[])
  }

  async function save(key: string, value: number) {
    setSettings((p) => p.map((s) => (s.key === key ? { ...s, value } : s)))
    const { error } = await supabase.from('settings').update({ value, updated_at: new Date().toISOString() }).eq('key', key)
    setSaved(error ? `บันทึกไม่สำเร็จ: ${error.message}` : `บันทึก ${key} แล้ว`)
    setTimeout(() => setSaved(''), 2500)
  }

  const dates = [...new Set(kpi.map((k) => k.snapshot_date))]

  return (
    <>
      <h2>KPI และค่าที่ใช้คำนวณ</h2>
      <p className="lede">ตัวเลขคิดจากเฉพาะ SKU ที่สาขานั้นขายจริง ไม่รวม SKU ที่ไม่เคยวางขาย</p>

      <div className="card">
        <h3>Availability และ DOH ย้อนหลัง</h3>
        <p className="hint">เป้า: Availability ไม่ต่ำกว่า 97% (ควรเกิน 98%) และ DOH ไม่เกิน 25 วัน</p>
        {dates.length === 0 ? (
          <div className="note">ยังไม่มีข้อมูล — นำเข้าไฟล์ POWER_BI ก่อน แล้วตัวเลขจะขึ้นที่นี่ทุกวันที่อัป</div>
        ) : (
          <div className="tw" style={{ maxHeight: '40vh' }}>
            <table>
              <thead><tr><th>วันที่</th><th>Class</th><th className="num">บรรทัด</th><th className="num">Availability</th><th className="num">DOH (ลิตร)</th></tr></thead>
              <tbody>
                {kpi.map((k, i) => (
                  <tr key={i}>
                    <td className="num" style={{ textAlign: 'left' }}>{k.snapshot_date}</td>
                    <td>{k.class_fix}</td>
                    <td className="num">{k.active_lines}</td>
                    <td className="num" style={{ color: k.availability_pct >= 97 ? 'var(--ok)' : 'var(--alarm)' }}>
                      {k.availability_pct?.toFixed(1)}%
                    </td>
                    <td className="num" style={{ color: k.doh_liter > 25 ? 'var(--oil)' : 'var(--ok)' }}>
                      {k.doh_liter?.toFixed(1)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <h3>ค่าที่ใช้คำนวณ</h3>
        <p className="hint">แก้ค่าแล้วมีผลกับการคำนวณรอบถัดไปทันที รอบที่คำนวณไปแล้วเก็บค่าเดิมไว้ ตรวจย้อนหลังได้</p>
        <table>
          <tbody>
            {settings.map((s) => (
              <tr key={s.key}>
                <td style={{ fontFamily: 'var(--mono)', fontSize: 12.5, width: 160 }}>{s.key}</td>
                <td style={{ width: 110 }}>
                  <input type="number" step="0.05" value={s.value} style={{ width: 84 }}
                    onChange={(e) => save(s.key, parseFloat(e.target.value || '0'))} />
                </td>
                <td style={{ width: 44, color: 'var(--ink-3)', fontSize: 12.5 }}>{s.unit}</td>
                <td style={{ color: 'var(--ink-2)', fontSize: 12.5 }}>{s.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {saved && <div className="note good" style={{ marginTop: 12 }}>{saved}</div>}
      </div>
    </>
  )
}
