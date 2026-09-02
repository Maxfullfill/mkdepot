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

  const flat = groups.flatMap((g, gi) =>
    g.items.map((it, ii) => ({ ...it, group: gi, first: ii === 0 })))

  return (
    <div className="app">
      <header className="topbar">
        <div className="bar">
          <div className="brand">
            <h1>ระบบเติมสินค้า</h1>
            <p>คลังแม่กลอง</p>
          </div>

          <nav className="topnav">
            {flat.map((t, i) => (
              <span key={t.id} className="navcell">
                {t.first && i > 0 && <i className="sep" aria-hidden="true" />}
                <button aria-current={tab === t.id} onClick={() => navigate(t.id)}>
                  {t.step && <span className="step">{t.step}</span>}
                  {t.label}
                </button>
              </span>
            ))}
          </nav>

          <div className="who">
            <span>
              {me.username}
              {me.role === 'admin' && <span className="tag" style={{ marginLeft: 7 }}>ผู้ดูแล</span>}
            </span>
            <button onClick={() => supabase.auth.signOut()}>ออก</button>
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
