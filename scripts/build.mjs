// 打包前端：web/app.js -> public/app.js
// 同时把 Trystero 的 ICE 收集超时从 15 秒改成 3 秒。
// 原因：我们关闭了 trickle ICE（绕过 offer 过期 bug），建连要等 ICE 收集完成；
// 某些网络里收集迟迟不结束，15 秒太久。3 秒内收集到的候选地址通常已经够用。
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';

const ICE_TIMEOUT_MS = 3000;

const patchIceTimeout = {
  name: 'patch-trystero-ice-timeout',
  setup(b) {
    b.onLoad({ filter: /@trystero-p2p[\\/]core[\\/]dist[\\/]peer\.mjs$/ }, async ({ path }) => {
      const src = await readFile(path, 'utf8');
      const re = /const iceTimeout = \d+(?:e\d+)?;/;
      if (!re.test(src)) throw new Error('Trystero 源码变了，找不到 iceTimeout，请检查 scripts/build.mjs');
      return { contents: src.replace(re, `const iceTimeout = ${ICE_TIMEOUT_MS};`), loader: 'js' };
    });
  },
};

await build({
  entryPoints: ['web/app.js'],
  bundle: true,
  format: 'esm',
  minify: true,
  target: 'es2022',
  outfile: 'public/app.js',
  plugins: [patchIceTimeout],
  logLevel: 'info',
});
