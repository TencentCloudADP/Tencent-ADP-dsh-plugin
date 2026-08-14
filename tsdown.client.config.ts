import { defineConfig } from 'tsdown'

/** Platform seeds from `@deepseek-ai/dsh-client-web` PLATFORM_MODULES, plus inject packages. */
const external = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
  '@deepseek-ai/dsh-client-connection',
  '@deepseek-ai/dsh-client-connection/client',
  '@deepseek-ai/dsh-client-runtime',
  '@deepseek-ai/dsh-client-runtime/client',
]

/**
 * Browser client bundle. CJS so wrap-client.mjs can drop the body into a
 * ModuleLoader factory that receives `require`. tsdown forces platform `node`
 * for CJS; the wrap is what the web shell actually loads.
 */
export default defineConfig({
  entry: {
    client: 'src/client/index.tsx',
  },
  outDir: 'lib',
  format: ['cjs'],
  platform: 'browser',
  target: 'es2024',
  dts: false,
  clean: false,
  sourcemap: false,
  external,
})
