/** กราฟเส้นแบบเบา ๆ วาดด้วย SVG ล้วน ไม่ต้องพึ่งไลบรารีภายนอก */

export interface Point { x: string; y: number | null }

export function LineChart({
  data, target, unit = '', height = 190, color = '#4a7c74',
  targetLabel, goodAbove = true, decimals = 1,
}: {
  data: Point[]
  target?: number
  unit?: string
  height?: number
  color?: string
  targetLabel?: string
  goodAbove?: boolean
  decimals?: number
}) {
  const pts = data.filter((p) => p.y !== null) as { x: string; y: number }[]
  if (pts.length < 2) {
    return (
      <div className="note" style={{ margin: 0 }}>
        ต้องมีข้อมูลอย่างน้อย 2 วันถึงจะวาดกราฟได้ · ตอนนี้มี {pts.length} วัน
      </div>
    )
  }

  const W = 760, H = height, PL = 46, PR = 14, PT = 16, PB = 28
  const ys = pts.map((p) => p.y).concat(target !== undefined ? [target] : [])
  let lo = Math.min(...ys), hi = Math.max(...ys)
  const pad = (hi - lo) * 0.18 || Math.max(Math.abs(hi) * 0.1, 1)
  lo -= pad; hi += pad

  const px = (i: number) => PL + (i / (pts.length - 1)) * (W - PL - PR)
  const py = (v: number) => PT + (1 - (v - lo) / (hi - lo || 1)) * (H - PT - PB)

  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${px(i).toFixed(1)},${py(p.y).toFixed(1)}`).join(' ')
  const area = `${line} L${px(pts.length - 1).toFixed(1)},${py(lo)} L${px(0).toFixed(1)},${py(lo)} Z`

  const last = pts[pts.length - 1]
  const ok = target === undefined ? true : goodAbove ? last.y >= target : last.y <= target
  const stroke = target === undefined ? color : ok ? '#2f6a4d' : '#9c3b30'

  const ticks = [lo + (hi - lo) * 0.05, (lo + hi) / 2, hi - (hi - lo) * 0.05]
  const gid = `g${Math.round(lo * 1000)}${Math.round(hi * 1000)}`

  const labelEvery = Math.max(1, Math.ceil(pts.length / 7))

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }}
      role="img" aria-label={`กราฟย้อนหลัง ${pts.length} วัน`}>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity=".18" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>

      {ticks.map((t, i) => (
        <g key={i}>
          <line x1={PL} y1={py(t)} x2={W - PR} y2={py(t)} stroke="#ece7e1" strokeWidth="1" />
          <text x={PL - 8} y={py(t) + 4} textAnchor="end"
            fontSize="11.5" fill="#a19a92" fontFamily="IBM Plex Mono, monospace">
            {t.toFixed(decimals)}
          </text>
        </g>
      ))}

      {target !== undefined && (
        <>
          <line x1={PL} y1={py(target)} x2={W - PR} y2={py(target)}
            stroke="#6d6660" strokeWidth="1.5" strokeDasharray="5 4" opacity=".65" />
          <text x={W - PR} y={py(target) - 6} textAnchor="end"
            fontSize="11.5" fill="#6d6660">
            {targetLabel ?? `เป้า ${target}${unit}`}
          </text>
        </>
      )}

      <path d={area} fill={`url(#${gid})`} />
      <path d={line} fill="none" stroke={stroke} strokeWidth="2.5"
        strokeLinejoin="round" strokeLinecap="round" />

      {pts.map((p, i) => (
        <circle key={i} cx={px(i)} cy={py(p.y)}
          r={i === pts.length - 1 ? 5 : 2.5}
          fill={i === pts.length - 1 ? stroke : '#fff'}
          stroke={stroke} strokeWidth="2">
          <title>{`${p.x} · ${p.y.toFixed(decimals)}${unit}`}</title>
        </circle>
      ))}

      {pts.map((p, i) => (i % labelEvery === 0 || i === pts.length - 1) ? (
        <text key={i} x={px(i)} y={H - 8} textAnchor="middle"
          fontSize="11" fill="#a19a92" fontFamily="IBM Plex Mono, monospace">
          {p.x.slice(5)}
        </text>
      ) : null)}
    </svg>
  )
}
