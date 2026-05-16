import { createElement } from 'react'
import { LayoutDashboard, Lightbulb, Music2, Settings } from 'lucide-react'

const menu = [
  { id: 'Dashboard', icon: LayoutDashboard },
  { id: 'Lights', icon: Lightbulb },
  { id: 'Music', icon: Music2 },
  { id: 'Settings', icon: Settings },
]

function Sidebar({ activeTab, onTabChange }) {
  return (
    <aside className="flex h-full w-20 flex-col items-center rounded-3xl border border-white/10 bg-white/5 py-6 backdrop-blur-xl">
      <div className="mb-8 text-sm font-semibold uppercase tracking-[0.3em] text-violet-300/90">
        vo
      </div>

      <nav className="flex flex-1 flex-col items-center gap-3">
        {menu.map(({ id, icon }) => (
          <button
            key={id}
            onClick={() => onTabChange(id)}
            className={`group rounded-2xl p-3 transition-all duration-300 ${
              activeTab === id
                ? 'bg-fuchsia-500/20 text-fuchsia-200 shadow-glow'
                : 'text-slate-300 hover:scale-105 hover:bg-white/10 hover:text-white'
            }`}
            aria-label={id}
          >
            {createElement(icon, { className: 'h-5 w-5' })}
            <span className="sr-only">{id}</span>
          </button>
        ))}
      </nav>

      <img
        src="/images/user_avatar.png"
        alt="Profile avatar"
        className="h-11 w-11 rounded-full border border-fuchsia-300/50 object-cover ring-2 ring-fuchsia-500/30"
      />
    </aside>
  )
}

export default Sidebar
