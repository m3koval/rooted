import {defineConfig} from 'vite';
import {resolve} from 'node:path';
const input = Object.fromEntries(['index','leaders','kiosk','display'].map(name => [name, resolve(import.meta.dirname, `${name}.html`)]));
// Production aliases are managed by the parent deployment configuration.
function localAliases() {
  const install = server => {
    server.middlewares.use((req, res, next) => {
      if (/^\/leaders\/?(?:\?|$)/.test(req.url)) req.url = req.url.replace(/^\/leaders\/?/, '/leaders.html');
      if (/^\/display\/?(?:\?|$)/.test(req.url)) req.url = req.url.replace(/^\/display\/?/, '/display.html');
      if (/^\/(?:kiosk|checkin)\/?(?:\?|$)/.test(req.url)) req.url = req.url.replace(/^\/(?:kiosk|checkin)\/?/, '/kiosk.html');
      next();
    });
  };
  return {name:'rooted-local-aliases',configureServer:install,configurePreviewServer:install};
}
export default defineConfig({plugins:[localAliases()],build:{rollupOptions:{input}},server:{host:'127.0.0.1'}});
