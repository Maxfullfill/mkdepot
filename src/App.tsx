import { useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from './lib/supabase'
import Login, { Pending } from './views/Login'
import Import from './views/Import'
import Run from './views/Run'
import KpiPage from './views/Kpi'
import Settings from './views/Settings'
import Transfers from './views/Transfers'
import Depot from './views/Depot'
import Users from './views/Users'

const today = () => new Date().toISOString().slice(0, 10)

type Tab = 'import' | 'run' | 'transfer' | 'depot' | 'kpi' | 'settings' | 'users'

interface Me { username: string; role: 'staff' | 'admin'; is_active: boolean }

export default function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [me, setMe] = useState<Me | null>(null)
  const [ready, setReady] = useState(false)
  const [tab, setTab] = useState<Tab>('import')
  const [snapshotDate, setSnapshotDate] = useState(today())

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
    supabase
      .from('app_users')
      .select('username, role, is_active')
      .eq('user_id', session.user.id)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled) return
        setMe(
          (data as Me | null) ?? {
            username: session.user.email?.split('@')[0] ?? 'ผู้ใช้',
            role: 'staff',
            is_active: false,
          }
        )
        setReady(true)
      })
    return () => { cancelled = true }
  }, [session])

  if (!ready) return null
  if (!session) return <Login />
  if (!me?.is_active) return <Pending username={me?.username ?? ''} />

  const tabs: { id: Tab; step: string; label: string }[] = [
    { id: 'import', step: '01', label: 'นำเข้าข้อมูล' },
    { id: 'run', step: '02', label: 'คำนวณยอดเติม' },
    { id: 'transfer', step: '03', label: 'โอนเกลี่ยสินค้า' },
    { id: 'depot', step: '04', label: 'สั่งเข้าคลัง' },
    { id: 'kpi', step: '05', label: 'KPI' },
    { id: 'settings', step: '06', label: 'ตั้งค่าการคำนวณ' },
    ...(me.role === 'admin' ? [{ id: 'users' as Tab, step: '07', label: 'ผู้ใช้' }] : []),
  ]

  return (
    <div className="shell">
      <aside className="rail">
        <div className="brand">
          <h1>ระบบเติมสินค้า</h1>
          <p>คลังแม่กลอง</p>
        </div>
        <nav className="nav">
          {tabs.map((t) => (
            <button key={t.id} aria-current={tab === t.id} onClick={() => setTab(t.id)}>
              <span className="step">{t.step}</span>
              {t.label}
            </button>
          ))}
        </nav>
        <footer>
          <div style={{ marginBottom: 6 }}>
            {me.username}
            {me.role === 'admin' && <span className="tag" style={{ marginLeft: 6 }}>ผู้ดูแล</span>}
          </div>
          <button onClick={() => supabase.auth.signOut()}>ออกจากระบบ</button>
        </footer>
      </aside>

      <main className="main">
        {tab === 'import' && <Import snapshotDate={snapshotDate} setSnapshotDate={setSnapshotDate} />}
        {tab === 'run' && <Run snapshotDate={snapshotDate} />}
        {tab === 'transfer' && <Transfers snapshotDate={snapshotDate} />}
        {tab === 'depot' && <Depot />}
        {tab === 'kpi' && <KpiPage />}
        {tab === 'settings' && <Settings />}
        {tab === 'users' && me.role === 'admin' && <Users me={me.username} />}
      </main>
    </div>
  )
}
