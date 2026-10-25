// Renders build/icon.png (1024×1024) with the real black-hole shader.
//   npx electron scripts/render-icon.cjs
const { app, BrowserWindow } = require('electron');
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');

const src = readFileSync(join(__dirname, '../src/renderer/src/themes/singularity.ts'), 'utf8');
const frag = /BLACK_HOLE_FRAG = `([\s\S]*?)`;/.exec(src)[1];

const page = `<!doctype html><html><body style="margin:0;background:transparent">
<canvas id="out" width="1024" height="1024"></canvas>
<script>
const frag = ${JSON.stringify(frag)};
const S = 1024;
const gl = Object.assign(document.createElement('canvas'), { width: S, height: S }).getContext('webgl2', { premultipliedAlpha: true });
const sh = (t, s) => { const x = gl.createShader(t); gl.shaderSource(x, s); gl.compileShader(x); if (!gl.getShaderParameter(x, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(x)); return x; };
const p = gl.createProgram();
gl.attachShader(p, sh(gl.VERTEX_SHADER, '#version 300 es\\nin vec2 p; void main(){ gl_Position = vec4(p,0.,1.); }'));
gl.attachShader(p, sh(gl.FRAGMENT_SHADER, frag));
gl.linkProgram(p); gl.useProgram(p);
gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,3,-1,-1,3]), gl.STATIC_DRAW);
gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
const u = (n) => gl.getUniformLocation(p, n);
gl.uniform2f(u('uRes'), S, S); gl.uniform2f(u('uCenter'), S / 2, S / 2 + 8); gl.uniform1f(u('uR'), 410);
gl.uniform1f(u('uTime'), 3.0); gl.uniform1f(u('uSpin'), 7.5); gl.uniform1f(u('uHeat'), 1.15); gl.uniform1f(u('uZoom'), 1.08);
gl.uniform1f(u('uRing'), 0.0); gl.uniform1f(u('uBloom'), 0.0); gl.uniform1f(u('uShock'), -1.0); gl.uniform1f(u('uDormant'), 0.0);
gl.uniform1f(u('uBlue'), 0.0); gl.uniform2f(u('uTilt'), 0.0, 0.0); gl.uniform1f(u('uJitter'), 0.0); gl.uniform1f(u('uLens'), 0.0);
gl.viewport(0, 0, S, S); gl.clearColor(0,0,0,0); gl.clear(gl.COLOR_BUFFER_BIT); gl.drawArrays(gl.TRIANGLES, 0, 3);

// macOS-style tile: 824px body, deep warm black, the hole sits inside it
const g = document.getElementById('out').getContext('2d');
const tile = new Path2D(); tile.roundRect(100, 100, 824, 824, 186);
g.save(); g.shadowColor = 'rgba(0,0,0,0.35)'; g.shadowBlur = 28; g.shadowOffsetY = 12; g.fillStyle = '#0b0908'; g.fill(tile); g.restore();
g.save(); g.clip(tile);
const bg = g.createRadialGradient(512, 470, 40, 512, 512, 560);
bg.addColorStop(0, '#1d1611'); bg.addColorStop(1, '#070605');
g.fillStyle = bg; g.fillRect(100, 100, 824, 824);
g.drawImage(gl.canvas, 0, 0);
g.restore();
g.strokeStyle = 'rgba(255,220,180,0.08)'; g.lineWidth = 2; g.stroke(tile);
window.done = true;
</script></body></html>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1024, height: 1024, webPreferences: { offscreen: false } });
  await win.loadURL(`data:text/html;base64,${Buffer.from(page).toString('base64')}`);
  const data = await win.webContents.executeJavaScript(`document.getElementById('out').toDataURL('image/png')`);
  mkdirSync(join(__dirname, '../build'), { recursive: true });
  writeFileSync(join(__dirname, '../build/icon.png'), Buffer.from(data.split(',')[1], 'base64'));
  console.log('build/icon.png written');
  app.quit();
});
