// Módulos de fases futuras: la navegación ya existe para que la estructura
// de la app sea visible desde la Fase 1.
export function Placeholder({ title, phase }: { title: string; phase: number }) {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 p-10 text-center">
      <h1 className="text-lg font-semibold text-slate-600">{title}</h1>
      <p className="mt-2 text-sm text-slate-400">
        Este módulo llega en la Fase {phase} del plan de construcción.
      </p>
    </div>
  )
}
