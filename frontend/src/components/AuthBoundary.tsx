import { useEffect, useState } from "react"
import { getCurrentPerson, loginUrl } from "../lib/api"

export default function AuthBoundary({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let live = true
    getCurrentPerson()
      .then(() => { if (live) setReady(true) })
      .catch(() => window.location.assign(loginUrl()))
    return () => { live = false }
  }, [])

  if (!ready) {
    return <div className="min-h-screen bg-black text-stone-300 grid place-items-center">Signing in…</div>
  }
  return children
}
