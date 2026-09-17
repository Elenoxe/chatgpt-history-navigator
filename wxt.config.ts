import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

// Chromium rejects Unicode noncharacters in content-script files, even in valid UTF-8.
// Escape after code generation, which otherwise turns KaTeX's \uFFFF back into a literal.
// https://github.com/rolldown/rolldown/issues/8805
const noncharacters = new RegExp(`[\\uFDD0-\\uFDEF${Array.from({ length: 17 }, (_, plane) =>
  String.fromCodePoint(plane * 0x10000 + 0xfffe, plane * 0x10000 + 0xffff)).join('')}]`, 'gu');

export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-react'],
  vite: () => ({
    plugins: [tailwindcss(), {
      name: 'escape-content-script-noncharacters',
      generateBundle: {
        order: 'post',
        handler(_options, bundle) {
          for (const output of Object.values(bundle)) {
            if (output.type !== 'chunk') continue;
            output.code = output.code.replace(noncharacters, character => character.split('')
              .map(unit => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`).join(''));
          }
        },
      },
    }],
  }),
  manifest: {
    name: '__MSG_extensionName__',
    description: '__MSG_extensionDescription__',
    default_locale: 'en',
  },
});
