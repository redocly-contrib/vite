export const viaHandler = () => import('./handler.js').then((m) => m.run())
