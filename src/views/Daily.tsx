import { useEffect, useState, type ReactNode } from 'react'
import { supabase } from '../lib/supabase'

interface Ready { power_bi?: boolean; trips?: boolean; me2n?: boolean; wms?: boolean }
interface Sum {
  ready?: boolean
  kpi?: { short?: number; avail?: number }
  alerts?: { transfer_pending?: number; depot_urgent?: number }
  last_run?: { lines?: number; exported?: boolean; trip_date?: string } | null
}

/** ไอคอนแบบเส้น ใช้ชุดเดียวกันทั้งหน้า */
const I = {
  upload: (
    <path d="M12 16V4m0 0L8 8m4-4 4 4M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2"
      stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
  ),
  calc: (
    <>
      <rect x="4" y="3" width="16" height="18" rx="2.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="M8 8h8M8 12h3M8 16h3M15 12v4" stroke="currentColor" strokeWidth="1.8"
        strokeLinecap="round" />
    </>
  ),
  swap: (
    <path d="M7 7h11l-3-3m3 13H7l3 3" stroke="currentColor" strokeWidth="1.9"
      strokeLinecap="round" strokeLinejoin="round" />
  ),
  alert: (
    <path d="M12 8v5m0 3.5h.01M10.3 3.9 2.6 17.1A1.6 1.6 0 0 0 4 19.5h16a1.6 1.6 0 0 0 1.4-2.4L13.7 3.9a1.6 1.6 0 0 0-2.8 0Z"
      stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round" />
  ),
  truck: (
    <>
      <path d="M3 7h10v9H3zM13 10h4l3 3v3h-7z" stroke="currentColor" strokeWidth="1.8"
        strokeLinejoin="round" />
      <circle cx="7" cy="18" r="1.6" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="17" cy="18" r="1.6" stroke="currentColor" strokeWidth="1.8" />
    </>
  ),
  box: (
    <path d="M4 8.5 12 4l8 4.5M4 8.5v7L12 20l8-4.5v-7M4 8.5 12 13l8-4.5M12 13v7"
      stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  ),
  chart: (
    <path d="M4 19V5m0 14h16M8 16V11m4 5V7m4 9v-3" stroke="currentColor" strokeWidth="1.9"
      strokeLinecap="round" />
  ),
  arrow: (
    <path d="M5 12h13M12 6l6 6-6 6" stroke="currentColor" strokeWidth="2.2"
      strokeLinecap="round" strokeLinejoin="round" />
  ),
}

function Icon({ d, size = 21 }: { d: ReactNode; size?: number }) {
  return <svg viewBox="0 0 24 24" width={size} height={size} fill="none">{d}</svg>
}

export default function Daily({ snapshotDate, setSnapshotDate, go }: {
  snapshotDate: string
  setSnapshotDate: (d: string) => void
  go: (tab: string) => void
}) {
  const [ready, setReady] = useState<Ready>({})
  const [sum, setSum] = useState<Sum | null>(null)

  useEffect(() => { void check() }, [snapshotDate])
  useEffect(() => {
    supabase.rpc('dashboard_summary').then(({ data }) => setSum((data as Sum) ?? null))
  }, [])

  async function check() {
    const { data } = await supabase.from('import_batches')
      .select('source').eq('status', 'committed').eq('snapshot_date', snapshotDate)
    const m: Ready = {}
    ;(data ?? []).forEach((r) => { m[r.source as keyof Ready] = true })
    setReady(m)
  }

  const files = [
    { k: 'power_bi' as const, label: 'สต็อกรายสาขา', must: true },
    { k: 'trips' as const, label: 'เที่ยวรถ', must: true },
    { k: 'me2n' as const, label: 'ของระหว่างทาง', must: false },
    { k: 'wms' as const, label: 'สต็อกคลัง', must: false },
  ]
  const done = files.filter((f) => ready[f.k]).length
  const mustDone = files.filter((f) => f.must).every((f) => ready[f.k])

  const short = sum?.kpi?.short ?? 0
  const pending = sum?.alerts?.transfer_pending ?? 0
  const depotUrgent = sum?.alerts?.depot_urgent ?? 0
  const lastRun = sum?.last_run

  return (
    <>
      {/* แถบบน บอกสถานะของวันนี้ */}
      <div className="hero">
        <div className="hero-row">
          <div>
            <h3>งานวันนี้</h3>
            <p>
              {mustDone
                ? 'ไฟล์ที่จำเป็นครบแล้ว คำนวณได้เลย'
                : 'ยังขาดไฟล์ที่จำเป็น อัปให้ครบก่อนคำนวณ'}
            </p>
            <div className="chips">
              {files.map((f) => (
                <span key={f.k}
                  className={`chip ${ready[f.k] ? 'good' : f.must ? 'bad' : ''}`}>
                  {ready[f.k] ? '✓' : f.must ? '!' : '—'} {f.label}
                </span>
              ))}
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <p style={{ marginBottom: 6 }}>ข้อมูล ณ วันที่</p>
            <input type="date" value={snapshotDate}
              onChange={(e) => setSnapshotDate(e.target.value)}
              style={{ border: 0, borderRadius: 10, padding: '8px 12px' }} />
            <p style={{ marginTop: 8, fontSize: 12.5 }}>อัปครบแล้ว {done} จาก 4 ไฟล์</p>
          </div>
        </div>
      </div>

      {/* งานหลักของวัน */}
      <div className="tiles">
        <button className="tile t-violet" onClick={() => go('import')}>
          <span className="ico"><Icon d={I.upload} /></span>
          <span className={`badge ${mustDone ? 'ok' : 'hot'}`}>{done}/4</span>
          <span>
            <b>อัปไฟล์</b>
            <span>ไฟล์ประจำรอบ 4 ชนิด</span>
          </span>
        </button>

        <button className="tile t-dark" onClick={() => go('run')}>
          <span className="ico"><Icon d={I.calc} /></span>
          <span>
            <b>คำนวณยอดเติม</b>
            <span>
              {lastRun?.lines
                ? `รอบล่าสุด ${lastRun.lines} บรรทัด${lastRun.exported ? ' · ออกไฟล์แล้ว' : ''}`
                : 'ยังไม่ได้คำนวณ'}
            </span>
          </span>
          <span className="arrow"><Icon d={I.arrow} size={17} /></span>
        </button>

        <button className="tile t-green" onClick={() => go('transfer')}>
          <span className="ico"><Icon d={I.swap} /></span>
          {pending > 0 && <span className="badge">{pending}</span>}
          <span>
            <b>โอนเกลี่ยสินค้า</b>
            <span>{pending > 0 ? `กำลังโอน ${pending} รายการ` : 'จับคู่สาขาล้นกับขาด'}</span>
          </span>
        </button>

        <button className="tile t-rose" onClick={() => go('shortage')}>
          <span className="ico"><Icon d={I.alert} /></span>
          {short > 0 && <span className="badge hot">{short}</span>}
          <span>
            <b>ของขาด</b>
            <span>{short > 0 ? `${short} บรรทัดที่ขาดตอนนี้` : 'ไม่มีของขาด'}</span>
          </span>
        </button>

        <button className="tile t-amber" onClick={() => go('receiving')}>
          <span className="ico"><Icon d={I.truck} /></span>
          <span>
            <b>ยังไม่ได้ทำรับ</b>
            <span>เทียบ ME2N กับที่สาขาเห็น</span>
          </span>
        </button>

        <button className="tile t-sky" onClick={() => go('depot')}>
          <span className="ico"><Icon d={I.box} /></span>
          {depotUrgent > 0 && <span className="badge hot">{depotUrgent}</span>}
          <span>
            <b>สั่งเข้าคลัง</b>
            <span>{depotUrgent > 0 ? `ต้องสั่งด่วน ${depotUrgent} รายการ` : 'วางแผนสั่งเข้าคลัง'}</span>
          </span>
        </button>
      </div>

      {/* งานรอง */}
      <div className="tiles-head">
        <h3>ดูข้อมูลย้อนหลัง</h3>
        <button onClick={() => go('home')}>ไปหน้าภาพรวม →</button>
      </div>

      <div className="tiles">
        <button className="tile t-lime" onClick={() => go('kpi')}>
          <span className="ico"><Icon d={I.chart} /></span>
          <span>
            <b>KPI ย้อนหลัง</b>
            <span>Availability และ DOH รายวัน</span>
          </span>
        </button>

        <button className="tile t-violet" onClick={() => go('manual')}>
          <span className="ico"><Icon d={I.swap} /></span>
          <span>
            <b>โอนกำหนดเอง</b>
            <span>เลือกต้นทางปลายทางเอง</span>
          </span>
        </button>

        <button className="tile t-green" onClick={() => go('transferB')}>
          <span className="ico"><Icon d={I.box} /></span>
          <span>
            <b>โอนข้ามคลาส</b>
            <span>ของเกินไปเติม Class B</span>
          </span>
        </button>
      </div>

      {!mustDone && (
        <div className="note bad" style={{ marginTop: 16 }}>
          ยังขาดไฟล์ที่จำเป็น — กดแผ่น <strong>อัปไฟล์</strong> เพื่ออัปให้ครบก่อนคำนวณ
          ไม่งั้นผลที่ได้จะไม่ถูกต้อง
        </div>
      )}
    </>
  )
}
