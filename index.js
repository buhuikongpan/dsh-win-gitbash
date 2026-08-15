// Legacy directory-entry re-export: the loader resolves `dsh-tool-gitbash` to
// `<pkg>/index.js`, while Node's exports map also serves `lib/index.js` for
// direct imports. Both entry points expose the same plugin.
export { apply, Config, inject, name } from './lib/index.js'
