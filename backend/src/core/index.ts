import { createApp } from './app'

const app = createApp()

app.listen(Number.parseInt(process.env.PORT || '5000'), () => {
  console.log(`[pagelm] running on ${process.env.VITE_BACKEND_URL}`)
})
