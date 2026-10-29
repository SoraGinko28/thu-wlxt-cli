import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Client, WlxtError, validateCookies } from './client.js';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function getCookies(port, websocketPath, signal) {
  if (!/^[0-9]+$/.test(port) || !/^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(websocketPath)) throw new WlxtError('浏览器调试地址无效。');
  const ws = new WebSocket(`ws://127.0.0.1:${port}${websocketPath}`);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new WlxtError('连接浏览器超时。')), 5000);
    let done = false;
    function finish(err, value) { if (done) return; done=true; clearTimeout(timeout); signal?.removeEventListener('abort', onAbort); try { ws.close(); } catch {} err ? reject(err) : resolve(value); }
    function onAbort() { finish(new WlxtError('已取消登录。')); }
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, {once:true});
    ws.addEventListener('open', () => ws.send(JSON.stringify({id:1, method:'Storage.getCookies'})), {once:true});
    ws.addEventListener('error', () => finish(new WlxtError('无法连接登录浏览器。')), {once:true});
    ws.addEventListener('message', event => {
      try { const data = JSON.parse(event.data); if (data.id !== 1) return; if (data.error || !Array.isArray(data.result?.cookies)) return finish(new WlxtError('无法读取浏览器会话。')); finish(null, data.result.cookies); }
      catch { finish(new WlxtError('浏览器返回无效的会话数据。')); }
    });
  });
}

async function stopBrowser(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return true;
  child.kill('SIGTERM');
  await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(3000)]);
  if (child.exitCode !== null || child.signalCode !== null) return true;
  child.kill('SIGKILL');
  await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(3000)]);
  return child.exitCode !== null || child.signalCode !== null;
}

export async function verifyBrowserSession(cookies, createClient = c => new Client(c)) {
  const valid = validateCookies(cookies);
  const client = createClient(valid);
  await client.init(); await client.current();
  return valid;
}

export async function browserLogin({ timeoutMs = 5 * 60 * 1000 } = {}) {
  if (process.platform !== 'darwin') throw new WlxtError('自动登录目前仅支持 macOS 和 Google Chrome。');
  try { await fs.access(CHROME); } catch { throw new WlxtError('未找到 Google Chrome，请先安装 Chrome。'); }
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'wlxt-login-'));
  await fs.chmod(profile, 0o700);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  let child, spawnError;
  try {
    child = spawn(CHROME, [`--user-data-dir=${profile}`, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', 'https://learn.tsinghua.edu.cn/'], {stdio:'ignore'});
    child.on('error', e => { spawnError=e; });
    process.stderr.write('已打开独立的 Chrome 窗口，请在学校页面点击登录并完成认证和二次验证。登录完成后请保持窗口打开。\n');
    const deadline = Date.now() + timeoutMs;
    let port, debuggerPath, nextAttempt=0;
    while (Date.now() < deadline && !controller.signal.aborted) {
      if (spawnError) throw new WlxtError('无法启动 Chrome：' + spawnError.message);
      if (child.exitCode !== null || child.signalCode !== null) throw new WlxtError('登录窗口已关闭，请重新运行登录命令。');
      if (!port) {
        try { [port, debuggerPath] = (await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/); }
        catch (e) { if (e.code !== 'ENOENT') throw e; }
      }
      if (port && Date.now() >= nextAttempt) {
        nextAttempt=Date.now()+3000;
        try {
          const cookies = await getCookies(port, debuggerPath, controller.signal);
          return await verifyBrowserSession(cookies, c => new Client(c, fetch, controller.signal));
        } catch (e) {
          // Authentication may still be in progress; don't expose cookie data or transient errors.
          if (!(e instanceof WlxtError)) throw e;
        }
      }
      await delay(1000);
    }
    if (controller.signal.aborted) throw new WlxtError('已取消登录。');
    throw new WlxtError('登录超时，请确认浏览器已完成登录且网络学堂可访问，然后重新运行 wlxt-cli auth login。');
  } finally {
    process.off('SIGINT', cancel); process.off('SIGTERM', cancel);
    if (!child || await stopBrowser(child)) await fs.rm(profile, {recursive:true, force:true});
    else process.stderr.write('登录浏览器未能退出，未清除临时浏览器目录：' + profile + '\n');
  }
}
