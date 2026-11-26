import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig(() => {
  const isVercel = Boolean(process.env.VERCEL);

  return {
    plugins: [react()],
    base: isVercel ? '/' : '/VegieTrack/app/',
    build: {
      outDir: isVercel ? 'dist' : '../app',
      emptyOutDir: true,
    },
  }
})

