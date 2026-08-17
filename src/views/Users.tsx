import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

interface AppUser {
  user_id: string; username: string; display_name: string | null
  role: 'staff' | 'admin'; is_active: boolean; created_at: string
}

export default function Users({ me }: { me: string }) {
  const [users, setUsers] = useState<AppUser[]>([])
  const [msg, setMsg] = useState('')

  useEffect(() => { void load() }, [])

  async function load() {
    const { data, error } = await supabase.from('app_users').select('*').order('created_at')
    if (error) { setMsg(error.message); return }
    setUsers((data ?? []) as AppUser[])
  }

  async function patch(u: AppUser, change: Partial<AppUser>) {
    setUsers((p) => p.map((x) => (x.user_id === u.user_id ? { ...x, ...change } : x)))
    const { error } = await supabase.from('app_users').update(change).eq('user_id', u.user_id)
    setMsg(error ? `บันทึกไม่สำเร็จ: ${error.message}` : `บันทึก ${u.username} แล้ว`)
    setTimeout(() => setMsg(''), 2500)
  }

  const waiting = users.filter((u) => !u.is_active)

  return (
    <>
      <h2>ผู้ใช้</h2>
      <p className="lede">
        คนที่เปิดบัญชีใหม่จะยังเข้าถึงข้อมูลไม่ได้จนกว่าจะเปิดสิทธิ์ที่นี่
      </p>

      {waiting.length > 0 && (
        <div className="note" style={{ marginBottom: 14 }}>
          มี {waiting.length} บัญชีรอการอนุมัติ: {waiting.map((u) => u.username).join(', ')}
        </div>
      )}

      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr><th>ชื่อผู้ใช้</th><th>สิทธิ์</th><th>สถานะ</th><th>เปิดบัญชีเมื่อ</th></tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.user_id}>
                <td>
                  {u.username}
                  {u.username === me && <span className="tag" style={{ marginLeft: 8 }}>คุณ</span>}
                </td>
                <td>
                  <select
                    value={u.role}
                    disabled={u.username === me}
                    onChange={(e) => patch(u, { role: e.target.value as 'staff' | 'admin' })}
                  >
                    <option value="staff">เจ้าหน้าที่</option>
                    <option value="admin">ผู้ดูแล</option>
                  </select>
                </td>
                <td>
                  {u.username === me ? (
                    <span className="tag ok">ใช้งานอยู่</span>
                  ) : (
                    <button
                      className={`btn ${u.is_active ? 'ghost' : ''}`}
                      onClick={() => patch(u, { is_active: !u.is_active })}
                    >
                      {u.is_active ? 'ปิดสิทธิ์' : 'อนุมัติ'}
                    </button>
                  )}
                </td>
                <td className="num" style={{ textAlign: 'left', color: 'var(--ink-3)' }}>
                  {u.created_at?.slice(0, 10)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {msg && <div className="note good" style={{ marginTop: 12 }}>{msg}</div>}

      <div className="note" style={{ marginTop: 20 }}>
        ลบบัญชีถาวรต้องทำที่ Supabase &rsaquo; Authentication &rsaquo; Users
        การปิดสิทธิ์ที่นี่ทำให้เข้าใช้งานไม่ได้ แต่บัญชียังอยู่
      </div>
    </>
  )
}
