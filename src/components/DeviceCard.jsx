import { createElement } from 'react'
import { Power } from 'lucide-react'

function DeviceCard({ id, name, status, image, active, icon, onToggle }) {
  return (
    <article
      className="group relative overflow-hidden rounded-3xl border border-white/15 bg-slate-900/30 p-4 shadow-glass transition-all duration-300 hover:-translate-y-1 hover:scale-[1.01] hover:shadow-glow"
      style={{
        backgroundImage: `linear-gradient(180deg, rgba(5,7,18,0.05) 15%, rgba(5,7,18,0.9) 95%), url(${image})`,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
      }}
    >
      <div className="absolute inset-0 bg-black/10 opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
      <div className="relative z-10 flex min-h-40 flex-col justify-between">
        <div className="flex items-start justify-between">
          <div className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-white/20 bg-black/35 text-white backdrop-blur-sm">
            {icon ? createElement(icon, { className: 'h-5 w-5' }) : <Power className="h-5 w-5" />}
          </div>
          <div className="rounded-full bg-black/40 px-3 py-1 text-xs text-slate-200">{status}</div>
        </div>

        <div>
        <h4 className="text-2xl font-semibold text-white">{name}</h4>
        <div className="mt-2 flex items-center justify-between">
          <p className={`text-sm ${active ? 'text-emerald-300' : 'text-slate-300'}`}>
            {active ? 'Running' : 'Standby'}
          </p>
          <button
            onClick={() => onToggle(id)}
            className={`h-9 w-9 rounded-full border text-sm font-semibold transition ${
              active
                ? 'border-emerald-300/70 bg-emerald-500/20 text-emerald-200'
                : 'border-rose-300/70 bg-rose-500/20 text-rose-200'
            }`}
            aria-label={`Toggle ${name}`}
          >
            {active ? 'ON' : 'OFF'}
          </button>
        </div>
        </div>
      </div>
    </article>
  )
}

export default DeviceCard
