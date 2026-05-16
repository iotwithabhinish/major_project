import { createElement } from 'react'
import { Lightbulb, Tv, Fan } from 'lucide-react'

const deviceUsage = [
  { name: 'Lamps', count: '10 devices', usage: '78 kWh', icon: Lightbulb },
  { name: 'Smart TV', count: '1 device', usage: '180 kWh', icon: Tv },
  { name: 'AC Fan', count: '2 devices', usage: '56 kWh', icon: Fan },
]

function PowerCard() {
  return (
    <section className="rounded-3xl border border-white/10 bg-white/5 p-5 shadow-glass backdrop-blur-xl">
      <h3 className="text-xl font-semibold text-white">Power Consumption</h3>
      <p className="mt-1 text-sm text-slate-300">Summary of today and monthly usage</p>

      <div className="mt-5 grid grid-cols-2 gap-3">
        <div className="rounded-2xl bg-fuchsia-500/20 p-4">
          <p className="text-2xl font-semibold text-white">48 kWh</p>
          <p className="mt-1 text-xs uppercase tracking-wide text-fuchsia-200">Today</p>
        </div>
        <div className="rounded-2xl bg-indigo-500/20 p-4">
          <p className="text-2xl font-semibold text-white">680 kWh</p>
          <p className="mt-1 text-xs uppercase tracking-wide text-indigo-200">This Month</p>
        </div>
      </div>

      <ul className="mt-5 space-y-3">
        {deviceUsage.map(({ name, count, usage, icon }) => (
          <li key={name} className="flex items-center justify-between rounded-xl bg-black/20 px-3 py-2">
            <div className="flex items-center gap-2">
              {createElement(icon, { className: 'h-4 w-4 text-cyan-300' })}
              <div>
                <p className="text-sm text-white">{name}</p>
                <p className="text-xs text-slate-400">{count}</p>
              </div>
            </div>
            <p className="text-sm text-slate-200">{usage}</p>
          </li>
        ))}
      </ul>
    </section>
  )
}

export default PowerCard
