import { createElement } from 'react'
import { Home, Sofa, BedDouble } from 'lucide-react'

const rooms = [
  { id: 'Room', label: 'Room', icon: Home },
  { id: 'Kitchen', label: 'Kitchen', icon: Sofa },
  { id: 'Bedroom', label: 'Bedroom', icon: BedDouble },
]

function Header({ selectedRoom, onSelectRoom }) {
  return (
    <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <h1 className="text-3xl font-semibold leading-tight text-white sm:text-4xl">
          Hi User!
        </h1>
        <p className="mt-1 text-sm text-slate-300">
          Controlling <span className="font-medium text-violet-200">{selectedRoom}</span> with one tap.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {rooms.map(({ id, label, icon }) => (
          <button
            key={label}
            onClick={() => onSelectRoom(id)}
            className={`inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm transition-all duration-300 ${
              selectedRoom === id
                ? 'border-violet-300/60 bg-white/20 text-white shadow-glow'
                : 'border-white/10 bg-white/5 text-slate-300 hover:scale-[1.02] hover:border-white/30 hover:bg-white/10 hover:text-white'
            }`}
          >
            {createElement(icon, { className: 'h-4 w-4' })}
            {label}
          </button>
        ))}
      </div>
    </header>
  )
}

export default Header
