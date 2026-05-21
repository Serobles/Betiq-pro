import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  define: {
    // Permite acceder a import.meta.env.VITE_MODE en el código
    'import_meta_env': JSON.stringify({
      VITE_MODE: process.env.VITE_MODE || 'admin'
    })
  }
})
