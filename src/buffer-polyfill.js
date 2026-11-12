// isomorphic-git expects Node's Buffer; must be imported before it.
import { Buffer } from 'buffer'
globalThis.Buffer ??= Buffer
