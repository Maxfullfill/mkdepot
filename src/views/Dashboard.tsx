import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { LineChart, type Point } from './Chart'

interface Sum {
  ready: boolean
  reason?: string
  snapshot_date?: string
  doh_target?: number
  files?: Record<string, { date: string; rows: number; age: number }>
  kpi?: {
    lines: number; in_stock: number; short: number; avail: number
    doh: number; stock_l: number; excess_l: number; stations: number
  }
  kpi_prev?: { avail: number | null; doh: number | null; date: string | null }
  booster?: { name: string; ok: number; total: number; short: number; pct: number }[]
  today?: { trip_date: string | null; stations: number }
  last_run?: { trip_date: string; lines: number; exported: boolean; qty: number } | null
  alerts?: {
    transfer_pending: number; transfer_old: number; depot_urgent: number
    offtemplate_short: number; unmapped: number; no_shipto: number
  }
  top_excess?: { name: string; liters: number; lines: number }[]
  top_short?: { name: string; stations: number }[]
  falling?: { name: string; now: number; before: number; drop: number }[]
}

interface Hist {
  snapshot_date: string; lines: number; in_stock: number; short: number
  avail: number | null; doh: number | null
  stock_l: number; excess_l: number; booster_pct: number | null
}

type Metric = 'avail' | 'doh' | 'short' | 'excess' | 'booster'

const METRIC: Record<Metric, {
  label: string; unit: string; good: boolean; dec: number; color: string
}> = {
  avail:   { label: 'Availability', unit: '%',   good: true,  dec: 1, color: '#4a7c74' },
  doh:     { label: 'DOH',          unit: ' วัน', good: false, dec: 1, color: '#9c6206' },
  short:   { label: 'ของขาด',        unit: '',    good: false, dec: 0, color: '#9c3b30' },
  excess:  { label: 'ของเกิน',       unit: ' ล.',  good: false, dec: 0, color: '#9c6206' },
  booster: { label: 'หัวเชื้อ',       unit: '%',   good: true,  dec: 1, color: '#4a7c74' },
}

const FILE_LABEL: Record<string, string> = {
  master_items: 'Master Item', datastation: 'ทะเบียนสถานี',
  power_bi: 'สต็อกสาขา', trips: 'เที่ยวรถ', me2n: 'ME2N', wms: 'สต็อกคลัง',
}

export default function Dashboard({ go }: { go: (tab: string) => void }) {
  const [d, setD] = useState<Sum | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(true)
  const [hist, setHist] = useState<Hist[]>([])
  const [metric, setMetric] = useState<Metric>('avail')
  const [range, setRange] = useState(30)

  useEffect(() => {
    supabase.rpc('dashboard_summary').then(({ data, error }) => {
      if (error) setErr(error.message)
      else setD((data as Sum) ?? { ready: false })
      setBusy(false)
    })
  }, [])

  useEffect(() => {
    supabase.rpc('kpi_history', { p_days: range }).then(({ data }) => {
      if (Array.isArray(data)) setHist(data as Hist[])
    })
  }, [range])

  if (busy) return <><h2>ภาพรวม</h2><div className="note">กำลังโหลด…</div></>

  if (err) return (
    <>
      <h2>ภาพรวม</h2>
      <div className="card">
        <h3>โหลดข้อมูลไม่สำเร็จ</h3>
        <p className="hint">ฐานข้อมูลตอบกลับมาว่า</p>
        <div className="note bad" style={{ whiteSpace: 'pre-wrap' }}>{err}</div>
        <p className="hint" style={{ marginTop: 14, marginBottom: 0 }}>
          ถ้าขึ้นว่าไม่รู้จักฟังก์ชันหรือ view แปลว่ายังรัน migration ไม่ครบ
        </p>
      </div>
    </>
  )

  if (!d?.ready) return (
    <>
      <h2>ภาพรวม</h2>
      <p className="lede">{d?.reason ?? 'ยังไม่มีข้อมูลในระบบ'}</p>
      <div className="card">
        <h3>เริ่มต้นใช้งาน</h3>
        <p className="hint">
          นำเข้าข้อมูลตั้งต้นก่อน แล้วตามด้วยไฟล์ประจำรอบ จากนั้นค่อยกดคำนวณ
        </p>
        <button className="btn" onClick={() => go('import')}>ไปหน้านำเข้าข้อมูล</button>
      </div>
    </>
  )

  const k = {
    lines: 0, in_stock: 0, short: 0, avail: 0,
    doh: 0, stock_l: 0, excess_l: 0, stations: 0, ...(d.kpi ?? {}),
  }
  const prev = d.kpi_prev
  const a = {
    transfer_pending: 0, transfer_old: 0, depot_urgent: 0,
    offtemplate_short: 0, unmapped: 0, no_shipto: 0, ...(d.alerts ?? {}),
  }
  const target = d.doh_target ?? 20
  const dAvail = prev?.avail != null && k.avail != null
    ? +(k.avail - prev.avail).toFixed(1) : null
  const dDoh = prev?.doh != null && k.doh != null
    ? +(k.doh - prev.doh).toFixed(1) : null

  const delta = (v: number | null, goodUp: boolean) => {
    if (v === null || v === 0) return null
    const good = goodUp ? v > 0 : v < 0
    return (
      <span style={{ fontSize: 14, marginLeft: 8, color: good ? 'var(--ok)' : 'var(--alarm)' }}>
        {v > 0 ? '↑' : '↓'} {Math.abs(v)}
      </span>
    )
  }

  const todo: { text: string; tab: string; level: 'bad' | 'warn' }[] = []
  if (a.depot_urgent > 0)
    todo.push({ text: `คลังต้องสั่งด่วน ${a.depot_urgent} SKU`, tab: 'depot', level: 'bad' })
  if (a.offtemplate_short > 0)
    todo.push({ text: `Battery Fluid ขาด ${a.offtemplate_short} สาขา ต้องสั่งแยก`, tab: 'run', level: 'bad' })
  if (a.transfer_old > 0)
    todo.push({ text: `ใบโอนค้างเกิน 10 วัน ${a.transfer_old} รายการ`, tab: 'transfer', level: 'warn' })
  if (a.transfer_pending > 0)
    todo.push({ text: `ของกำลังโอน ${a.transfer_pending} รายการ`, tab: 'transfer', level: 'warn' })
  if (a.unmapped > 0)
    todo.push({ text: `รหัสสาขาจับคู่ไม่ได้ ${a.unmapped} รหัส`, tab: 'settings', level: 'warn' })
  if (a.no_shipto > 0)
    todo.push({ text: `สาขาที่ยังไม่มีชื่อ Shipto ${a.no_shipto} แห่ง`, tab: 'settings', level: 'warn' })

  const stale = Object.entries(d.files ?? {}).filter(([, f]) => f.age > 1)

  return (
    <>
      <h2>ภาพรวม</h2>
      <p className="lede">
        ข้อมูล ณ {d.snapshot_date} · {k.stations} สาขา ·
        Class A {Number(k.lines ?? 0).toLocaleString()} บรรทัด
      </p>

      <dl className="stats">
        <div className="stat">
          <dt>Availability · เป้า 97%</dt>
          <dd style={{ color: k.avail >= 97 ? 'var(--ok)' : 'var(--alarm)' }}>
            {k.avail ?? '—'}<small>%</small>{delta(dAvail, true)}
          </dd>
        </div>
        <div className="stat">
          <dt>DOH · เป้า {target} วัน</dt>
          <dd style={{ color: k.doh <= target ? 'var(--ok)' : 'var(--oil)' }}>
            {k.doh ?? '—'}{delta(dDoh, false)}
          </dd>
        </div>
        <div className="stat">
          <dt>ของขาดตอนนี้</dt>
          <dd style={{ color: k.short ? 'var(--alarm)' : 'var(--ok)' }}>{k.short}</dd>
        </div>
        <div className="stat">
          <dt>ของเกินเพดาน</dt>
          <dd style={{ color: 'var(--oil)' }}>
            {Number(k.excess_l ?? 0).toLocaleString()}<small> ลิตร</small>
          </dd>
        </div>
      </dl>

      {hist.length > 1 && (() => {
        const m = METRIC[metric]
        const pts: Point[] = hist.map((h) => ({
          x: h.snapshot_date,
          y: metric === 'avail' ? h.avail
            : metric === 'doh' ? h.doh
            : metric === 'short' ? h.short
            : metric === 'excess' ? h.excess_l
            : h.booster_pct,
        }))
        const tgt = metric === 'avail' ? 97 : metric === 'doh' ? target
          : metric === 'booster' ? 100 : undefined
        const vals = pts.map((p) => p.y).filter((v): v is number => v !== null)
        const first = vals[0], last = vals[vals.length - 1]
        const diff = vals.length > 1 ? +(last - first).toFixed(m.dec) : null

        return (
          <div className="card">
            <div className="spread" style={{ marginBottom: 16 }}>
              <div>
                <h3>แนวโน้มย้อนหลัง</h3>
                <p className="hint" style={{ marginBottom: 0 }}>
                  {hist.length} วันที่มีข้อมูล · เก็บทุกครั้งที่นำเข้าไฟล์ POWER_BI
                  {diff !== null && (
                    <> · เปลี่ยนไป{' '}
                      <strong style={{
                        color: (m.good ? diff > 0 : diff < 0) ? 'var(--ok)'
                          : diff === 0 ? 'var(--ink-3)' : 'var(--alarm)',
                      }}>
                        {diff > 0 ? '+' : ''}{diff}{m.unit}
                      </strong>
                    </>
                  )}
                </p>
              </div>
              <div className="row" style={{ gap: 6 }}>
                {[14, 30, 90].map((r) => (
                  <button key={r} className={`btn ${range === r ? '' : 'ghost'}`}
                    style={{ padding: '6px 14px', fontSize: 13.5 }}
                    onClick={() => setRange(r)}>{r} วัน</button>
                ))}
              </div>
            </div>

            <div className="row" style={{ gap: 6, marginBottom: 18 }}>
              {(Object.keys(METRIC) as Metric[]).map((k2) => (
                <button key={k2} className={`btn ${metric === k2 ? '' : 'ghost'}`}
                  style={{ padding: '6px 14px', fontSize: 13.5 }}
                  onClick={() => setMetric(k2)}>{METRIC[k2].label}</button>
              ))}
            </div>

            <LineChart data={pts} target={tgt} unit={m.unit}
              goodAbove={m.good} decimals={m.dec} color={m.color}
              targetLabel={tgt !== undefined ? `เป้า ${tgt}${m.unit}` : undefined} />
          </div>
        )
      })()}

      {todo.length > 0 && (
        <div className="card">
          <h3>ต้องจัดการ</h3>
          <p className="hint">กดที่รายการเพื่อไปหน้าที่เกี่ยวข้อง</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {todo.map((t, i) => (
              <button key={i} onClick={() => go(t.tab)}
                className={`note ${t.level === 'bad' ? 'bad' : ''}`}
                style={{
                  textAlign: 'left', cursor: 'pointer', width: '100%',
                  fontFamily: 'var(--sans)', display: 'flex',
                  justifyContent: 'space-between', alignItems: 'center', gap: 12,
                }}>
                <span>{t.text}</span>
                <span style={{ opacity: .5 }}>→</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="card">
        <h3>งานรอบล่าสุด</h3>
        <p className="hint">
          {d.today?.trip_date
            ? `แผนเที่ยวรถล่าสุด ${d.today.trip_date} · ${d.today.stations} สาขา`
            : 'ยังไม่มีแผนเที่ยวรถ'}
        </p>
        {d.last_run ? (
          <div className="row" style={{ gap: 26 }}>
            <span>รอบ <strong>{d.last_run.trip_date}</strong></span>
            <span>{d.last_run.lines} บรรทัด</span>
            <span>{Number(d.last_run.qty).toLocaleString()} ชิ้น</span>
            <span className={`tag ${d.last_run.exported ? 'ok' : 'oil'}`}>
              {d.last_run.exported ? 'ออกไฟล์แล้ว' : 'ยังไม่ได้ออกไฟล์'}
            </span>
            <span style={{ flex: 1 }} />
            <button className="btn ghost" onClick={() => go('run')}>ไปหน้าคำนวณ</button>
          </div>
        ) : (
          <div className="row">
            <span style={{ color: 'var(--ink-3)' }}>ยังไม่เคยคำนวณ</span>
            <button className="btn" onClick={() => go('run')}>เริ่มคำนวณ</button>
          </div>
        )}
      </div>

      {(d.booster ?? []).length > 0 && (
        <div className="card">
          <h3>หัวเชื้อ · ต้องมีครบทุกสาขา</h3>
          <table>
            <tbody>
              {d.booster!.map((b) => (
                <tr key={b.name}>
                  <td>{b.name}</td>
                  <td className="num" style={{ width: 120 }}>{b.ok} / {b.total}</td>
                  <td className="num" style={{ width: 90, color: b.pct >= 100 ? 'var(--ok)' : 'var(--alarm)' }}>
                    <strong>{b.pct}%</strong>
                  </td>
                  <td style={{ width: 110 }}>
                    {b.short > 0 && <span className="tag alarm">ขาด {b.short}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 18 }}>
        <div className="card" style={{ margin: 0 }}>
          <h3>ของกองมากสุด</h3>
          <p className="hint">เกินเพดาน {target} วัน — ตัวที่ควรโอนเกลี่ยก่อน</p>
          <table>
            <tbody>
              {(d.top_excess ?? []).map((x) => (
                <tr key={x.name}>
                  <td>{x.name}</td>
                  <td className="num" style={{ width: 110, color: 'var(--oil)' }}>
                    <strong>{Number(x.liters).toLocaleString()}</strong>
                    <span style={{ color: 'var(--ink-3)', fontSize: 12 }}> ล.</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button className="btn ghost" style={{ marginTop: 14 }} onClick={() => go('transfer')}>
            ไปหน้าโอนเกลี่ย
          </button>
        </div>

        <div className="card" style={{ margin: 0 }}>
          <h3>ขาดหลายสาขาสุด</h3>
          <p className="hint">ตัวที่ทำให้ Availability หลุดเป้ามากที่สุด</p>
          <table>
            <tbody>
              {(d.top_short ?? []).length === 0 ? (
                <tr><td style={{ color: 'var(--ok)' }}>ไม่มีของขาด</td></tr>
              ) : d.top_short!.map((x) => (
                <tr key={x.name}>
                  <td>{x.name}</td>
                  <td className="num" style={{ width: 100, color: 'var(--alarm)' }}>
                    <strong>{x.stations}</strong>
                    <span style={{ color: 'var(--ink-3)', fontSize: 12 }}> สาขา</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {(d.falling ?? []).length > 0 && (
        <div className="card" style={{ marginTop: 18 }}>
          <h3>ยอดขายกำลังตก</h3>
          <p className="hint">
            เทียบ 7 วันล่าสุดกับ 90 วัน — ตกเกิน 30% ควรชะลอการเติมก่อนของกอง
          </p>
          <table>
            <thead>
              <tr><th>สินค้า</th><th className="num">90 วัน</th><th className="num">7 วัน</th><th className="num">ตก</th></tr>
            </thead>
            <tbody>
              {d.falling!.map((x) => (
                <tr key={x.name}>
                  <td>{x.name}</td>
                  <td className="num" style={{ color: 'var(--ink-3)' }}>{x.before}</td>
                  <td className="num">{x.now}</td>
                  <td className="num" style={{ color: 'var(--alarm)' }}><strong>−{x.drop}%</strong></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card" style={{ marginTop: 18 }}>
        <h3>ความสดของข้อมูล</h3>
        <p className="hint">ไฟล์ที่เก่าเกิน 1 วันอาจทำให้ตัวเลขคลาดเคลื่อน</p>
        <div className="row" style={{ gap: 10 }}>
          {Object.entries(d.files ?? {}).map(([k2, f]) => (
            <span key={k2} className={`tag ${f.age > 2 ? 'alarm' : f.age > 1 ? 'oil' : 'ok'}`}>
              {FILE_LABEL[k2] ?? k2} · {f.age === 0 ? 'วันนี้' : `${f.age} วันก่อน`}
            </span>
          ))}
        </div>
        {stale.length > 0 && (
          <div className="note" style={{ marginTop: 14 }}>
            มี {stale.length} ไฟล์ที่เก่าเกิน 1 วัน — อัปใหม่ก่อนคำนวณเพื่อความแม่นยำ
          </div>
        )}
      </div>
    </>
  )
}
