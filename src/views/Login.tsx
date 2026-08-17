import { useState } from 'react'
import { supabase } from '../lib/supabase'

/** Supabase บังคับให้ auth ใช้อีเมล แต่ไม่ตรวจว่ามีจริง
 *  ผู้ใช้พิมพ์แค่ชื่อ ระบบต่อโดเมนนี้ให้เบื้องหลัง */
export const DOMAIN = 'mgk.local'

export const toEmail = (username: string) =>
  `${username.trim().toLowerCase().replace(/[^a-z0-9._-]/g, '')}@${DOMAIN}`

export default function Login() {
  const [mode, setMode] = useState<'in' | 'up'>('in')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const clean = username.trim().toLowerCase().replace(/[^a-z0-9._-]/g, '')

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setMsg(null)

    if (clean.length < 3) {
      setMsg({ ok: false, text: 'ชื่อผู้ใช้ต้องยาวอย่างน้อย 3 ตัว ใช้ได้เฉพาะ a-z 0-9 . _ -' })
      setBusy(false); return
    }

    if (mode === 'in') {
      const { error } = await supabase.auth.signInWithPassword({
        email: toEmail(clean), password,
      })
      if (error) setMsg({ ok: false, text: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' })
    } else {
      if (password.length < 8) {
        setMsg({ ok: false, text: 'รหัสผ่านต้องยาวอย่างน้อย 8 ตัว' })
        setBusy(false); return
      }
      const { error } = await supabase.auth.signUp({ email: toEmail(clean), password })
      if (error) {
        setMsg({
          ok: false,
          text: /already/i.test(error.message)
            ? 'ชื่อผู้ใช้นี้มีคนใช้แล้ว'
            : `เปิดบัญชีไม่สำเร็จ: ${error.message}`,
        })
      } else {
        setMsg({ ok: true, text: 'เปิดบัญชีแล้ว รอผู้ดูแลอนุมัติก่อนจึงจะเข้าใช้งานได้' })
        setMode('in')
      }
    }
    setBusy(false)
  }

  return (
    <div className="login">
      <form onSubmit={submit}>
        <h1>ระบบเติมสินค้า</h1>
        <p>คลังแม่กลอง</p>

        <input
          type="text" placeholder="ชื่อผู้ใช้" value={username} required
          autoComplete="username" autoCapitalize="off" spellCheck={false}
          onChange={(e) => setUsername(e.target.value)}
        />
        <input
          type="password" placeholder="รหัสผ่าน" value={password} required
          autoComplete={mode === 'in' ? 'current-password' : 'new-password'}
          onChange={(e) => setPassword(e.target.value)}
        />

        <button className="btn" type="submit" disabled={busy}>
          {busy ? 'กำลังทำงาน…' : mode === 'in' ? 'เข้าสู่ระบบ' : 'เปิดบัญชี'}
        </button>

        {msg && <div className={`note ${msg.ok ? 'good' : 'bad'}`}>{msg.text}</div>}

        <button
          type="button" className="btn ghost" style={{ borderColor: 'transparent' }}
          onClick={() => { setMode(mode === 'in' ? 'up' : 'in'); setMsg(null) }}
        >
          {mode === 'in' ? 'ยังไม่มีบัญชี — เปิดบัญชีใหม่' : 'มีบัญชีแล้ว — เข้าสู่ระบบ'}
        </button>
      </form>
    </div>
  )
}

/** แสดงเมื่อล็อกอินได้แล้วแต่ยังไม่ถูกอนุมัติ */
export function Pending({ username }: { username: string }) {
  return (
    <div className="login">
      <div style={{ width: 340, textAlign: 'center' }}>
        <h1 style={{ fontSize: 18, margin: '0 0 6px' }}>รอการอนุมัติ</h1>
        <p style={{ color: 'var(--ink-2)', fontSize: 13.5, margin: '0 0 18px' }}>
          บัญชี <strong>{username}</strong> เปิดแล้ว แต่ผู้ดูแลยังไม่ได้เปิดสิทธิ์เข้าถึงข้อมูล
          แจ้งผู้ดูแลให้อนุมัติที่หน้า “ผู้ใช้”
        </p>
        <button className="btn ghost" onClick={() => supabase.auth.signOut()}>ออกจากระบบ</button>
      </div>
    </div>
  )
}
