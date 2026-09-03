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
import ManualTransfer from './views/ManualTransfer'
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
type Tab = 'home' | 'import' | 'run' | 'transfer' | 'transferB' | 'manual' | 'receiving'
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
        { id: 'manual', label: 'โอนกำหนดเอง' },
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
  /** แสดงทุกเมนูในแถวเดียว คั่นกลุ่มด้วยเส้นบาง */
  const navItems = groups.flatMap((g, gi) =>
    g.items.map((it, ii) => ({ ...it, newGroup: ii === 0 && gi > 0 })))
  const initial = (me.username || '?').trim().charAt(0).toUpperCase()

  return (
    <div className="app">
      <header className="topbar">
        <div className="bar">
          <div className="brand">
            <span className="logo" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="17" height="17" fill="none">
                <path d="M4 17V9m0 0 8-5 8 5m-16 0 8 5 8-5m0 0v8m-8 5v-8"
                  stroke="currentColor" strokeWidth="2"
                  strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            <span className="brand-txt">
              <b>เติมสินค้า</b>
              <i>คลังแม่กลอง</i>
            </span>
          </div>

          <nav className="topnav">
            {navItems.map((t) => (
              <span key={t.id} className="navcell">
                {t.newGroup && <i className="sep" aria-hidden="true" />}
                <button aria-current={tab === t.id} onClick={() => navigate(t.id)}>
                  {t.step && <span className="step">{t.step}</span>}
                  {t.label}
                </button>
              </span>
            ))}
          </nav>

          <div className="who">
            <button className="iconbtn" title="นำเข้าข้อมูล" onClick={() => navigate('import')}>
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none">
                <path d="M12 16V4m0 0L8 8m4-4 4 4M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2"
                  stroke="currentColor" strokeWidth="1.9"
                  strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <button className="iconbtn" title="ตั้งค่าการคำนวณ" onClick={() => navigate('settings')}>
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none">
                <circle cx="12" cy="12" r="3.2" stroke="currentColor" strokeWidth="1.9" />
                <path d="M12 2.5v2M12 19.5v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2.5 12h2M19.5 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"
                  stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
              </svg>
            </button>

            <span className="userchip" title={me.username}>
              <span className="avatar">{initial}</span>
              <span className="uname">
                <b>{me.username}</b>
                {me.role === 'admin' && <i>ผู้ดูแล</i>}
              </span>
              <button className="iconbtn sm" title="ออกจากระบบ"
                onClick={() => supabase.auth.signOut()}>
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none">
                  <path d="M15 17l5-5-5-5M20 12H9M12 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h6"
                    stroke="currentColor" strokeWidth="1.9"
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
          {tab === 'manual' && <ManualTransfer />}
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
