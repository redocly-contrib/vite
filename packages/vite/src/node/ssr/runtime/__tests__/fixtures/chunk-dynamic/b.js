export const load = () => import('./lazy.js').then((m) => m.value)
