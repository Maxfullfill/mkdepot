import { useEffect, useState } from 'react'
import { supabase, upsertChunked } from '../lib/supabase'
import {
  readSheet, parsePowerBI, parseMasterItem, parseME2N, parseWMS, parseTrips,
  parseDatastation, type Grid,
} from '../lib/parsers'
import { Fold } from './ui'

type Kind = 'master_items' | 'datastation' | 'power_bi' | 'me2n' | 'wms' | 'trips'

interface Source {
  kind: Kind
  title: string
  hint: string
  sheet?: string
  /** ข้อมูลตั้งต้น อัปครั้งเดียวพอ ไม่ต้องทำทุกรอบ */
  setup?: boolean
  optional?: boolean
}

const SOURCES: Source[] = [
  { kind: 'master_items', setup: true, title: 'Master Item', sheet: 'Master Item',
    hint: 'ลิตรต่อชิ้น หน่วยนับ จำนวนต่อลัง — อัปใหม่เมื่อมีสินค้าเพิ่มหรือแก้ข้อมูลสินค้า' },
  { kind: 'datastation', setup: true, title: 'Datastation2 — ทะเบียนสถานี', sheet: 'Datastation2',
    hint: 'รหัสสาขาทุกชุด ผู้จัดการเขต จังหวัด อำเภอ กลุ่ม OLP — อัปใหม่เมื่อมีสาขาเปิดหรือย้ายเขต' },

  { kind: 'power_bi', title: 'สต็อกรายสาขา (POWER_BI)',
    hint: 'คงเหลือและยอดขายเฉลี่ย 7/30/90 วัน — หัวใจของทุกการคำนวณ' },
  { kind: 'trips', title: 'เที่ยวรถ',
    hint: 'สาขาที่รถเข้ารอบนี้ ระบบคำนวณเฉพาะสาขาในรายการ · อ่านทุกชีต เที่ยว 1 · เที่ยว 2 · ต่างคลัง รวมกันในครั้งเดียว และตัดแถวที่คลังที่รับเป็นรถโอนออก' },
  { kind: 'me2n', title: 'ของระหว่างทาง (ME2N)', sheet: 'ME2N', optional: true,
    hint: 'PO ที่สั่งแล้วของยังไม่ถึง — ไม่อัปจะสั่งซ้ำของที่กำลังมา' },
  { kind: 'wms', title: 'สต็อกคลัง (WMS)', optional: true,
    hint: 'ของที่คลังมีจริง ใช้จำกัดไม่ให้สั่งเกิน — ไม่อัปก็คำนวณได้ แต่ไม่มีการจำกัด' },
]

interface Log { ok: boolean; text: string }
interface Last { source: string; snapshot_date: string; uploaded_at: string; row_count: number }

export default function Import({ snapshotDate, setSnapshotDate }: {
  snapshotDate: string
  setSnapshotDate: (d: string) => void
}) {
  const [busy, setBusy] = useState<Kind | null>(null)
  const [last, setLast] = useState<Record<string, Last>>({})
  const [logs, setLogs] = useState<Record<string, Log>>({})
  const [progress, setProgress] = useState('')

  const say = (k: Kind, ok: boolean, text: string) =>
    setLogs((p) => ({ ...p, [k]: { ok, text } }))

  useEffect(() => { void loadLast() }, [])

  async function loadLast() {
    const { data } = await supabase.from('import_batches')
      .select('source, snapshot_date, uploaded_at, row_count')
      .eq('status', 'committed')
      .order('uploaded_at', { ascending: false })
      .limit(200)
    const m: Record<string, Last> = {}
    ;(data ?? []).forEach((r) => {
      const k = r.source as string
      if (!m[k]) m[k] = r as Last
    })
    setLast(m)
  }

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
      await route(kind, file.name, grid, sheets, file)
    } catch (e) {
      say(kind, false, e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null); setProgress('')
      void loadLast()
    }
  }

  /** ชีตเที่ยวรถที่ต้องอ่าน — เที่ยว 1, เที่ยว 2 และต่างคลัง */
  const isTripSheet = (n: string) =>
    /เที่ยว|ต่างคลัง|ข้ามคลัง/.test(n) || /^\s*[123]\s*$/.test(n)

  async function route(kind: Kind, filename: string, grid: Grid, sheets: string[], file: File) {
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
        `ผู้จัดการเขต ${new Set(rows.map((r) => r.area_manager).filter(Boolean)).size} คน — ใช้เป็นขอบเขตการโอนเกลี่ย`,
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
      const { rows, skipped, warnings } = parseME2N(grid)
      const bid = await batch(kind, filename, rows.length)
      await upsertChunked('in_transit',
        rows.map((r) => ({ ...r, batch_id: bid, snapshot_date: snapshotDate })),
        'snapshot_date,plant_code,mat_code,po_no', tick)
      say(kind, true, [
        `นำเข้า PO ${rows.length} รายการ${skipped ? ` ข้าม ${skipped} แถว` : ''}`,
        ...warnings,
      ].join('\n'))
      return
    }

    if (kind === 'wms') {
      const { rows, warnings } = parseWMS(grid)

      // รหัสที่ไม่มีใน Master Item จะถูก trigger ข้ามให้ ต้องรู้ว่าข้ามอะไรบ้าง
      const { data: known } = await supabase.from('items').select('mat_code')
      const have = new Set((known ?? []).map((r) => r.mat_code as string))
      const missing = rows.filter((r) => !have.has(r.mat_code))

      const bid = await batch(kind, filename, rows.length)
      await upsertChunked('depot_stock',
        rows.map((r) => ({ ...r, batch_id: bid, snapshot_date: snapshotDate })),
        'snapshot_date,mat_code', tick)

      say(kind, missing.length === 0, [
        `นำเข้าสต็อกคลัง ${rows.length - missing.length} SKU`,
        missing.length
          ? `ข้าม ${missing.length} รหัสที่ไม่มีใน Master Item: ` +
            missing.slice(0, 10).map((r) => `${r.mat_code} (${r.qty_pcs})`).join(', ') +
            (missing.length > 10 ? ` และอีก ${missing.length - 10} รหัส` : '') +
            '\nถ้าเป็นสินค้าที่ต้องส่งสาขา ให้เพิ่มใน Master Item แล้วอัปไฟล์นี้ใหม่'
          : '',
        ...warnings,
      ].filter(Boolean).join('\n'))
      return
    }

    // เที่ยวรถ: อ่านทุกชีตที่เกี่ยวข้องรวมกัน ไม่ใช่ชีตเดียว
    // เก็บทั้งประวัติ (ใช้คำนวณรอบส่ง) และแผนรอบนี้ (ใช้เลือกสาขา)
    const tripSheets = sheets.filter(isTripSheet)
    const pickSheets = tripSheets.length ? tripSheets : [sheets[0]]

    const rows: Awaited<ReturnType<typeof parseTrips>>['rows'] = []
    const perSheet: string[] = []
    let skipped = 0
    const warnings: string[] = []
    let dropTransfer = 0

    for (const sn of pickSheets) {
      setProgress(`กำลังอ่านชีต ${sn}…`)
      const g = sn === pickSheets[0] && !tripSheets.length
        ? grid : (await readSheet(file, sn)).grid
      const r = parseTrips(g)
      // ตัดแถวที่คลังที่รับเป็นรถโอน ไม่ใช่การส่งจากคลังเรา
      const keep = r.rows.filter((x) => {
        const txt = `${x.pickup_point ?? ''} ${x.source_name ?? ''}`
        if (/รถโอน/.test(txt)) { dropTransfer++; return false }
        return true
      })
      rows.push(...keep)
      skipped += r.skipped
      warnings.push(...r.warnings)
      perSheet.push(`${sn} ${keep.length} แถว`)
    }

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
      `อ่าน ${pickSheets.length} ชีต — ${perSheet.join(' · ')}`,
      dropTransfer ? `ตัด ${dropTransfer} แถวที่คลังที่รับเป็นรถโอน` : '',
      translated ? `แปลงรหัสด้วยทะเบียนสถานี ${translated} แถว` : '',
      skipped ? `ข้าม ${skipped} แถวที่ไม่ใช่สถานีในความดูแล` : '',
      unknown.length ? `จับคู่ไม่ได้ ${unknown.length} รหัส (${unknown.slice(0, 5).join(', ')}) — ไปผูกรหัสที่หน้า KPI และค่าคำนวณ` : '',
      ...warnings,
    ].filter(Boolean).join('\n'))
  }

  const fmt = (d?: Last) => {
    if (!d) return null
    const days = Math.round((Date.now() - new Date(d.uploaded_at).getTime()) / 86400000)
    return { date: d.snapshot_date, rows: d.row_count, days }
  }

  function card(s: Source) {
    const log = logs[s.kind]
    const info = fmt(last[s.kind])
    const stale = info && !s.setup && info.date !== snapshotDate

    return (
      <div className="card" key={s.kind}>
        <div className="spread">
          <div style={{ flex: 1 }}>
            <h3>
              {s.title}
              {s.optional && <span className="tag" style={{ marginLeft: 8 }}>ไม่บังคับ</span>}
            </h3>
            <p className="hint" style={{ marginBottom: 6 }}>{s.hint}</p>
            {info ? (
              <p style={{ margin: 0, fontSize: 12.5, color: stale ? 'var(--oil)' : 'var(--ok)' }}>
                ล่าสุด {info.date} · {info.rows?.toLocaleString()} แถว
                {info.days > 0 && ` · ${info.days} วันก่อน`}
                {stale && ' — คนละวันกับที่เลือกไว้'}
              </p>
            ) : (
              <p style={{ margin: 0, fontSize: 12.5, color: 'var(--ink-3)' }}>ยังไม่เคยนำเข้า</p>
            )}
          </div>
          <label className="file">
            <input
              type="file" accept=".xlsx,.xls,.xlsm" disabled={busy !== null}
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) handle(s.kind, f, s.sheet)
                e.target.value = ''
              }}
            />
            {busy === s.kind ? (progress || 'กำลังทำงาน…') : info ? 'อัปใหม่' : 'เลือกไฟล์'}
          </label>
        </div>
        {log && (
          <div className={`note ${log.ok ? 'good' : 'bad'}`}
            style={{ marginTop: 12, whiteSpace: 'pre-line' }}>
            {log.text}
          </div>
        )}
      </div>
    )
  }

  const setup = SOURCES.filter((s) => s.setup)
  const daily = SOURCES.filter((s) => !s.setup)
  const setupDone = setup.every((s) => last[s.kind])
  const dailyDone = daily.filter((s) => !s.optional).every(
    (s) => last[s.kind]?.snapshot_date === snapshotDate)

  return (
    <>
      <h2>นำเข้าข้อมูล</h2>
      <p className="lede">
        อ่านไฟล์ในเครื่องคุณโดยตรง ไม่ผ่านเซิร์ฟเวอร์ตัวกลาง · อัปซ้ำวันเดิมได้ ระบบเขียนทับให้
      </p>

      <div className="card">
        <h3>ข้อมูล ณ วันที่</h3>
        <p className="hint">
          ไฟล์ประจำรอบทั้งหมดจะถูกบันทึกภายใต้วันนี้ ใช้วันที่ของข้อมูล ไม่ใช่วันที่อัป
        </p>
        <div className="row">
          <input type="date" value={snapshotDate}
            onChange={(e) => setSnapshotDate(e.target.value)} />
          <span className={`tag ${dailyDone ? 'ok' : 'oil'}`}>
            {dailyDone ? 'ไฟล์ประจำรอบครบแล้ว' : 'ยังไม่ครบ'}
          </span>
        </div>
      </div>

      <Fold
        title="ข้อมูลตั้งต้น"
        note={setupDone ? 'ครบแล้ว' : 'ยังไม่ครบ'}
        open={!setupDone}
        hint="อัปครั้งเดียวพอ ไม่ต้องทำทุกรอบ — อัปใหม่เมื่อมีสินค้าหรือสาขาเปลี่ยน"
      >
        {setup.map(card)}
      </Fold>

      <div style={{ margin: '26px 0 14px' }}>
        <h3 style={{ fontSize: 15, margin: '0 0 2px' }}>ไฟล์ประจำรอบ</h3>
        <p className="hint" style={{ margin: 0 }}>
          อัปทุกครั้งก่อนคำนวณ ตามลำดับนี้
        </p>
      </div>

      {daily.map(card)}
    </>
  )
}
