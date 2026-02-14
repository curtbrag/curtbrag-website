import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  site: 'https://www.curtbrag.com',
  output: 'static',
  build: {
    assets: '_astro'
  },
  vite: {
    plugins: [tailwindcss()]
  }
});
