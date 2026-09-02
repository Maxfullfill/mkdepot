import { useEffect, useMemo, useState } from 'react'
import * as XLSX from 'xlsx'
import { supabase } from '../lib/supabase'
import { Picker, type Option } from './ui'

interface Line {
  id: number; plant_code: string; mat_code: string
  sales_per_day: number; cover_day: number; safety_stock: number
  on_hand_pcs: number; in_transit_pcs: number
  suggested_pcs: number; manual_add: number; final_pcs: number
  uom: string | null; doh_before: number | null; doh_after: number | null
  priority: number; flag: string | null
  branch_name?: string; item_desc?: string
  /** ไม่ใส่ในเทมเพลตหลัก — แยกไปการ์ดต่างหาก */
  off_template?: boolean
  is_booster?: boolean
  units_per_case?: number
}

interface OffT {
  mat_code: string; item_descr: string
  stations_total: number; in_stock: number; short: number; no_record: number
  coverage_pct: number; order_lines: number; order_qty: number
}

interface Meta {
  run_id: string; created_at: string; snapshot_date: string
  line_count: number; exported: boolean
  data_changed: boolean; changed_at: string | null
}
interface ShortAfter {
  plant_code: string; branch_name: string; province: string; area: string
  mat_code: string; item_name: string; sales_per_day: number
  incoming: number; depot_stock: number; days_since_trip: number
  on_trip: boolean; reason: string
}

interface Explain {
  found: boolean; reason?: string
  branch_name?: string; item_name?: string; class_fix?: string
  stock_pcs?: number; in_transit?: number; depot_stock?: number | null
  oldest_po_days?: number | null
  incoming_detail?: {
    source: string; po_no: string | null; po_date: string | null
    age_days: number | null; qty: number; note: string | null
  }[]
  sales_30_l?: number; litre_per_piece?: number; sales_per_day?: number
  doh_now?: number | null; cover_day?: number; lead_time?: number
  safety_stock?: number; demand_cover?: number; target?: number
  skipped?: boolean; need?: number; need_rounded?: number
  units_per_case?: number; notes?: string[]
  actual?: { suggested: number; final: number; priority: number
             flag: string | null; cover_day: number; target: number; run_at: string } | null
}

interface Rem {
  plant_code: string; branch_name: string; province: string
  mat_code: string; item_name: string; sales_per_day: number
  incoming: number; depot_stock: number; days_since_trip: number; reason: string
}
interface RunInfo {
  found: boolean; run_id?: string; created_at?: string; snapshot_date?: string
  exported?: boolean; lines?: number; stale?: boolean; reasons?: string[]
  early_mode?: boolean | null; suggest_early?: boolean
  cover_opt?: string | null; used_depot?: boolean | null
  suggest_cover?: string; has_depot?: boolean
}

/** เกณฑ์ CoverDay ที่เลือกได้ในแต่ละรอบ */
type SortKey = 'none' | 'branch_name' | 'item_desc' | 'on_hand_pcs' | 'in_transit_pcs'
  | 'sales_per_day' | 'cover_day' | 'doh_before' | 'suggested_pcs' | 'final_pcs' | 'doh_after'

const COVER_OPTS = [
  { v: 'early', label: 'ต้นเดือน',              hint: 'ใช้ตัวเลขต้นเดือนจากหน้าตั้งค่า' },
  { v: 'late',  label: 'ปลายเดือน',             hint: 'ใช้ตัวเลขปลายเดือนจากหน้าตั้งค่า' },
  { v: 'fixed', label: 'ค่าคงที่',               hint: 'ใช้ค่าเดียวกันทุกสาขา' },
  { v: 'p50',   label: 'P50 — รอบกลาง',          hint: 'ครึ่งหนึ่งของรอบรถสั้นกว่านี้ ประหยัดของแต่เสี่ยงขาด' },
  { v: 'p75',   label: 'P75 — เผื่อพอประมาณ',    hint: 'สามในสี่ของรอบรถสั้นกว่านี้' },
  { v: 'p90',   label: 'P90 — เผื่อรอบยาว',      hint: 'เก้าในสิบของรอบรถสั้นกว่านี้' },
  { v: 'p95',   label: 'P95 — เผื่อเกือบทุกกรณี', hint: 'แทบไม่ขาดแต่ของกองเยอะ' },
]

interface Incoming { source: string; lines: number; qty: number; stations: number }

interface Short {
  mat_code: string; item_name: string
  requested: number; depot_stock: number; allocated: number; shortfall: number
  lines_total: number; lines_unmet: number; stations_out: number
}

interface Kpi {
  total_lines: number; in_stock_before: number
  short_total: number; short_on_trip: number; short_off_trip: number
  fixed_here: number; stations_total: number; stations_on_trip: number
  avail_before: number; avail_after: number
  doh_before: number; doh_after: number
  over_doh_lines: number; excess_liters: number
  dead_lines: number; dead_liters: number
}

interface OffAlert {
  mat_code: string; item_descr: string
  stations_total: number; in_stock: number
  short_total: number; short_on_trip: number
  order_lines: number; order_qty: number; uom: string | null
}

const PRIORITY = {
  1: { label: 'ขาดจริง', cls: 'alarm' },
  2: { label: 'เสี่ยงขาด', cls: 'oil' },
  3: { label: 'ไม่พอถึงรอบหน้า', cls: '' },
  4: { label: 'ปกติ', cls: '' },
} as const

/** มาตรวัด DOH — ยาวตามจำนวนวันที่ของจะอยู่ได้ ขีดดำคือเส้น KPI 25 วัน */
function Gauge({ days }: { days: number | null }) {
  if (days === null || !Number.isFinite(days)) return <span style={{ color: 'var(--ink-3)' }}>—</span>
  const max = 50
  const pct = Math.min(days / max, 1) * 100
  const cls = days < 7 ? 'low' : days > 25 ? 'over' : 'good'
  return (
    <div className="gauge" title={`${days.toFixed(1)} วัน`}>
      <div className={`fill ${cls}`} style={{ width: `${pct}%` }} />
      <div className="kpi" style={{ left: `${(25 / max) * 100}%` }} />
      <div className="val">{days > max ? `${max}+` : days.toFixed(0)}</div>
    </div>
  )
}

export default function Run({ snapshotDate }: { snapshotDate: string }) {
  const [tripDate, setTripDate] = useState(snapshotDate)
  const [runId, setRunId] = useState<string | null>(null)
  const [lines, setLines] = useState<Line[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [diag, setDiag] = useState<string[] | null>(null)
  const [kpi, setKpi] = useState<Kpi | null>(null)
  const [offT, setOffT] = useState<OffT[]>([])
  const [short, setShort] = useState<Short[]>([])
  const [incoming, setIncoming] = useState<Incoming[]>([])
  const [rem, setRem] = useState<Rem[]>([])
  const [info, setInfo] = useState<RunInfo | null>(null)
  const [coverOpt, setCoverOpt] = useState('early')
  const [useDepot, setUseDepot] = useState(true)
  const [cov, setCov] = useState({ early: 20, late: 7, lead: 3, split: 21, fixed: 10.1 })
  const [ss, setSs] = useState({ a: 1, boost: 1 })
  const [showRem, setShowRem] = useState(false)
  const [exPlant, setExPlant] = useState('')
  const [exMat, setExMat] = useState('')
  const [ex, setEx] = useState<Explain | null>(null)
  const [exErr, setExErr] = useState('')
  const [exBusy, setExBusy] = useState(false)
  const [stOpts, setStOpts] = useState<Option[]>([])
  const [itOpts, setItOpts] = useState<Option[]>([])
  const [meta, setMeta] = useState<Meta | null>(null)
  const [after, setAfter] = useState<ShortAfter[]>([])
  const [off, setOff] = useState<OffAlert[]>([])
  const [only, setOnly] = useState<'order' | 'all'>('order')
  const [q, setQ] = useState('')
  const [pickMats, setPickMats] = useState<Set<string>>(new Set())
  const [showFilter, setShowFilter] = useState(false)
  const [sortKey, setSortKey] = useState<SortKey>('none')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  useEffect(() => setTripDate(snapshotDate), [snapshotDate])

  /** เปิดหน้ามาแล้วโหลดผลรอบล่าสุดของวันนั้นเลย ไม่ต้องกดคำนวณใหม่
   *  จะกดใหม่ก็ต่อเมื่อข้อมูลเปลี่ยนหรืออยากคำนวณซ้ำ */
  useEffect(() => {
    let dead = false
    setMeta(null); setLines([]); setKpi(null); setOffT([]); setShort([]); setAfter([])
    supabase.rpc('latest_run_for', { p_trip_date: tripDate }).then(async ({ data }) => {
      if (dead || !Array.isArray(data) || !data.length) return
      const m = data[0] as Meta
      setMeta(m)
      setRunId(m.run_id)
      await loadAll(m.run_id)
    })
    return () => { dead = true }
  }, [tripDate])

  /** ค่า CoverDay ของแต่ละช่วง ใช้แสดงข้างช่องติ๊ก */
  useEffect(() => {
    supabase.from('settings').select('key, value')
      .in('key', ['month_early_cover', 'month_late_cover', 'lead_time',
                  'month_split_day', 'cover_fixed', 'ss_class_a', 'ss_booster'])
      .then(({ data }) => {
        const m = Object.fromEntries((data ?? []).map((x) => [x.key, Number(x.value)]))
        setCov({
          early: m.month_early_cover ?? 20, late: m.month_late_cover ?? 7,
          lead: m.lead_time ?? 3, split: m.month_split_day ?? 21,
          fixed: m.cover_fixed ?? 10.1,
        })
        setSs({ a: m.ss_class_a ?? 1, boost: m.ss_booster ?? 1 })
      })
  }, [])

  /** รายชื่อสาขาและสินค้าสำหรับช่องค้นหา โหลดครั้งเดียว */
  useEffect(() => {
    supabase.from('stations').select('plant_code, branch_name')
      .eq('is_active', true).order('branch_name')
      .then(({ data }) => setStOpts((data ?? []).map((r) => ({
        value: r.plant_code as string,
        label: (r.branch_name as string) || (r.plant_code as string),
      }))))
    supabase.from('items').select('mat_code, template_descr, desc_th, desc_en')
      .eq('is_active', true).order('mat_code')
      .then(({ data }) => setItOpts((data ?? []).map((r) => ({
        value: r.mat_code as string,
        label: (r.template_descr ?? r.desc_th ?? r.desc_en ?? r.mat_code) as string,
      }))))
  }, [])

  useEffect(() => {
    supabase.rpc('incoming_summary').then(({ data }) => {
      if (Array.isArray(data)) setIncoming(data as Incoming[])
    })
  }, [])

  /** เปิดหน้ามาแล้วโหลดผลคำนวณเดิมของวันนั้นเลย ไม่ต้องกดใหม่ */
  useEffect(() => {
    let dead = false
    setLines([]); setRunId(null); setKpi(null); setOffT([]); setShort([]); setRem([])
    supabase.rpc('latest_run', { p_trip_date: tripDate }).then(async ({ data }) => {
      if (dead) return
      const r = (data as RunInfo) ?? { found: false }
      setInfo(r)
      // ใช้โหมดของรอบเดิมถ้ามี ไม่งั้นให้ระบบเดาจากวันที่
      setCoverOpt(r.cover_opt && r.cover_opt !== 'auto'
        ? r.cover_opt : (r.suggest_cover ?? 'early'))
      setUseDepot(r.used_depot ?? r.has_depot ?? true)
      if (!r.found || !r.run_id) return
      setRunId(r.run_id)
      const n = await load(r.run_id)
      if (n > 0) await loadExtras(r.run_id)
    })
    return () => { dead = true }
  }, [tripDate])

  async function loadExtras(id: string) {
    const [{ data: k }, { data: o }, { data: sh }, { data: rm }] = await Promise.all([
      supabase.rpc('kpi_for_run', { p_run_id: id }),
      supabase.rpc('offtemplate_alert', { p_run_id: id }),
      supabase.rpc('depot_shortage', { p_run_id: id }),
      supabase.rpc('remaining_short', { p_run_id: id }),
    ])
    if (Array.isArray(k) && k.length) setKpi(k[0] as Kpi)
    if (Array.isArray(o)) setOffT(o as OffT[])
    if (Array.isArray(sh)) setShort(sh as Short[])
    if (Array.isArray(rm)) setRem(rm as Rem[])
  }

  async function calculate() {
    setBusy(true); setErr(''); setLines([]); setRunId(null); setDiag(null); setKpi(null); setOffT([]); setShort([]); setOff([])
    try {
      const { data, error } = await supabase.rpc('calculate_replenishment', {
        p_trip_date: tripDate,
        p_snapshot_date: snapshotDate,
        p_created_by: (await supabase.auth.getUser()).data.user?.id ?? null,
        p_cover: coverOpt,
        p_use_depot: useDepot,
      })
      if (error) throw new Error(error.message)
      setRunId(data as string)
      setMeta(null)
      const n = await load(data as string)
      if (n === 0) await explainEmpty()
      else {
        // KPI ต้องนับทั้งพอร์ต ไม่ใช่เฉพาะสาขาที่รถเข้ารอบนี้
        const [{ data: k }, { data: o }] = await Promise.all([
          supabase.rpc('kpi_for_run', { p_run_id: data }),
          supabase.rpc('offtemplate_alert', { p_run_id: data }),
        ])
        if (Array.isArray(k) && k.length) setKpi(k[0] as Kpi)
        setOff((o ?? []) as OffAlert[])
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally { setBusy(false) }
  }

  /** โหลดผลของรอบที่คำนวณไว้แล้ว */
  async function loadAll(id: string) {
    const n = await load(id)
    if (n === 0) return
    const [{ data: k }, { data: o }, { data: sh }, { data: af }] = await Promise.all([
      supabase.rpc('kpi_for_run', { p_run_id: id }),
      supabase.rpc('offtemplate_alert', { p_run_id: id }),
      supabase.rpc('depot_shortage', { p_run_id: id }),
      supabase.rpc('short_after_run', { p_run_id: id }),
    ])
    if (Array.isArray(k) && k.length) setKpi(k[0] as Kpi)
    if (Array.isArray(o)) setOffT(o as OffT[])
    if (Array.isArray(sh)) setShort(sh as Short[])
    if (Array.isArray(af)) setAfter(af as ShortAfter[])
  }

  async function load(id: string) {
    const { data, error } = await supabase
      .from('calc_lines')
      .select('*, stations(branch_name), items(desc_en, template_descr, exclude_from_template, is_booster, units_per_case)')
      .eq('run_id', id)
      .order('priority').order('plant_code')
    if (error) { setErr(error.message); return 0 }
    const rows = (data ?? []).map((r: Record<string, unknown>) => {
      const it = r.items as {
        desc_en: string; template_descr: string | null
        exclude_from_template: boolean; is_booster: boolean; units_per_case: number
      } | null
      return {
        ...(r as unknown as Line),
        branch_name: (r.stations as { branch_name: string } | null)?.branch_name,
        item_desc: it?.template_descr ?? it?.desc_en,
        off_template: it?.exclude_from_template ?? false,
        is_booster: it?.is_booster ?? false,
        units_per_case: it?.units_per_case ?? 1,
      }
    })
    setLines(rows)
    return rows.length
  }

  /** คำนวณแล้วได้ 0 บรรทัด — ไล่หาว่าติดตรงไหน แทนที่จะเงียบ */
  async function explainEmpty() {
    const snaps = await supabase.from('stock_snapshots')
      .select('class_fix', { count: 'exact' }).eq('snapshot_date', snapshotDate)
    const trips = await supabase.from('delivery_plan')
      .select('plant_code', { count: 'exact', head: true }).eq('trip_date', tripDate)
    const settings = await supabase.from('settings')
      .select('key, value').in('key', ['include_class_a', 'include_class_b', 'include_class_c'])

    const rows = (snaps.data ?? []) as { class_fix: string | null }[]
    const byClass = rows.reduce<Record<string, number>>((a, r) => {
      const k = r.class_fix ?? 'ไม่มีคลาส'; a[k] = (a[k] ?? 0) + 1; return a
    }, {})
    const on = (settings.data ?? [])
      .filter((s) => Number(s.value) === 1)
      .map((s) => s.key.replace('include_class_', 'Class ').toUpperCase())

    const msgs: string[] = []
    if (!rows.length) {
      msgs.push(`ไม่มีข้อมูลสต็อกของวันที่ ${snapshotDate} — อัปโหลดไฟล์ POWER_BI ก่อน`)
    } else {
      msgs.push('สต็อกที่มี: ' + Object.entries(byClass).map(([k, v]) => `${k} ${v}`).join(' · '))
      if (byClass['ไม่มีคลาส']) {
        msgs.push(`มี ${byClass['ไม่มีคลาส']} แถวที่ไม่มีคลาส — เป็นข้อมูลเก่าก่อนอัปเดตระบบ ให้อัปโหลดไฟล์ POWER_BI ใหม่อีกครั้ง`)
      }
    }
    if (!trips.count) {
      msgs.push(`ไม่มีแผนเที่ยวรถของวันที่ ${tripDate} — อัปโหลดไฟล์เที่ยวรถ โดยตั้งวันที่ให้ตรงกัน`)
    } else {
      msgs.push(`สาขาที่รถเข้าวันนี้: ${trips.count} แห่ง`)
    }
    msgs.push('คลาสที่เปิดให้คำนวณ: ' + (on.length ? on.join(', ') : 'ไม่ได้เปิดเลย — ตั้งค่าที่หน้า KPI และค่าคำนวณ'))
    setDiag(msgs)
  }

  async function adjust(line: Line, value: number) {
    const add = value - line.suggested_pcs
    setLines((p) => p.map((l) => l.id === line.id
      ? { ...l, manual_add: add, final_pcs: Math.max(value, 0) } : l))
    await supabase.from('calc_lines').update({ manual_add: add }).eq('id', line.id)
  }

  /** รายการที่เข้าเทมเพลตหลัก — ตัดสินค้าที่ต้องสั่งแยกออก */
  const mainLines = useMemo(() => lines.filter((l) => !l.off_template), [lines])

  /** รายชื่อสินค้าในผลลัพธ์ ใช้ทำปุ่มกรอง เรียงตามจำนวนบรรทัด */
  const matList = useMemo(() => {
    const m = new Map<string, { name: string; n: number; qty: number }>()
    mainLines.forEach((l) => {
      const e = m.get(l.mat_code) ?? { name: l.item_desc ?? l.mat_code, n: 0, qty: 0 }
      e.n++; e.qty += l.final_pcs
      m.set(l.mat_code, e)
    })
    return [...m.entries()].sort((a, b) => b[1].n - a[1].n)
  }, [mainLines])

  function sortBy(k: SortKey) {
    if (k === sortKey) {
      if (sortDir === 'desc') setSortDir('asc')
      else { setSortKey('none'); setSortDir('desc') }   // กดครั้งที่สามกลับเป็นลำดับเดิม
    } else {
      setSortKey(k)
      setSortDir(typeof mainLines[0]?.[k] === 'number' ? 'desc' : 'asc')
    }
  }

  const shown = useMemo(() => {
    let rows = only === 'order' ? mainLines.filter((l) => l.final_pcs > 0) : mainLines
    if (pickMats.size) rows = rows.filter((l) => pickMats.has(l.mat_code))
    const t = q.trim().toLowerCase()
    if (t) rows = rows.filter((l) =>
      `${l.branch_name ?? ''} ${l.item_desc ?? ''} ${l.plant_code} ${l.mat_code} ${l.flag ?? ''}`
        .toLowerCase().includes(t))

    if (sortKey === 'none') return rows
    const dir = sortDir === 'asc' ? 1 : -1
    return [...rows].sort((a, b) => {
      const x = a[sortKey], y = b[sortKey]
      if (x === null || x === undefined) return 1
      if (y === null || y === undefined) return -1
      if (typeof x === 'number' && typeof y === 'number') return (x - y) * dir
      return String(x).localeCompare(String(y), 'th') * dir
    })
  }, [mainLines, only, pickMats, q, sortKey, sortDir])

  /** เตือนถ้ายังไม่ได้อัป Master Item ใหม่ — จำนวนต่อลังจะเป็น 1 หมด */
  const caseWarning = useMemo(
    () => lines.some((l) => l.is_booster && (l.units_per_case ?? 1) <= 1),
    [lines]
  )

  const stats = useMemo(() => {
    const ordered = mainLines.filter((l) => l.final_pcs > 0)
    return {
      lines: mainLines.length,
      stations: new Set(ordered.map((l) => l.plant_code)).size,
      pieces: ordered.reduce((s, l) => s + l.final_pcs, 0),
    }
  }, [mainLines])

  /** ออกไฟล์ตามเทมเพลต 25 คอลัมน์ที่ใช้กับระบบจริง */
  async function exportTemplate() {
    if (!runId) return
    setBusy(true)
    try {
      const [{ data: rows, error }, { data: cfgRows }] = await Promise.all([
        supabase.from('v_order_template').select('*').eq('run_id', runId)
          .order('po_group').order('mat_code'),
        supabase.from('template_config').select('key, value'),
      ])
      if (error) throw new Error(error.message)
      if (!rows?.length) { setErr('ไม่มีรายการที่ต้องส่ง'); return }

      const cfg = Object.fromEntries((cfgRows ?? []).map((c) => [c.key, c.value]))

      // วันที่รูปแบบ 17.08.2026 — วันและเดือนสองหลักเสมอ
      const [yy, mm, dd] = tripDate.split('-')
      const d = `${dd.padStart(2, '0')}.${mm.padStart(2, '0')}.${yy}`

      // PO GROUP เริ่มนับ 1 ใหม่ทุกครั้ง เรียงตามสาขา
      const groups = new Map<string, number>()
      const out = rows.map((r) => {
        if (!groups.has(r.plant_code)) groups.set(r.plant_code, groups.size + 1)
        return {
          'UDC_POTYPE': cfg['UDC_POTYPE'] ?? 'ZIN3',
          'UDC_Vendor_Code': cfg['UDC_Vendor_Code'] ?? 'Z1101',
          'Descr': cfg['Descr'] ?? '',
          'Pur org': cfg['Pur org'] ?? '1000',
          'Pur group': cfg['Pur group'] ?? '140',
          'Currency': cfg['Currency'] ?? 'THB',
          '*PO GROUP': groups.get(r.plant_code),
          'Multi Group': '',
          'Sequence No.': cfg['Sequence No.'] ?? '1',
          '': r.plant_code,
          ' ': r.shipto_name,
          '*ITEM': r.mat_code,
          'Item Descr': r.item_descr,
          'QTY(TransferUOM)': r.qty,
          'UOM': r.uom,
          'UDC_FREEMARK': '',
          'SchedShipDate': d,
          'SCHEDARRIVDATE': d,
          'UDC_STORLOC': cfg['UDC_STORLOC'] ?? '4001',
          'UDC_TAXCODE': cfg['UDC_TAXCODE'] ?? 'V7',
          'UDC_VALUTYPE': '',
          'UDC_SHIPPOINT': '',
          'UDC_TRUCKSIZE': '',
          '*Shipto': '',
          'UDC_SEPARATE': '',
        }
      })

      const ws = XLSX.utils.json_to_sheet(out)
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, ws, 'template')
      XLSX.writeFile(wb, `PO_${tripDate.replace(/-/g, '')}.xlsx`)
      await supabase.from('calc_runs')
        .update({ exported_at: new Date().toISOString() }).eq('run_id', runId)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally { setBusy(false) }
  }

  /** ตรวจว่าบรรทัดหนึ่งคำนวณออกมาแบบนี้เพราะอะไร */
  async function explain() {
    if (!exPlant.trim() || !exMat.trim()) return
    setExBusy(true); setExErr(''); setEx(null)
    try {
      const { data, error } = await supabase.rpc('explain_line', {
        p_plant: exPlant.trim(), p_mat: exMat.trim(), p_trip: tripDate,
      })
      if (error) { setExErr(error.message); return }
      if (!data) { setExErr('ฐานข้อมูลไม่ได้ส่งข้อมูลกลับมา'); return }
      setEx(data as Explain)
    } catch (e) {
      setExErr(e instanceof Error ? e.message : String(e))
    } finally {
      setExBusy(false)
    }
  }


  /** สินค้าที่ใช้เทมเพลตคนละแบบ ออกเป็นไฟล์ต่างหาก */
  async function exportOffTemplate() {
    if (!runId) return
    const { data, error } = await supabase.from('v_offtemplate_lines')
      .select('*').eq('run_id', runId).order('branch_name')
    if (error) { setErr(error.message); return }
    if (!data?.length) return
    const [yy, mm, dd] = tripDate.split('-')
    const d = `${dd.padStart(2, '0')}.${mm.padStart(2, '0')}.${yy}`
    const ws = XLSX.utils.json_to_sheet(data.map((r) => ({
      'วันที่ส่ง': d,
      'PlantCode': r.plant_code,
      'สาขา': r.branch_name,
      'รหัสสินค้า': r.mat_code,
      'สินค้า': r.item_descr,
      'คงเหลือ': r.on_hand_pcs,
      'ระหว่างทาง': r.in_transit_pcs,
      'จำนวนที่ต้องสั่ง': r.qty,
      'หน่วย': r.uom,
    })))
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'สั่งแยก')
    XLSX.writeFile(wb, `สั่งแยก_${tripDate.replace(/-/g, '')}.xlsx`)
  }

  return (
    <>
      <h2>คำนวณยอดเติม</h2>
      <p className="lede">
        คำนวณเฉพาะสาขาที่มีรถเข้าในวันที่เลือก ปรับยอดรายบรรทัดได้ก่อน export
      </p>

      <div className="card">
        <div className="row">
          <label style={{ fontSize: 13 }}>รถออกวันที่</label>
          <input type="date" value={tripDate} onChange={(e) => setTripDate(e.target.value)} />
          <span style={{ color: 'var(--ink-3)', fontSize: 12.5 }}>ใช้สต็อก ณ {snapshotDate}</span>

          <select value={coverOpt} onChange={(e) => setCoverOpt(e.target.value)}
            style={{ minWidth: 200 }} title="เกณฑ์ที่ใช้กำหนด CoverDay ของรอบนี้">
            {COVER_OPTS.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
          </select>

          <label style={{
            display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer',
            padding: '6px 12px', borderRadius: 6,
            background: useDepot ? 'var(--ok-bg)' : 'transparent',
            border: `1px solid ${useDepot ? 'var(--ok-line)' : 'var(--rule-2)'}`,
          }}>
            <input type="checkbox" checked={useDepot}
              onChange={(e) => setUseDepot(e.target.checked)} />
            <span style={{ fontSize: 14 }}>จำกัดตามสต็อกคลัง</span>
          </label>

          <button className={`btn ${meta && !meta.data_changed ? 'ghost' : ''}`}
            onClick={calculate} disabled={busy}>
            {busy ? 'กำลังคำนวณ…' : meta ? 'คำนวณใหม่' : 'คำนวณ'}
          </button>
        </div>

        {/* อธิบายให้ชัดว่ารอบนี้คิดยังไง ใช้กี่วัน SS กี่ชิ้น */}
        <div className="note" style={{ marginTop: 12 }}>
          {(() => {
            const o = COVER_OPTS.find((x) => x.v === coverOpt)!
            const fixed = coverOpt === 'early' ? cov.early
              : coverOpt === 'late' ? cov.late
              : coverOpt === 'fixed' ? cov.fixed : null
            return (
              <>
                <strong>วิธีคิดรอบนี้</strong>{' — '}
                {fixed !== null ? (
                  <>เติมให้พอขาย <strong>{fixed + cov.lead} วัน</strong>{' '}
                    (CoverDay {fixed} + LeadTime {cov.lead})</>
                ) : (
                  <>CoverDay ต่างกันรายสาขาตาม {o.label} แล้วบวก LeadTime {cov.lead} วัน
                    {' — '}{o.hint}</>
                )}
                {' · '}บวก Safety stock <strong>{ss.a} ชิ้น</strong> ต่อบรรทัด
                {' (หัวเชื้อ ' + ss.boost + ' ชิ้น)'}
                {' · '}หักของบนชั้นและของระหว่างทางออก
                {' · '}
                <strong style={{ color: useDepot ? 'var(--ok)' : 'var(--oil)' }}>
                  {useDepot ? 'จำกัดไม่ให้เกินสต็อกคลัง' : 'ไม่จำกัดตามสต็อกคลัง'}
                </strong>
              </>
            )
          })()}
        </div>
        {meta && (
          <div className={`note ${meta.data_changed ? 'bad' : ''}`} style={{ marginTop: 12 }}>
            {meta.data_changed ? (
              <>มีการนำเข้าข้อมูลใหม่หลังคำนวณรอบนี้ — ควรกดคำนวณใหม่เพื่อให้ตัวเลขตรงกับข้อมูลล่าสุด</>
            ) : (
              <>
                ผลจากรอบที่คำนวณเมื่อ{' '}
                {new Date(meta.created_at).toLocaleString('th-TH', {
                  day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
                })}
                {' · '}{meta.line_count} บรรทัด
                {meta.exported ? ' · ออกไฟล์แล้ว' : ' · ยังไม่ได้ออกไฟล์'}
                {' — ข้อมูลยังไม่เปลี่ยน ไม่ต้องคำนวณใหม่'}
              </>
            )}
          </div>
        )}

        {info?.suggest_cover && coverOpt !== info.suggest_cover
          && (coverOpt === 'early' || coverOpt === 'late') && (
          <div className="note" style={{ marginTop: 12 }}>
            วันที่ {tripDate.slice(-2)} ระบบเดาว่าควรใช้เกณฑ์
            {info.suggest_cover === 'early' ? ' ต้นเดือน' : ' ปลายเดือน'}
            {' '}(ตัดที่วันที่ {cov.split}) แต่คุณเลือก
            {coverOpt === 'early' ? ' ต้นเดือน' : ' ปลายเดือน'} — จะใช้ตามที่เลือก
          </div>
        )}

        {info?.found && (
          <div className={`note ${info.stale ? 'bad' : 'good'}`} style={{ marginTop: 12 }}>
            {info.stale ? (
              <>
                ข้อมูลเปลี่ยนไปหลังคำนวณครั้งล่าสุด — {(info.reasons ?? []).join(' · ')}
                {' '}ควรกดคำนวณใหม่
              </>
            ) : (
              <>
                ใช้ผลคำนวณเมื่อ{' '}
                {new Date(info.created_at!).toLocaleString('th-TH', {
                  day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
                })}
                {' · '}{info.lines} บรรทัด
                {info.cover_opt && info.cover_opt !== 'auto' &&
                  ` · เกณฑ์${COVER_OPTS.find((x) => x.v === info.cover_opt)?.label ?? info.cover_opt}`}
                {info.used_depot === false && ' · ไม่จำกัดตามคลัง'}
                {info.exported ? ' · ออกไฟล์แล้ว' : ' · ยังไม่ได้ออกไฟล์'}
                {' · ข้อมูลยังไม่เปลี่ยน ไม่ต้องคำนวณใหม่'}
              </>
            )}
          </div>
        )}

        {err && <div className="note bad" style={{ marginTop: 12, whiteSpace: 'pre-line' }}>{err}</div>}

        {incoming.some((i) => i.qty > 0) && (
          <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--line)' }}>
            <p className="hint" style={{ marginBottom: 8 }}>
              ของระหว่างทางที่ระบบหักออกจากยอดสั่งแล้ว
            </p>
            <div className="row" style={{ gap: 18 }}>
              {incoming.filter((i) => i.qty > 0).map((i) => (
                <span key={i.source} style={{ fontSize: 12.5, color: 'var(--ink-2)' }}>
                  {i.source}{' '}
                  <strong style={{ fontFamily: 'var(--mono)' }}>
                    {Number(i.qty).toLocaleString()}
                  </strong>{' '}
                  ชิ้น · {i.stations} สาขา
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      {diag && (
        <div className="card">
          <h3>คำนวณแล้วไม่พบรายการ</h3>
          <p className="hint">ไม่มีบรรทัดไหนเข้าเงื่อนไขครบทั้งสามข้อ: มีสต็อก · รถเข้าวันนี้ · อยู่ในคลาสที่เปิดไว้</p>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: 'var(--ink-2)' }}>
            {diag.map((m, i) => <li key={i} style={{ marginBottom: 4 }}>{m}</li>)}
          </ul>
        </div>
      )}

      {lines.length > 0 && (
        <>
          <dl className="stats">
            <div className="stat">
              <dt>สาขาที่ต้องส่ง</dt>
              <dd>{stats.stations}{kpi && <small> / {kpi.stations_total}</small>}</dd>
            </div>
            <div className="stat">
              <dt>รวมที่ต้องเติม</dt>
              <dd>{stats.pieces.toLocaleString()} <small>ชิ้น</small></dd>
            </div>
            <div className="stat">
              <dt>Availability ก่อนส่ง</dt>
              <dd style={{ color: 'var(--ink-2)' }}>
                {kpi ? kpi.avail_before?.toFixed(1) : '—'}<small>%</small>
              </dd>
            </div>
            <div className="stat">
              <dt>Availability หลังส่ง</dt>
              <dd style={{ color: kpi && kpi.avail_after >= 97 ? 'var(--ok)' : 'var(--alarm)' }}>
                {kpi ? kpi.avail_after?.toFixed(1) : '—'}<small>%</small>
              </dd>
            </div>
            <div className="stat"
              style={{ cursor: rem.length ? 'pointer' : undefined }}
              onClick={() => rem.length && setShowRem(!showRem)}>
              <dt>ยังขาดหลังส่ง {rem.length > 0 && (showRem ? '▲' : '▼')}</dt>
              <dd style={{ color: kpi && kpi.short_off_trip ? 'var(--alarm)' : undefined }}>
                {kpi ? kpi.short_off_trip : '—'}
              </dd>
            </div>
            <div className="stat">
              <dt>DOH ก่อน → หลัง</dt>
              <dd style={{ color: 'var(--oil)', fontSize: 19 }}>
                {kpi ? `${kpi.doh_before?.toFixed(0)} → ${kpi.doh_after?.toFixed(0)}` : '—'}
                <small> วัน</small>
              </dd>
            </div>
          </dl>

          {kpi && (
            <div className={`note ${kpi.avail_after >= 97 ? 'good' : 'bad'}`} style={{ marginBottom: 14 }}>
              นับทั้ง {kpi.stations_total} สาขาที่ดูแล {kpi.total_lines.toLocaleString()} บรรทัด —
              รอบนี้รถเข้า {kpi.stations_on_trip} สาขา
              {' · '}ของขาดตอนนี้ {kpi.short_total} บรรทัด
              {' '}(รอบนี้แก้ได้ {kpi.fixed_here}
              {kpi.short_off_trip > 0 && <>, อีก {kpi.short_off_trip} อยู่ในสาขาที่รถไม่ได้เข้า ต้องรอรอบหน้า</>})
              {kpi.avail_after < 97 && <> — ยังไม่ถึงเป้า 97%</>}
            </div>
          )}

          {off.length > 0 && (
            <div className="card" style={{ marginBottom: 14, borderColor: 'var(--oil)' }}>
              <div className="spread">
                <div>
                  <h3>ต้องสั่งแยก — ใช้เทมเพลตนี้ไม่ได้</h3>
                  <p className="hint">
                    ไม่รวมอยู่ในไฟล์เทมเพลตหลัก ต้องสั่งด้วยรูปแบบอื่นต่างหาก
                    · นับของขาดจากทุกสาขาที่ดูแล ไม่ใช่เฉพาะรอบนี้
                  </p>
                </div>
                <button className="btn ghost" onClick={() => void exportOffTemplate()}>
                  ดาวน์โหลดรายการ
                </button>
              </div>
              <table>
                <thead>
                  <tr>
                    <th>สินค้า</th><th className="num">มีของ</th>
                    <th className="num">ขาด</th><th className="num">ขาดในสาขาที่รถเข้า</th>
                    <th className="num">รอบนี้ต้องสั่ง</th>
                  </tr>
                </thead>
                <tbody>
                  {off.map((o) => (
                    <tr key={o.mat_code}>
                      <td>{o.item_descr}</td>
                      <td className="num">{o.in_stock} / {o.stations_total}</td>
                      <td className="num" style={{
                        color: o.short_total ? 'var(--alarm)' : undefined, fontWeight: 600,
                      }}>
                        {o.short_total}
                      </td>
                      <td className="num" style={{ color: 'var(--ink-3)' }}>{o.short_on_trip}</td>
                      <td className="num">
                        {o.order_qty ? `${o.order_qty.toLocaleString()} ${o.uom ?? ''}` : '—'}
                        {o.order_lines ? (
                          <span style={{ color: 'var(--ink-3)' }}> · {o.order_lines} สาขา</span>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {off.some((o) => o.short_total > 0) && (
                <div className="note bad" style={{ marginTop: 12 }}>
                  ของขาดรวม {off.reduce((s, o) => s + o.short_total, 0)} สาขา —
                  อย่าลืมสั่งแยก ไม่งั้นจะขาดต่อไปเพราะไม่ได้อยู่ในไฟล์เทมเพลต
                </div>
              )}
            </div>
          )}

          {caseWarning && (
            <div className="note bad" style={{ marginBottom: 14 }}>
              หัวเชื้อยังมีจำนวนต่อลังเป็น 1 — แปลว่ายังไม่ได้อัปโหลดไฟล์ Master Item ใหม่
              ระบบจึงยังไม่ปัดเป็นลังเต็ม 24 ให้ · อัปไฟล์ Master Item แล้วคำนวณใหม่อีกครั้ง
            </div>
          )}

          {after.length > 0 && (
            <div className="card" style={{ marginBottom: 14 }}>
              <div className="spread">
                <div>
                  <h3>ยังขาดหลังส่งรอบนี้</h3>
                  <p className="hint">
                    บรรทัดที่ของยังเป็น 0 หลังรอบนี้จบ · เรียงตามรถไม่เข้ามานานสุด
                  </p>
                </div>
                <button className="btn ghost" onClick={() => {
                  const ws = XLSX.utils.json_to_sheet(after.map((x) => ({
                    'จังหวัด': x.province, 'ผจก.เขต': x.area,
                    'PlantCode': x.plant_code, 'สาขา': x.branch_name,
                    'รหัสสินค้า': x.mat_code, 'สินค้า': x.item_name,
                    'ขาย/วัน': x.sales_per_day, 'ของกำลังมา': x.incoming,
                    'คลังมี': x.depot_stock,
                    'รถไม่เข้า(วัน)': x.days_since_trip > 9000 ? '' : x.days_since_trip,
                    'รอบนี้รถเข้า': x.on_trip ? 'ใช่' : 'ไม่',
                    'สาเหตุ': x.reason,
                  })))
                  const wb = XLSX.utils.book_new()
                  XLSX.utils.book_append_sheet(wb, ws, 'ยังขาด')
                  XLSX.writeFile(wb, `ยังขาด_${tripDate.replace(/-/g, '')}.xlsx`)
                }}>ดาวน์โหลด</button>
              </div>

              <div className="row" style={{ gap: 8, margin: '4px 0 14px' }}>
                {Object.entries(
                  after.reduce<Record<string, number>>((a2, x) => {
                    a2[x.reason] = (a2[x.reason] ?? 0) + 1; return a2
                  }, {})
                ).sort((x, y) => y[1] - x[1]).map(([r, n]) => (
                  <span key={r} className={`tag ${r === 'ของกำลังมา' ? 'oil' : 'alarm'}`}>
                    {r} {n}
                  </span>
                ))}
              </div>

              <div className="tw" style={{ maxHeight: '42vh' }}>
                <table>
                  <thead>
                    <tr>
                      <th>สาขา</th><th>สินค้า</th>
                      <th className="num">ขาย/วัน</th>
                      <th className="num">กำลังมา</th><th className="num">คลังมี</th>
                      <th className="num">รถไม่เข้า</th><th>สาเหตุ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {after.map((x, i) => (
                      <tr key={i}>
                        <td>{x.branch_name}</td>
                        <td>{x.item_name}</td>
                        <td className="num">{x.sales_per_day}</td>
                        <td className="num" style={{ color: x.incoming ? 'var(--oil)' : 'var(--ink-3)' }}>
                          {x.incoming || '—'}
                        </td>
                        <td className="num" style={{ color: x.depot_stock ? 'var(--ok)' : 'var(--alarm)' }}>
                          {x.depot_stock}
                        </td>
                        <td className="num" style={{
                          color: x.days_since_trip > 14 && x.days_since_trip < 9000
                            ? 'var(--alarm)' : 'var(--ink-3)',
                        }}>
                          {x.days_since_trip > 9000 ? '—' : `${x.days_since_trip} วัน`}
                        </td>
                        <td>
                          <span className={`tag ${x.reason === 'ของกำลังมา' ? 'oil' : 'alarm'}`}>
                            {x.reason}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {showRem && rem.length > 0 && (
            <div className="card" style={{ marginBottom: 14 }}>
              <div className="spread">
                <div>
                  <h3>รายการที่ยังขาดหลังส่งรอบนี้</h3>
                  <p className="hint">
                    ของขาดในสาขาที่รถไม่ได้เข้ารอบนี้ จึงเติมไม่ได้ ·
                    ดูว่าตัวไหนมีของกำลังมาแล้ว ตัวไหนต้องรอรถรอบหน้า
                  </p>
                </div>
                <button className="btn ghost" onClick={() => {
                  const ws = XLSX.utils.json_to_sheet(rem.map((r) => ({
                    'จังหวัด': r.province, 'PlantCode': r.plant_code, 'สาขา': r.branch_name,
                    'รหัสสินค้า': r.mat_code, 'สินค้า': r.item_name,
                    'ขาย/วัน': r.sales_per_day, 'ของกำลังมา': r.incoming,
                    'คลังมี': r.depot_stock, 'รถไม่เข้า(วัน)': r.days_since_trip,
                    'สาเหตุ': r.reason,
                  })))
                  const wb = XLSX.utils.book_new()
                  XLSX.utils.book_append_sheet(wb, ws, 'ยังขาด')
                  XLSX.writeFile(wb, `ยังขาด_${tripDate.replace(/-/g, '')}.xlsx`)
                }}>ดาวน์โหลด</button>
              </div>

              <div className="row" style={{ gap: 8, margin: '4px 0 14px' }}>
                {Object.entries(rem.reduce<Record<string, number>>((a, r) => {
                  a[r.reason] = (a[r.reason] ?? 0) + 1; return a
                }, {})).sort((a, b) => b[1] - a[1]).map(([r, n]) => (
                  <span key={r} className={`tag ${
                    r === 'ของกำลังมา' ? 'oil'
                    : r === 'คลังมีของ รอรถรอบหน้า' ? 'ok' : 'alarm'}`}>
                    {r} {n}
                  </span>
                ))}
              </div>

              <div className="tw" style={{ maxHeight: '44vh' }}>
                <table>
                  <thead>
                    <tr>
                      <th>สาขา</th><th>สินค้า</th>
                      <th className="num">ขาย/วัน</th>
                      <th className="num">กำลังมา</th><th className="num">คลังมี</th>
                      <th className="num">รถไม่เข้า</th><th>สาเหตุ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rem.map((r, i) => (
                      <tr key={i}>
                        <td>{r.branch_name}</td>
                        <td>{r.item_name}</td>
                        <td className="num">{r.sales_per_day}</td>
                        <td className="num" style={{ color: r.incoming ? 'var(--oil)' : 'var(--ink-3)' }}>
                          {r.incoming || '—'}
                        </td>
                        <td className="num" style={{ color: r.depot_stock ? 'var(--ok)' : 'var(--alarm)' }}>
                          {r.depot_stock}
                        </td>
                        <td className="num" style={{
                          color: r.days_since_trip > 14 ? 'var(--alarm)' : 'var(--ink-3)',
                        }}>
                          {r.days_since_trip > 9000 ? '—' : `${r.days_since_trip} วัน`}
                        </td>
                        <td>
                          <span className={`tag ${
                            r.reason === 'ของกำลังมา' ? 'oil'
                            : r.reason === 'คลังมีของ รอรถรอบหน้า' ? 'ok' : 'alarm'}`}>
                            {r.reason}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {short.length > 0 && (
            <div className="card" style={{ marginBottom: 14 }}>
              <h3>คลังของไม่พอ</h3>
              <p className="hint">
                เกลี่ยให้สาขาที่ของขาดก่อน ในกลุ่มเดียวกันสาขาที่รถไม่เข้ามานานกว่าได้ก่อน
                — ที่เหลือต้องรอของเข้าคลัง
              </p>
              <table>
                <thead>
                  <tr>
                    <th>สินค้า</th><th className="num">ต้องการ</th><th className="num">คลังมี</th>
                    <th className="num">จ่ายได้</th><th className="num">ขาด</th>
                    <th className="num">สาขาที่ยังขาด</th>
                  </tr>
                </thead>
                <tbody>
                  {short.map((s) => (
                    <tr key={s.mat_code}>
                      <td>{s.item_name}</td>
                      <td className="num">{s.requested}</td>
                      <td className="num">{s.depot_stock}</td>
                      <td className="num" style={{ color: 'var(--ok)' }}>{s.allocated}</td>
                      <td className="num" style={{ color: 'var(--alarm)' }}>
                        <strong>{s.shortfall}</strong>
                      </td>
                      <td className="num" style={{ color: s.stations_out ? 'var(--alarm)' : undefined }}>
                        {s.stations_out || '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="note bad" style={{ marginTop: 12 }}>
                ขาดรวม {short.reduce((a, s) => a + s.shortfall, 0).toLocaleString()} ชิ้น
                จาก {short.length} SKU — ต้องแจ้งจัดหา ไม่ใช่ปัญหาการคำนวณ
              </div>
            </div>
          )}

          {offT.length > 0 && (
            <div className="card" style={{ marginBottom: 14 }}>
              <div className="spread">
                <div>
                  <h3>ต้องสั่งแยก ไม่อยู่ในเทมเพลตนี้</h3>
                  <p className="hint">
                    สินค้ากลุ่มนี้ใช้เทมเพลตคนละแบบ ไม่ถูกใส่ในไฟล์ export ปกติ
                    ต้องสั่งด้วยวิธีอื่น แต่ยังนับใน KPI ตามเดิม
                  </p>
                </div>
                {offT.some((o) => o.order_qty > 0) && (
                  <button className="btn ghost" onClick={() => void exportOffTemplate()}>
                    ดาวน์โหลดรายการ
                  </button>
                )}
              </div>
              <table>
                <thead>
                  <tr>
                    <th>สินค้า</th><th className="num">มีของ</th><th className="num">ขาด</th>
                    <th className="num">ครบ</th><th className="num">รอบนี้ต้องสั่ง</th>
                  </tr>
                </thead>
                <tbody>
                  {offT.map((o) => (
                    <tr key={o.mat_code}>
                      <td>{o.item_descr}</td>
                      <td className="num">{o.in_stock} / {o.stations_total}</td>
                      <td className="num" style={{ color: o.short ? 'var(--alarm)' : undefined }}>
                        {o.short}
                      </td>
                      <td className="num" style={{
                        color: o.coverage_pct >= 100 ? 'var(--ok)' : 'var(--alarm)', fontWeight: 600,
                      }}>
                        {o.coverage_pct?.toFixed(1)}%
                      </td>
                      <td className="num">
                        {o.order_qty ? `${o.order_qty} ชิ้น / ${o.order_lines} สาขา` : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {offT.some((o) => o.short > 0) ? (
                <div className="note bad" style={{ marginTop: 12 }}>
                  ของขาดรวม {offT.reduce((s, o) => s + o.short, 0)} สาขา —
                  ต้องสั่งแยกนอกเทมเพลตนี้ อย่าลืมทำ ไม่งั้นจะสะสมไปรอบหน้า
                </div>
              ) : (
                <div className="note good" style={{ marginTop: 12 }}>มีของครบทุกสาขา</div>
              )}
            </div>
          )}

          {kpi && (
            <div className="card" style={{ marginBottom: 14 }}>
              <h3>DOH — ดูแนวโน้ม ไม่ได้คุมในสูตร</h3>
              <p className="hint">
                รอบนี้ทำให้ DOH ขยับจาก {kpi.doh_before?.toFixed(1)} เป็น {kpi.doh_after?.toFixed(1)} วัน
                ({kpi.doh_after > kpi.doh_before ? '+' : ''}
                {(kpi.doh_after - kpi.doh_before).toFixed(1)})
              </p>
              <table>
                <tbody>
                  <tr>
                    <td style={{ width: 260 }}>บรรทัดที่ DOH เกิน 25 วัน</td>
                    <td className="num" style={{ width: 90, color: 'var(--oil)' }}>
                      {kpi.over_doh_lines}
                    </td>
                    <td style={{ color: 'var(--ink-3)', fontSize: 12.5 }}>
                      จาก {kpi.total_lines.toLocaleString()} บรรทัด
                    </td>
                  </tr>
                  <tr>
                    <td>ส่วนเกินเทียบเพดาน 25 วัน</td>
                    <td className="num" style={{ color: 'var(--oil)' }}>
                      {kpi.excess_liters?.toLocaleString()}
                    </td>
                    <td style={{ color: 'var(--ink-3)', fontSize: 12.5 }}>ลิตร</td>
                  </tr>
                  <tr>
                    <td>ของไม่ขายเลยใน 30 วัน</td>
                    <td className="num" style={{ color: 'var(--alarm)' }}>{kpi.dead_lines}</td>
                    <td style={{ color: 'var(--ink-3)', fontSize: 12.5 }}>
                      บรรทัด · {kpi.dead_liters?.toLocaleString()} ลิตร
                    </td>
                  </tr>
                </tbody>
              </table>
              <div className="note" style={{ marginTop: 12 }}>
                DOH ลดด้วยการสั่งน้อยลงไม่ได้ — ต่อให้หยุดสั่งทั้งเดือนก็ยังเกินเป้า
                เพราะส่วนใหญ่เป็นของที่กองอยู่แล้ว ต้องดึงออกหรือโอนเกลี่ยเท่านั้น
              </div>
            </div>
          )}

          <div className="row" style={{ marginBottom: 10 }}>
            <button className={`btn ${only === 'order' ? '' : 'ghost'}`}
              onClick={() => setOnly('order')}>เฉพาะที่ต้องเติม</button>
            <button className={`btn ${only === 'all' ? '' : 'ghost'}`}
              onClick={() => setOnly('all')}>ทั้งหมด</button>

            <input type="text" placeholder="ค้นหาสาขา สินค้า หรือสถานะ" value={q}
              onChange={(e) => setQ(e.target.value)} style={{ width: 230 }} />

            <button className={`btn ${pickMats.size || showFilter ? '' : 'ghost'}`}
              onClick={() => setShowFilter(!showFilter)}>
              กรองสินค้า{pickMats.size ? ` (${pickMats.size})` : ''}
            </button>

            {(pickMats.size > 0 || q || sortKey !== 'none') && (
              <button className="btn ghost" onClick={() => {
                setPickMats(new Set()); setQ(''); setSortKey('none'); setSortDir('desc')
              }}>ล้าง</button>
            )}

            <span style={{ fontSize: 13, color: 'var(--ink-3)' }}>
              {shown.length} บรรทัด · {shown.reduce((a, l) => a + l.final_pcs, 0).toLocaleString()} ชิ้น
            </span>

            <span style={{ flex: 1 }} />
            <button className="btn" onClick={exportTemplate} disabled={!stats.pieces}>
              ดาวน์โหลดเทมเพลต
            </button>
          </div>

          {showFilter && (
            <div className="card" style={{ marginBottom: 10, padding: '16px 18px' }}>
              <p className="hint" style={{ marginBottom: 10 }}>
                กดชื่อสินค้าเพื่อดูเฉพาะตัวนั้น กดหลายตัวได้ · ตัวเลขคือจำนวนบรรทัดและชิ้นที่ต้องส่ง
              </p>
              <div className="row" style={{ gap: 6 }}>
                {matList.map(([mat, m]) => (
                  <button key={mat}
                    className={`btn ${pickMats.has(mat) ? '' : 'ghost'}`}
                    style={{ padding: '5px 12px', fontSize: 13 }}
                    onClick={() => setPickMats((p) => {
                      const n = new Set(p)
                      n.has(mat) ? n.delete(mat) : n.add(mat)
                      return n
                    })}>
                    {m.name}
                    <span style={{ opacity: .6, marginLeft: 7 }}>{m.n} · {m.qty}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="tw">
            <table>
              <thead>
                <tr>
                  {([
                    ['branch_name', 'สาขา', false],
                    ['item_desc', 'สินค้า', false],
                    ['none', 'สถานะ', false],
                    ['on_hand_pcs', 'คงเหลือ', true],
                    ['in_transit_pcs', 'ระหว่างทาง', true],
                    ['sales_per_day', 'ขาย/วัน', true],
                    ['cover_day', 'คุ้ม(วัน)', true],
                    ['doh_before', 'DOH ก่อน', false],
                    ['suggested_pcs', 'ระบบคำนวณ', true],
                    ['final_pcs', 'ยอดส่งจริง', true],
                    ['doh_after', 'DOH หลัง', false],
                  ] as [SortKey, string, boolean][]).map(([k, label, num]) => (
                    <th key={label} className={num ? 'num' : undefined}
                      style={k === 'none' ? undefined : { cursor: 'pointer', userSelect: 'none' }}
                      title={k === 'none' ? undefined : 'กดเพื่อเรียง'}
                      onClick={() => k !== 'none' && sortBy(k)}>
                      {label}
                      {sortKey === k && (
                        <span style={{ marginLeft: 4, color: 'var(--brand)' }}>
                          {sortDir === 'desc' ? '▼' : '▲'}
                        </span>
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.map((l) => {
                  const p = PRIORITY[l.priority as 1 | 2 | 3 | 4] ?? PRIORITY[4]
                  return (
                    <tr key={l.id} style={{ cursor: 'pointer' }}
                      title="กดเพื่อดูว่าบรรทัดนี้คำนวณยังไง"
                      onClick={(e) => {
                        if ((e.target as HTMLElement).tagName === 'INPUT') return
                        setExPlant(l.plant_code); setExMat(l.mat_code)
                        setExBusy(true); setExErr(''); setEx(null)
                        void supabase.rpc('explain_line', {
                          p_plant: l.plant_code, p_mat: l.mat_code, p_trip: tripDate,
                        }).then(({ data, error }) => {
                          if (error) setExErr(error.message)
                          else if (!data) setExErr('ฐานข้อมูลไม่ได้ส่งข้อมูลกลับมา')
                          else setEx(data as Explain)
                          setExBusy(false)
                        })
                      }}>
                      <td>{l.branch_name ?? l.plant_code}</td>
                      <td>{l.item_desc ?? l.mat_code}</td>
                      <td><span className={`tag ${p.cls}`}>{l.flag ?? p.label}</span></td>
                      <td className="num">{l.on_hand_pcs}</td>
                      <td className="num">{l.in_transit_pcs || ''}</td>
                      <td className="num">{l.sales_per_day.toFixed(2)}</td>
                      <td className="num">{l.cover_day.toFixed(0)}</td>
                      <td><Gauge days={l.doh_before} /></td>
                      <td className="num" style={{ color: 'var(--ink-3)' }}>{l.suggested_pcs}</td>
                      <td className="num">
                        <input
                          type="number" min={0} value={l.final_pcs}
                          onChange={(e) => adjust(l, parseInt(e.target.value || '0', 10))}
                        />
                      </td>
                      <td><Gauge days={l.doh_after} /></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <div className="card" style={{ marginTop: 20 }}>
            <h3>ตรวจบรรทัด</h3>
            <p className="hint">
              ใส่รหัสสาขากับรหัสสินค้า เพื่อดูว่าสูตรคิดยังไงถึงได้ยอดเท่านี้
            </p>
            <div className="row">
              <Picker options={stOpts} value={exPlant} onChange={setExPlant}
                placeholder="พิมพ์ชื่อสาขาหรือรหัส" width={260} />
              <Picker options={itOpts} value={exMat} onChange={setExMat}
                placeholder="พิมพ์ชื่อสินค้าหรือรหัส" width={320} />
              <button className="btn" onClick={() => void explain()}
                disabled={!exPlant || !exMat || exBusy}>
                {exBusy ? 'กำลังตรวจ…' : 'ตรวจ'}
              </button>
              {ex && <button className="btn ghost" onClick={() => setEx(null)}>ปิด</button>}
            </div>

            {exErr && (
              <div className="note bad" style={{ marginTop: 14, whiteSpace: 'pre-wrap' }}>
                {exErr}
                {/incoming_detail|does not exist|ไม่รู้จัก/.test(exErr) && (
                  <div style={{ marginTop: 8 }}>
                    ยังรัน migration ไม่ครบ — ต้องรัน migration_47 ก่อน migration_48
                  </div>
                )}
              </div>
            )}

            {ex && !ex.found && (
              <div className="note bad" style={{ marginTop: 14 }}>{ex.reason}</div>
            )}

            {ex?.found && (
              <div style={{ marginTop: 18 }}>
                <p style={{ margin: '0 0 12px', fontWeight: 600 }}>
                  {ex.branch_name} · {ex.item_name}
                  <span className="tag" style={{ marginLeft: 8 }}>{ex.class_fix}</span>
                </p>

                <table>
                  <tbody>
                    <tr><td style={{ width: 240 }}>คงเหลือที่สาขา</td>
                      <td className="num" style={{ width: 110 }}>{ex.stock_pcs}</td>
                      <td style={{ color: 'var(--ink-3)' }}>ชิ้น</td></tr>
                    <tr><td>ของระหว่างทาง</td>
                      <td className="num" style={{ color: ex.in_transit ? 'var(--oil)' : undefined }}>
                        {ex.in_transit}</td>
                      <td style={{ color: 'var(--ink-3)' }}>
                        ชิ้น — หักออกจากยอดสั่ง
                        {(ex.oldest_po_days ?? 0) > 30 && (
                          <span style={{ color: 'var(--alarm)', marginLeft: 8 }}>
                            ใบเก่าสุดค้างมา {ex.oldest_po_days} วัน
                          </span>
                        )}
                      </td></tr>
                    <tr><td>ยอดขายต่อวัน</td>
                      <td className="num">{ex.sales_per_day}</td>
                      <td style={{ color: 'var(--ink-3)' }}>
                        = {ex.sales_30_l} ลิตร ÷ {ex.litre_per_piece} ลิตรต่อชิ้น</td></tr>
                    <tr><td>DOH ตอนนี้</td>
                      <td className="num">{ex.doh_now ?? '—'}</td>
                      <td style={{ color: 'var(--ink-3)' }}>วัน</td></tr>
                    <tr><td>CoverDay ของสาขานี้</td>
                      <td className="num"><strong>{ex.cover_day}</strong></td>
                      <td style={{ color: 'var(--ink-3)' }}>+ LeadTime {ex.lead_time} วัน</td></tr>
                    <tr><td>ต้องมีถึงรอบหน้า</td>
                      <td className="num">{ex.demand_cover}</td>
                      <td style={{ color: 'var(--ink-3)' }}>
                        = {ex.sales_per_day} × ({ex.cover_day} + {ex.lead_time})</td></tr>
                    <tr><td>Safety stock</td>
                      <td className="num">{ex.safety_stock}</td><td /></tr>
                    <tr><td>เป้าหมายรวม</td>
                      <td className="num"><strong>{ex.target}</strong></td>
                      <td style={{ color: 'var(--ink-3)' }}>ชิ้น</td></tr>
                    <tr style={{ background: 'var(--wash)' }}>
                      <td><strong>ควรสั่ง</strong></td>
                      <td className="num">
                        <strong style={{ fontSize: 16 }}>{ex.need_rounded}</strong>
                      </td>
                      <td style={{ color: 'var(--ink-3)' }}>
                        {ex.skipped ? 'ถูกข้าม' : `= CEIL(${ex.target} − ${ex.stock_pcs} − ${ex.in_transit})`}
                        {ex.need_rounded !== ex.need && ` · ปัดยกลัง ${ex.units_per_case}`}
                      </td></tr>
                    <tr><td>คลังมีของ</td>
                      <td className="num" style={{
                        color: ex.depot_stock === 0 ? 'var(--alarm)' : undefined,
                      }}>
                        {ex.depot_stock === null ? 'ไม่มีข้อมูล' : ex.depot_stock}
                      </td><td /></tr>
                  </tbody>
                </table>

                {(ex.incoming_detail ?? []).length > 0 && (
                  <div style={{ marginTop: 16 }}>
                    <p className="hint" style={{ margin: '0 0 8px' }}>
                      ของระหว่างทาง {ex.in_transit} ชิ้น มาจากใบไหนบ้าง
                    </p>
                    <table>
                      <thead>
                        <tr>
                          <th>แหล่ง</th><th>เลขที่</th><th>วันที่</th>
                          <th className="num">อายุ</th><th className="num">จำนวน</th><th></th>
                        </tr>
                      </thead>
                      <tbody>
                        {ex.incoming_detail!.map((d, i) => (
                          <tr key={i}>
                            <td>
                              <span className={`tag ${d.source === 'ME2N' ? ''
                                : d.source === 'โอนจากสาขา' ? 'ok' : 'oil'}`}>
                                {d.source}
                              </span>
                            </td>
                            <td style={{ fontFamily: 'var(--mono)', fontSize: 13 }}>
                              {d.po_no ?? '—'}
                            </td>
                            <td style={{ fontFamily: 'var(--mono)', fontSize: 12.5,
                                         color: 'var(--ink-3)' }}>
                              {d.po_date ?? '—'}
                            </td>
                            <td className="num" style={{
                              color: (d.age_days ?? 0) > 60 ? 'var(--alarm)'
                                : (d.age_days ?? 0) > 30 ? 'var(--oil)' : 'var(--ink-3)',
                            }}>
                              {d.age_days !== null ? `${d.age_days} วัน` : '—'}
                            </td>
                            <td className="num"><strong>{Number(d.qty)}</strong></td>
                            <td style={{ fontSize: 12.5, color: 'var(--oil)' }}>{d.note}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                <div className={`note ${ex.skipped || (ex.need_rounded ?? 0) === 0 ? 'bad' : 'good'}`}
                  style={{ marginTop: 14 }}>
                  {(ex.notes ?? []).map((n, i) => <div key={i}>{n}</div>)}
                </div>

                {ex.actual && (
                  <div className="note" style={{ marginTop: 12 }}>
                    ผลจริงในรอบที่คำนวณไว้ — ระบบเสนอ {ex.actual.suggested} ชิ้น ·
                    ยอดสุดท้าย {ex.actual.final} ชิ้น · ลำดับความสำคัญ {ex.actual.priority}
                    {ex.actual.flag && ` · ${ex.actual.flag}`}
                  </div>
                )}
              </div>
            )}
          </div>

          <p className="hint" style={{ marginTop: 8 }}>
            แถบวัดยาวตามจำนวนวันที่ของจะอยู่ได้ ขีดดำคือเส้น KPI — แดงคือต่ำกว่า 7 วัน เหลืองคือเกินเส้น
            {lines.length > mainLines.length &&
              ` · ตารางนี้ไม่รวมสินค้าที่ต้องสั่งแยก ${lines.length - mainLines.length} บรรทัด ดูที่การ์ดด้านบน`}
          </p>
        </>
      )}
    </>
  )
}
