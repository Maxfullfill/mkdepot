import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import ImportPage from './Import'
import Run from './Run'

interface Ready {
  power_bi?: string; trips?: string; me2n?: string; wms?: string
}

/** หน้างานประจำวัน — รวมอัปไฟล์ คำนวณ และออกไฟล์ไว้ที่เดียว
 *  ใช้คอมโพเนนต์เดิมทั้งหมด ไม่ได้เขียนตรรกะซ้ำ */
export default function Daily({ snapshotDate, setSnapshotDate }: {
  snapshotDate: string
  setSnapshotDate: (d: string) => void
}) {
  const [ready, setReady] = useState<Ready>({})
  const [step, setStep] = useState<1 | 2>(1)

  useEffect(() => { void check() }, [snapshotDate])

  async function check() {
    const { data } = await supabase.from('import_batches')
      .select('source, snapshot_date')
      .eq('status', 'committed')
      .eq('snapshot_date', snapshotDate)
    const m: Ready = {}
    ;(data ?? []).forEach((r) => {
      m[r.source as keyof Ready] = r.snapshot_date as string
    })
    setReady(m)
  }

  const must = [
    { k: 'power_bi' as const, label: 'สต็อกรายสาขา' },
    { k: 'trips' as const, label: 'เที่ยวรถ' },
  ]
  const opt = [
    { k: 'me2n' as const, label: 'ของระหว่างทาง' },
    { k: 'wms' as const, label: 'สต็อกคลัง' },
  ]
  const mustDone = must.every((x) => ready[x.k])

  return (
    <>
      <h2>งานประจำวัน</h2>
      <p className="lede">
        อัปไฟล์ · คำนวณ · ออกไฟล์สั่งซื้อ ทำครบได้ในหน้าเดียว
      </p>

      {/* แถบบอกว่าอยู่ขั้นไหน */}
      <div className="card" style={{ padding: '18px 22px' }}>
        <div className="row" style={{ gap: 0 }}>
          {[
            { n: 1, t: 'อัปไฟล์ประจำรอบ', done: mustDone },
            { n: 2, t: 'คำนวณและออกไฟล์', done: false },
          ].map((s, i) => (
            <span key={s.n} style={{ display: 'flex', alignItems: 'center', flex: 1 }}>
              <button
                onClick={() => setStep(s.n as 1 | 2)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 11,
                  border: 0, background: 'none', cursor: 'pointer',
                  fontFamily: 'var(--sans)', padding: 0, textAlign: 'left',
                }}>
                <span style={{
                  width: 34, height: 34, borderRadius: '50%', flex: 'none',
                  display: 'grid', placeItems: 'center', fontWeight: 700, fontSize: 15,
                  background: step === s.n ? 'var(--act)' : s.done ? 'var(--ok-bg)' : 'var(--wash)',
                  color: step === s.n ? '#fff' : s.done ? 'var(--ok)' : 'var(--ink-3)',
                  border: step === s.n ? 'none' : '1px solid var(--line)',
                }}>
                  {s.done && step !== s.n ? '✓' : s.n}
                </span>
                <span style={{
                  fontSize: 15,
                  fontWeight: step === s.n ? 600 : 400,
                  color: step === s.n ? 'var(--ink)' : 'var(--ink-2)',
                }}>{s.t}</span>
              </button>
              {i === 0 && (
                <span style={{
                  flex: 1, height: 2, margin: '0 16px',
                  background: mustDone ? 'var(--ok)' : 'var(--line)',
                }} />
              )}
            </span>
          ))}
        </div>
      </div>

      {step === 1 && (
        <>
          <div className="card">
            <h3>สถานะไฟล์ของวันที่ {snapshotDate}</h3>
            <p className="hint">อัปสองไฟล์แรกให้ครบก่อน อีกสองไฟล์ไม่บังคับแต่ควรมี</p>
            <div className="row" style={{ gap: 8 }}>
              {must.map((x) => (
                <span key={x.k} className={`tag ${ready[x.k] ? 'ok' : 'alarm'}`}>
                  {ready[x.k] ? '✓' : '×'} {x.label}
                </span>
              ))}
              {opt.map((x) => (
                <span key={x.k} className={`tag ${ready[x.k] ? 'ok' : 'oil'}`}>
                  {ready[x.k] ? '✓' : '—'} {x.label}
                </span>
              ))}
            </div>
          </div>

          <ImportPage compact
            snapshotDate={snapshotDate} setSnapshotDate={setSnapshotDate} />

          <div className="card">
            <div className="spread">
              <div>
                <h3>อัปครบแล้วหรือยัง</h3>
                <p className="hint" style={{ marginBottom: 0 }}>
                  {mustDone
                    ? 'ไฟล์ที่จำเป็นครบแล้ว ไปขั้นถัดไปได้'
                    : 'ยังขาดไฟล์ที่จำเป็น อัปให้ครบก่อนจะได้ผลที่ถูกต้อง'}
                </p>
              </div>
              <button className={`btn ${mustDone ? '' : 'ghost'}`}
                onClick={() => { void check(); setStep(2) }}>
                ไปคำนวณ →
              </button>
            </div>
          </div>
        </>
      )}

      {step === 2 && (
        <>
          {!mustDone && (
            <div className="note bad">
              ยังอัปไฟล์ไม่ครบ — ผลที่ได้อาจไม่ถูกต้อง
              <button className="btn ghost" style={{ marginLeft: 12, padding: '4px 12px', fontSize: 13 }}
                onClick={() => setStep(1)}>กลับไปอัปไฟล์</button>
            </div>
          )}
          <Run snapshotDate={snapshotDate} />
        </>
      )}
    </>
  )
}
