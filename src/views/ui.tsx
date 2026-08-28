import { useEffect, useMemo, useRef, useState } from 'react'

/** ช่องตัวเลขพร้อมปุ่มบวกลบ — พิมพ์เองก็ได้ ค่าจะบันทึกตอนคลิกออกหรือกด Enter */
export function StepNum({
  value, onChange, step = 1, min = 0, max, decimals = 0, small = false, disabled = false,
  placeholder = '—', allowEmpty = false,
}: {
  value: number | null
  onChange: (v: number | null) => void
  step?: number
  min?: number
  max?: number
  decimals?: number
  small?: boolean
  disabled?: boolean
  placeholder?: string
  allowEmpty?: boolean
}) {
  const [draft, setDraft] = useState(value === null ? '' : String(value))
  const focused = useRef(false)

  useEffect(() => {
    if (!focused.current) setDraft(value === null ? '' : String(value))
  }, [value])

  const round = (n: number) => parseFloat(n.toFixed(decimals))
  const clamp = (n: number) => {
    let v = round(n)
    if (min !== undefined) v = Math.max(v, min)
    if (max !== undefined) v = Math.min(v, max)
    return v
  }

  const bump = (dir: 1 | -1) => {
    const base = value ?? 0
    onChange(clamp(base + dir * step))
  }

  const commit = () => {
    focused.current = false
    const t = draft.trim()
    if (t === '') {
      if (allowEmpty) { onChange(null); return }
      setDraft(value === null ? '' : String(value)); return
    }
    const n = parseFloat(t)
    if (!Number.isFinite(n)) { setDraft(value === null ? '' : String(value)); return }
    const c = clamp(n)
    setDraft(String(c))
    if (c !== value) onChange(c)
  }

  return (
    <span className={`step-num${small ? ' sm' : ''}`}>
      <button type="button" aria-label="ลด" disabled={disabled || (value !== null && min !== undefined && value <= min)}
        onClick={() => bump(-1)}>−</button>
      <input
        type="text" inputMode="decimal" value={draft} placeholder={placeholder} disabled={disabled}
        onFocus={() => { focused.current = true }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
      />
      <button type="button" aria-label="เพิ่ม" disabled={disabled || (value !== null && max !== undefined && value >= max)}
        onClick={() => bump(1)}>+</button>
    </span>
  )
}

/** สวิตช์เปิดปิด */
export function Switch({ on, onChange, disabled }: {
  on: boolean; onChange: (v: boolean) => void; disabled?: boolean
}) {
  return (
    <label className="sw">
      <input type="checkbox" checked={on} disabled={disabled}
        onChange={(e) => onChange(e.target.checked)} />
      <span />
    </label>
  )
}

/** ส่วนที่พับเก็บได้ */
export function Fold({ title, hint, note, open = false, children }: {
  title: string; hint?: string; note?: string; open?: boolean; children: React.ReactNode
}) {
  return (
    <details className="fold" open={open}>
      <summary>
        <span className="chev" aria-hidden="true" />
        <h3>{title}</h3>
        {note && <span className="sub">{note}</span>}
      </summary>
      <div className="body">
        {hint && <p className="hint" style={{ marginTop: 0 }}>{hint}</p>}
        {children}
      </div>
    </details>
  )
}


export interface Option { value: string; label: string; sub?: string }

/** ช่องค้นหาแบบพิมพ์แล้วกรอง เลือกได้ด้วยเมาส์หรือลูกศร
 *  ค้นได้ทั้งจากชื่อและรหัส ไม่ต้องจำรหัสเอง */
export function Picker({
  options, value, onChange, placeholder = 'พิมพ์เพื่อค้นหา', width = 260, disabled,
}: {
  options: Option[]
  value: string
  onChange: (v: string) => void
  placeholder?: string
  width?: number
  disabled?: boolean
}) {
  const [text, setText] = useState('')
  const [open, setOpen] = useState(false)
  const [hi, setHi] = useState(0)
  const box = useRef<HTMLDivElement>(null)

  const picked = options.find((o) => o.value === value)

  useEffect(() => {
    if (!open) setText(picked ? picked.label : '')
  }, [value, open, picked])

  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [])

  const hits = useMemo(() => {
    const t = text.trim().toLowerCase()
    if (!t) return options.slice(0, 40)
    return options
      .filter((o) => `${o.label} ${o.value} ${o.sub ?? ''}`.toLowerCase().includes(t))
      .slice(0, 40)
  }, [options, text])

  const choose = (o: Option) => {
    onChange(o.value); setText(o.label); setOpen(false)
  }

  return (
    <div className="picker" ref={box} style={{ width }}>
      <input
        type="text" value={text} placeholder={placeholder} disabled={disabled}
        autoComplete="off"
        onChange={(e) => { setText(e.target.value); setOpen(true); setHi(0) }}
        onFocus={() => { setOpen(true); setText('') }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setHi((h) => Math.min(h + 1, hits.length - 1)) }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)) }
          else if (e.key === 'Enter' && open && hits[hi]) { e.preventDefault(); choose(hits[hi]) }
          else if (e.key === 'Escape') setOpen(false)
        }}
      />
      {value && !open && <span className="picker-code">{value}</span>}

      {open && (
        <div className="picker-list">
          {hits.length === 0 ? (
            <div className="picker-empty">ไม่พบรายการที่ตรง</div>
          ) : hits.map((o, i) => (
            <button key={o.value} type="button"
              className={i === hi ? 'on' : undefined}
              onMouseEnter={() => setHi(i)}
              onMouseDown={(e) => { e.preventDefault(); choose(o) }}>
              <span className="pl">{o.label}</span>
              <span className="pv">{o.sub ?? o.value}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
