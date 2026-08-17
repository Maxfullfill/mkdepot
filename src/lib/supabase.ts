import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string

if (!url || !key) {
  throw new Error(
    'ยังไม่ได้ตั้งค่า VITE_SUPABASE_URL และ VITE_SUPABASE_ANON_KEY — คัดลอก .env.example เป็น .env แล้วใส่ค่าจาก Project Settings > API'
  )
}

export const supabase = createClient(url, key)

/** ส่งข้อมูลเป็นก้อนละ 500 แถว กัน request ใหญ่เกิน */
export async function upsertChunked<T extends object>(
  table: string,
  rows: T[],
  onConflict?: string,
  onProgress?: (done: number, total: number) => void
) {
  const size = 500
  for (let i = 0; i < rows.length; i += size) {
    const chunk = rows.slice(i, i + size)
    const { error } = await supabase
      .from(table)
      .upsert(chunk as never, onConflict ? { onConflict, ignoreDuplicates: false } : undefined)
    if (error) throw new Error(`${table}: ${error.message}`)
    onProgress?.(Math.min(i + size, rows.length), rows.length)
  }
}
