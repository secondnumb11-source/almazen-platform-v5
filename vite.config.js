import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: { host: '::', port: 8080 },
  preview: { host: '::', port: 8080 },
})
