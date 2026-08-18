import { useState } from 'react'
import { supabase, upsertChunked } from '../lib/supabase'
import {
  readSheet, parsePowerBI, parseMasterItem, parseME2N, parseWMS, parseTrips,
  parseDatastation, type Grid,
} from '../lib/parsers'

type Kind = 'master_items' | 'datastation' | 'power_bi' | 'me2n' | 'wms' | 'trips'

const SOURCES: { kind: Kind; title: string; hint: string; sheet?: string }[] = [
  { kind: 'master_items', title: 'Master Item', hint: 'ลิตรต่อชิ้น ขนาดลัง หน่วยโอน — ต้องนำเข้าก่อนไฟล์อื่น เพราะสูตรหารด้วยค่าลิตร', sheet: 'Master Item' },
  { kind: 'datastation',  title: 'Datastation2 — ทะเบียนสถานี', hint: 'คู่รหัสหน้า (Site Code2) กับ PlantCode — แก้ปัญหาสถานีมีหลายรหัส อัปครั้งเดียวใช้ได้ตลอด', sheet: 'Datastation2' },
  { kind: 'power_bi',     title: 'สต็อกรายสาขา (POWER_BI)', hint: 'คงเหลือและยอดขายเฉลี่ย 7/30/90 วัน — สร้างรายชื่อสาขาให้อัตโนมัติด้วย' },
  { kind: 'me2n',         title: 'ของระหว่างทาง (ME2N)', hint: 'PO ที่สั่งแล้วแต่ของยังไม่ถึงสาขา ระบบจะหักออกจากยอดสั่งใหม่', sheet: 'ME2N' },
  { kind: 'wms',          title: 'สต็อกคลัง (WMS)', hint: 'ของที่คลังมีจริง ใช้จำกัดยอดสั่งไม่ให้เกินของที่มี — ไม่อัปก็คำนวณได้ แต่จะไม่มีการจำกัด' },
  { kind: 'trips',        title: 'เที่ยวรถ', hint: 'สาขาที่รถเข้าในรอบนี้ ระบบคำนวณเฉพาะสาขาในรายการ' },
]

interface Log { ok: boolean; text: string }

export default function Import({ snapshotDate, setSnapshotDate }: {
  snapshotDate: string
  setSnapshotDate: (d: string) => void
}) {
  const [busy, setBusy] = useState<Kind | null>(null)
  const [logs, setLogs] = useState<Record<string, Log>>({})
  const [progress, setProgress] = useState('')

  const say = (k: Kind, ok: boolean, text: string) =>
    setLogs((p) => ({ ...p, [k]: { ok, text } }))

  async function batch(kind: Kind, filename: string, rows: number) {
    const { data, error } = await supabase.from('import_batches')
      .insert({ source: kind, filename, snapshot_date: snapshotDate, row_count: rows, status: 'committed' })
      .select('batch_id').single()
    if (error) throw new Error(error.message)
    return data.batch_id as string
  }

  async function handle(kind: Kind, file: File, sheetHint?: string) {
    setBusy(kind); setProgress('กำลังอ่านไฟล์…')
    try {
      const { grid, sheets } = await readSheet(file, sheetHint)
      await route(kind, file.name, grid, sheets)
    } catch (e) {
      say(kind, false, e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null); setProgress('')
    }
  }

  async function route(kind: Kind, filename: string, grid: Grid, sheets: string[]) {
    const tick = (d: number, t: number) => setProgress(`ส่งขึ้นฐานข้อมูล ${d}/${t} แถว`)

    if (kind === 'master_items') {
      const { rows, skipped, warnings } = parseMasterItem(grid)
      if (!rows.length) throw new Error('ไม่พบสินค้าในไฟล์ — ชีตที่มีให้เลือก: ' + sheets.join(', '))
      await upsertChunked('items', rows, 'mat_code', tick)
      await batch(kind, filename, rows.length)
      const nb = rows.filter((r) => r.is_booster).length
      const nc = rows.filter((r) => r.units_per_case > 1).length
      say(kind, true, [
        `นำเข้าสินค้า ${rows.length} รายการ${skipped ? ` ข้าม ${skipped} แถว` : ''}`,
        `หัวเชื้อ ${nb} รายการ · ต้องสั่งยกลัง ${nc} รายการ`,
        ...warnings.slice(0, 3),
      ].join('\n'))
      return
    }

    if (kind === 'datastation') {
      const { rows, skipped } = parseDatastation(grid)
      if (!rows.length) throw new Error('ไม่พบสถานีในไฟล์ — ชีตที่มีให้เลือก: ' + sheets.join(', '))
      await upsertChunked('station_master', rows, 'plant_code,site_code_2', tick)
      await batch(kind, filename, rows.length)

      setProgress('สร้างตารางเทียบรหัส…')
      const { data: n, error } = await supabase.rpc('sync_alias_from_master')
      if (error) throw new Error(error.message)

      say(kind, true, [
        `นำเข้าทะเบียนสถานี ${rows.length} แถว (สาขาหนึ่งมีได้หลายแถว แยกตามชนิด OIL/LPG)${skipped ? ` · ข้าม ${skipped}` : ''}`,
        `สร้างคู่เทียบรหัสอัตโนมัติ ${n ?? 0} คู่ — ตอนนี้ไฟล์เที่ยวรถจับคู่ด้วยรหัสหน้าได้แล้ว`,
      ].join('\n'))
      return
    }

    if (kind === 'power_bi') {
      const { stock, stations, skipped, warnings, byClass } = parsePowerBI(grid)
      if (!stock.length) throw new Error('ไม่พบข้อมูลสต็อกในไฟล์')

      setProgress('บันทึกรายชื่อสาขา…')
      await upsertChunked('stations', stations, 'plant_code')

      // กันพลาด: SKU ที่ยังไม่มีใน master จะ insert ไม่ผ่านเพราะ foreign key
      const { data: known } = await supabase.from('items').select('mat_code')
      const have = new Set((known ?? []).map((r) => r.mat_code as string))
      const usable = stock.filter((s) => have.has(s.mat_code))
      const missing = [...new Set(stock.filter((s) => !have.has(s.mat_code)).map((s) => s.mat_code))]

      const bid = await batch(kind, filename, usable.length)
      await upsertChunked('stock_snapshots',
        usable.map((s) => ({ ...s, batch_id: bid, snapshot_date: snapshotDate })),
        'snapshot_date,plant_code,mat_code', tick)

      const classLine = Object.entries(byClass)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k} ${v}`)
        .join(' · ')

      say(kind, missing.length === 0, [
        `นำเข้า ${usable.length} แถว จาก ${stations.length} สาขา`,
        `แยกตามคลาส: ${classLine}`,
        skipped ? `ข้ามแถวว่าง ${skipped} แถว` : '',
        missing.length ? `ข้าม ${missing.length} SKU ที่ยังไม่มีใน Master Item: ${missing.slice(0, 6).join(', ')}${missing.length > 6 ? '…' : ''}` : '',
        ...warnings,
      ].filter(Boolean).join('\n'))
      return
    }

    if (kind === 'me2n') {
      const { rows, skipped } = parseME2N(grid)
      const bid = await batch(kind, filename, rows.length)
      await upsertChunked('in_transit',
        rows.map((r) => ({ ...r, batch_id: bid, snapshot_date: snapshotDate })),
        'snapshot_date,plant_code,mat_code,po_no', tick)
      say(kind, true, `นำเข้าของระหว่างทาง ${rows.length} แถว${skipped ? ` ข้าม ${skipped} แถว` : ''}`)
      return
    }

    if (kind === 'wms') {
      const { rows, warnings } = parseWMS(grid)
      const bid = await batch(kind, filename, rows.length)
      await upsertChunked('depot_stock',
        rows.map((r) => ({ ...r, batch_id: bid, snapshot_date: snapshotDate })),
        'snapshot_date,mat_code', tick)
      say(kind, !warnings.length, `นำเข้าสต็อกคลัง ${rows.length} SKU` + (warnings.length ? `\n${warnings.join('\n')}` : ''))
      return
    }

    // เที่ยวรถ: เก็บทั้งประวัติ (ใช้คำนวณรอบส่ง) และแผนรอบนี้ (ใช้เลือกสาขา)
    const { rows, skipped, warnings } = parseTrips(grid)
    if (!rows.length) throw new Error('ไม่พบสาขาในไฟล์เที่ยวรถ — ชีตที่มีให้เลือก: ' + sheets.join(', '))
    const bid = await batch(kind, filename, rows.length)
    // จับคู่สามชั้น: รหัสหน้า (Site Code2) → รหัสท้าย → ตารางเทียบที่กรอกเอง
    // รหัสหน้าเชื่อถือได้กว่า เพราะบางสาขารหัสท้ายไม่ตรงกับ PlantCode
    const [{ data: known }, { data: alias }] = await Promise.all([
      supabase.from('stations').select('plant_code'),
      supabase.from('station_alias').select('alias_code, plant_code'),
    ])
    const have = new Set((known ?? []).map((r) => r.plant_code as string))
    const map = new Map((alias ?? []).map((r) => [r.alias_code as string, r.plant_code as string]))

    const resolve = (code: string | null): string | null => {
      if (!code) return null
      if (have.has(code)) return code
      const m = map.get(code)
      return m && have.has(m) ? m : null
    }

    const usable: { plant_code: string; trip_no: number | null; pickup_point: string | null }[] = []
    const unresolved: typeof rows = []
    let viaAlias = 0

    for (const r of rows) {
      const hit = resolve(r.front_code) ?? resolve(r.tail_code)
      if (!hit) { unresolved.push(r); continue }
      if (hit !== r.front_code && hit !== r.tail_code) viaAlias++
      usable.push({ plant_code: hit, trip_no: r.trip_no, pickup_point: r.pickup_point })
    }

    // กันซ้ำ: สาขาเดียวอาจปรากฏหลายแถวในไฟล์
    const dedup = [...new Map(usable.map((u) => [u.plant_code, u])).values()]

    // จำรหัสที่ยังจับคู่ไม่ได้ไว้ ไปผูกทีหลังได้ที่หน้า KPI และค่าคำนวณ
    if (unresolved.length) {
      await supabase.from('unmapped_codes').upsert(
        unresolved.map((r) => ({
          alias_code: r.front_code ?? r.tail_code ?? '?',
          sample_name: r.source_name,
          last_seen: snapshotDate,
        })),
        { onConflict: 'alias_code' }
      )
    }
    const unknown = unresolved.map((r) => r.front_code ?? r.tail_code ?? '?')
    const translated = viaAlias

    await upsertChunked('delivery_trips',
      dedup.map((r) => ({ ...r, batch_id: bid, trip_date: snapshotDate })),
      'trip_date,plant_code', tick)
    await upsertChunked('delivery_plan',
      dedup.map((r) => ({ ...r, trip_date: snapshotDate })),
      'trip_date,plant_code')

    say(kind, !unknown.length, [
      `บันทึกเที่ยวรถ ${dedup.length} สาขา สำหรับวันที่ ${snapshotDate}`,
      translated ? `แปลงรหัสด้วยทะเบียนสถานี ${translated} แถว` : '',
      skipped ? `ข้าม ${skipped} แถวที่ไม่ใช่สถานีในความดูแล` : '',
      unknown.length ? `จับคู่ไม่ได้ ${unknown.length} รหัส (${unknown.slice(0, 5).join(', ')}) — ไปผูกรหัสที่หน้า KPI และค่าคำนวณ` : '',
      ...warnings,
    ].filter(Boolean).join('\n'))
  }

  return (
    <>
      <h2>นำเข้าข้อมูล</h2>
      <p className="lede">
        อ่านไฟล์ในเครื่องคุณโดยตรง ไม่ผ่านเซิร์ฟเวอร์ตัวกลาง อัปซ้ำวันเดิมได้ ระบบจะเขียนทับข้อมูลของวันนั้น
      </p>

      <div className="card">
        <h3>ข้อมูล ณ วันที่</h3>
        <p className="hint">ทุกไฟล์ในรอบนี้จะถูกบันทึกภายใต้วันเดียวกัน ใช้วันที่ของข้อมูล ไม่ใช่วันที่อัป</p>
        <input type="date" value={snapshotDate} onChange={(e) => setSnapshotDate(e.target.value)} />
      </div>

      {SOURCES.map((s) => {
        const log = logs[s.kind]
        return (
          <div className="card" key={s.kind}>
            <div className="spread">
              <div style={{ flex: 1 }}>
                <h3>{s.title}</h3>
                <p className="hint">{s.hint}</p>
              </div>
              <label className="file">
                <input
                  type="file" accept=".xlsx,.xls,.xlsm"
                  disabled={busy !== null}
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    if (f) handle(s.kind, f, s.sheet)
                    e.target.value = ''
                  }}
                />
                {busy === s.kind ? (progress || 'กำลังทำงาน…') : 'เลือกไฟล์'}
              </label>
            </div>
            {log && (
              <div className={`note ${log.ok ? 'good' : 'bad'}`} style={{ marginTop: 12, whiteSpace: 'pre-line' }}>
                {log.text}
              </div>
            )}
          </div>
        )
      })}
    </>
  )
}
