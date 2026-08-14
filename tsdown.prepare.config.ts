import { defineConfig } from 'tsdown'

/**
 * Consumer-side build for git installs (`prepare`): transpile src → lib
 * without type checking or project references.
 */
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'llm/index': 'src/llm/index.ts',
    'web/index': 'src/web/index.ts',
    'plugins/index': 'src/plugins/index.ts',
    'skills/index': 'src/skills/index.ts',
    'agents/index': 'src/agents/index.ts',
    'control/index': 'src/control/index.ts',
  },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  dts: false,
  clean: false,
  external: [
    /^@deepseek-ai\//,
    'eventsource-parser',
    'eventsource-parser/stream',
    'fflate',
  ],
})
