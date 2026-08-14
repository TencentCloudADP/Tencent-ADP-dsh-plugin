import { defineConfig } from 'tsdown'

const entries = {
  index: 'src/index.ts',
  'llm/index': 'src/llm/index.ts',
  'web/index': 'src/web/index.ts',
  'plugins/index': 'src/plugins/index.ts',
  'skills/index': 'src/skills/index.ts',
  'agents/index': 'src/agents/index.ts',
  'control/index': 'src/control/index.ts',
}

export default defineConfig({
  entry: entries,
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  dts: true,
  clean: true,
  sourcemap: true,
  external: [
    /^@deepseek-ai\//,
    'eventsource-parser',
    'eventsource-parser/stream',
    'fflate',
  ],
})
