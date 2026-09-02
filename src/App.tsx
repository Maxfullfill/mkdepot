import { useCallback, useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import type { Session } from '@supabase/supabase-js'
import { supabase } from './lib/supabase'
import Login, { Pending } from './views/Login'
import Dashboard from './views/Dashboard'
import ImportPage from './views/Import'
import Run from './views/Run'
import Transfers from './views/Transfers'
import TransfersB from './views/TransfersB'
import Depot from './views/Depot'
import Receiving from './views/Receiving'
import Shortage from './views/Shortage'
import KpiPage from './views/Kpi'
import Settings from './views/Settings'
import Users from './views/Users'

const today = () => new Date().toISOString().slice(0, 10)

type VTDoc = Document & {
  startViewTransition?: (cb: () => void) => { finished: Promise<void> }
}
type Tab = 'home' | 'import' | 'run' | 'transfer' | 'transferB' | 'receiving'
  | 'shortage' | 'depot' | 'kpi' | 'settings' | 'users'

/** ตัวกรองที่ส่งข้ามหน้าได้ เช่นกดตัวเลขในหน้าภาพรวมแล้วเด้งไปหน้าของขาด */
export interface Preset { kind?: string; name?: string }
interface Me { username: string; role: 'staff' | 'admin'; is_active: boolean }
interface Item { id: Tab; label: string; step?: string }

export default function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [me, setMe] = useState<Me | null>(null)
  const [ready, setReady] = useState(false)
  const [tab, setTab] = useState<Tab>('home')
  const tabRef = useRef<Tab>('home')
  useEffect(() => { tabRef.current = tab }, [tab])
  const [snapshotDate, setSnapshotDate] = useState(today())
  const [preset, setPreset] = useState<Preset | undefined>()
  const [moreOpen, setMoreOpen] = useState(false)
  const moreRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!moreOpen) return
    const away = (e: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) setMoreOpen(false)
    }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [moreOpen])

  /** เปลี่ยนหน้าแบบมอร์ฟ — เบราว์เซอร์ถ่ายภาพหน้าเดิมแล้วค่อย ๆ กลายเป็นหน้าใหม่
   *  flushSync บังคับให้ DOM อัปเดตเสร็จภายในคอลแบ็ก ไม่งั้นภาพจะไม่ตรง
   *  เบราว์เซอร์ที่ไม่รองรับจะเปลี่ยนหน้าตามปกติ */
  const navigate = useCallback((next: string, p?: Preset) => {
    const go = () => { setPreset(p); setTab(next as Tab) }
    if (next === tabRef.current && !p) return
    const doc = document as VTDoc
    if (!doc.startViewTransition || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      go(); return
    }
    doc.startViewTransition(() => { flushSync(go) })
  }, [])

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      setSession(s)
      if (!s) { setMe(null); setReady(true) }
    })
    return () => sub.subscription.unsubscribe()
  }, [])

  useEffect(() => {
    if (!session) { setReady(true); return }
    let cancelled = false
    supabase.from('app_users').select('username, role, is_active')
      .eq('user_id', session.user.id).maybeSingle()
      .then(({ data }) => {
        if (cancelled) return
        setMe((data as Me | null) ?? {
          username: session.user.email?.split('@')[0] ?? 'ผู้ใช้',
          role: 'staff', is_active: false,
        })
        setReady(true)
      })
    return () => { cancelled = true }
  }, [session])

  if (!ready) return null
  if (!session) return <Login />
  if (!me?.is_active) return <Pending username={me?.username ?? ''} />

  /** เมนูแบ่งตามลักษณะงาน ไม่ใช่เรียงตัวเลขยาว ๆ */
  const groups: { label: string | null; items: Item[] }[] = [
    { label: null, items: [{ id: 'home', label: 'ภาพรวม' }] },
    {
      label: 'งานประจำวัน',
      items: [
        { id: 'import', step: '1', label: 'นำเข้าข้อมูล' },
        { id: 'run', step: '2', label: 'คำนวณยอดเติม' },
        { id: 'transfer', step: '3', label: 'โอนเกลี่ยสินค้า' },
        { id: 'transferB', step: '4', label: 'โอนข้ามคลาส' },
      ],
    },
    {
      label: 'ตรวจสอบ',
      items: [
        { id: 'shortage', label: 'ของขาด' },
        { id: 'receiving', label: 'ยังไม่ได้ทำรับ' },
        { id: 'depot', label: 'สั่งเข้าคลัง' },
      ],
    },
    { label: 'ติดตามผล', items: [{ id: 'kpi', label: 'KPI ย้อนหลัง' }] },
    {
      label: 'ระบบ',
      items: [
        { id: 'settings', label: 'ตั้งค่าการคำนวณ' },
        ...(me.role === 'admin' ? [{ id: 'users' as Tab, label: 'ผู้ใช้' }] : []),
      ],
    },
  ]

  /** งานประจำวันเป็นลำดับขั้น แสดงเป็นวงกลมตัวเลข ตัวที่เปิดอยู่กางชื่อออกมา
   *  ที่เหลือรวมไว้ในเมนูรายงาน จะได้ไม่ล้นแถบ */
  const STEPS: Tab[] = ['import', 'run', 'transfer', 'transferB']
  const all = groups.flatMap((g) => g.items)
  const stepNav = STEPS.map((id) => all.find((x) => x.id === id)).filter(Boolean) as Item[]
  const moreNav = all.filter((x) => x.id !== 'home' && !STEPS.includes(x.id))
  const moreActive = moreNav.some((x) => x.id === tab)
  const stepIdx = STEPS.indexOf(tab as Tab)
  const initial = (me.username || '?').trim().charAt(0).toUpperCase()

  return (
    <div className="app">
      <header className="topbar">
        <div className="bar">
          <div className="brand">
            <span className="logo" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none">
                <path d="M4 17V9m0 0 8-5 8 5m-16 0 8 5 8-5m0 0v8m-8 5v-8"
                  stroke="currentColor" strokeWidth="2"
                  strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            <span className="brand-txt">
              <h1>เติมสินค้า</h1>
              <p>คลังแม่กลอง</p>
            </span>
          </div>

          <nav className="topnav">
            <button className="nav-home" aria-current={tab === 'home'}
              onClick={() => navigate('home')}>ภาพรวม</button>

            <i className="sep" aria-hidden="true" />

            {stepNav.map((t, i) => {
              const active = tab === t.id
              const done = stepIdx >= 0 && i < stepIdx
              return (
                <button key={t.id} className={`nav-step${active ? ' on' : ''}${done ? ' done' : ''}`}
                  aria-current={active} title={t.label}
                  onClick={() => navigate(t.id)}>
                  <span className="dot">
                    {done ? (
                      <svg viewBox="0 0 24 24" width="13" height="13" fill="none">
                        <path d="M20 6 9 17l-5-5" stroke="currentColor" strokeWidth="3"
                          strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    ) : t.step}
                  </span>
                  {active && <span className="lbl">{t.label}</span>}
                </button>
              )
            })}

            <span style={{ flex: 1 }} />

            <div className="navmore" ref={moreRef}>
              <button className="nav-more" aria-current={moreActive}
                onClick={() => setMoreOpen(!moreOpen)}>
                {moreActive ? moreNav.find((x) => x.id === tab)?.label : 'รายงาน'}
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none"
                  style={{ transform: moreOpen ? 'rotate(180deg)' : undefined,
                           transition: 'transform .18s' }}>
                  <path d="m6 9 6 6 6-6" stroke="currentColor" strokeWidth="2.2"
                    strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>

              {moreOpen && (
                <div className="navmenu">
                  {moreNav.map((t) => (
                    <button key={t.id} aria-current={tab === t.id}
                      onClick={() => { setMoreOpen(false); navigate(t.id) }}>
                      {t.label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <span className="avatar in-nav" title={me.username}>{initial}</span>
          </nav>

          <div className="who">
            <button className="iconbtn" title="นำเข้าข้อมูล"
              onClick={() => navigate('import')}>
              <svg viewBox="0 0 24 24" width="17" height="17" fill="none">
                <path d="M12 16V4m0 0L8 8m4-4 4 4M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2"
                  stroke="currentColor" strokeWidth="1.8"
                  strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <button className="iconbtn" title="ตั้งค่าการคำนวณ"
              onClick={() => navigate('settings')}>
              <svg viewBox="0 0 24 24" width="17" height="17" fill="none">
                <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.8" />
                <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7.9 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3 14.1H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 7.9a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V2a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H22a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z"
                  stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"
                  strokeLinejoin="round" opacity=".9" />
              </svg>
            </button>

            <span className="userchip">
              <span className="uname">
                {me.username}
                {me.role === 'admin' && <em>ผู้ดูแล</em>}
              </span>
              <button className="iconbtn sm" title="ออกจากระบบ"
                onClick={() => supabase.auth.signOut()}>
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none">
                  <path d="M15 17l5-5-5-5M20 12H9M12 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h6"
                    stroke="currentColor" strokeWidth="1.8"
                    strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </span>
          </div>
        </div>
      </header>

      <main className="main">
        {/* key=tab ทำให้ React สร้างใหม่ แอนิเมชันจึงเล่นซ้ำ */}
        <div className="page" key={tab}>
          {tab === 'home' && <Dashboard go={navigate} />}
          {tab === 'import' && <ImportPage snapshotDate={snapshotDate} setSnapshotDate={setSnapshotDate} />}
          {tab === 'run' && <Run snapshotDate={snapshotDate} />}
          {tab === 'transfer' && <Transfers snapshotDate={snapshotDate} />}
          {tab === 'transferB' && <TransfersB snapshotDate={snapshotDate} />}
          {tab === 'shortage' && <Shortage preset={preset} />}
          {tab === 'receiving' && <Receiving />}
          {tab === 'depot' && <Depot />}
          {tab === 'kpi' && <KpiPage />}
          {tab === 'settings' && <Settings />}
          {tab === 'users' && me.role === 'admin' && <Users me={me.username} />}
        </div>
      </main>
    </div>
  )
}
