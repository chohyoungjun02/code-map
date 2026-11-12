// Lives in its own file because import.meta.glob skips the file that calls it.
const src = import.meta.glob('./**/*.{js,jsx}', { query: '?raw', import: 'default', eager: true })
export const demoFiles = Object.fromEntries(Object.entries(src).map(([k, v]) => ['src/' + k.slice(2), v]))
