import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// GitHub Pages เสิร์ฟที่ /<ชื่อ repo>/ จึงต้องตั้ง base ให้ตรง
// ตั้งผ่าน env VITE_BASE ตอน build ใน GitHub Actions
export default defineConfig({
  plugins: [react()],
  base: process.env.VITE_BASE || '/',
})
