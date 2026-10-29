import { promises as fs, createWriteStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const BASE = 'https://learn.tsinghua.edu.cn';
export const HOME = '/f/wlxt/index/course/student/';
const CURRENT = '/b/kc/zhjw_v_code_xnxq/getCurrentAndNextSemester';
const SEMESTERS = '/b/wlxt/kc/v_wlkc_xs_xktjb_coassb/queryxnxq';
export class WlxtError extends Error {}
export function sessionPath() { return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'wlxt', 'session.json'); }
export function validateCookie(value) {
  if (typeof value !== 'string' || !value.trim() || /[\r\n\0]/.test(value) || !value.includes('=')) throw new WlxtError('Cookie 格式无效，请复制请求标头中 Cookie 的值。');
  return value.trim();
}
export function cookieForUrl(cookies, url) {
  const target = new URL(url), now = Date.now() / 1000;
  return cookies.filter(c => {
    if (!c || typeof c.name !== 'string' || typeof c.value !== 'string' || !c.name || /[;=\r\n\0]/.test(c.name) || /[;\r\n\0]/.test(c.value) || typeof c.domain !== 'string' || typeof c.path !== 'string') return false;
    const domain = c.domain.toLowerCase(), host = target.hostname.toLowerCase();
    const domainOk = domain.startsWith('.') ? (host === domain.slice(1) || host.endsWith(domain)) : host === domain;
    const pathOk = target.pathname === c.path || (target.pathname.startsWith(c.path) && (c.path.endsWith('/') || target.pathname[c.path.length] === '/'));
    return domainOk && pathOk && (!c.secure || target.protocol === 'https:') && (!c.expires || c.expires < 0 || c.expires > now);
  }).sort((a,b) => b.path.length - a.path.length).map(c => `${c.name}=${c.value}`).join('; ');
}
export function validateCookies(cookies) {
  if (!Array.isArray(cookies) || !cookies.length) throw new WlxtError('浏览器尚未取得网络学堂会话，请重新登录。');
  const kept = cookies.filter(c => c && typeof c.path === 'string' && c.path.startsWith('/') && cookieForUrl([c], BASE + c.path));
  if (!kept.length) throw new WlxtError('浏览器尚未取得网络学堂会话，请重新登录。');
  return kept.map(({name,value,domain,path,secure,expires}) => ({name,value,domain,path,secure,expires}));
}
export async function saveSession(cookie) {
  cookie = Array.isArray(cookie) ? validateCookies(cookie) : validateCookie(cookie);
  const target = sessionPath(), dir = path.dirname(target);
  await fs.mkdir(dir, {recursive:true, mode:0o700});
  await fs.chmod(dir, 0o700);
  const tmp = path.join(dir, '.session-' + randomBytes(12).toString('hex'));
  try { await fs.writeFile(tmp, JSON.stringify(Array.isArray(cookie) ? {cookies:cookie} : {cookie}), {mode:0o600, flag:'wx'}); await fs.rename(tmp, target); }
  finally { await fs.rm(tmp, {force:true}); }
}
export async function getCookie() {
  const target = sessionPath();
  try {
    const stat = await fs.stat(target);
    if (stat.mode & 0o077) throw new WlxtError('会话文件权限过宽，请执行 chmod 600 ' + target);
    const session = JSON.parse(await fs.readFile(target, 'utf8'));
    return Array.isArray(session.cookies) ? validateCookies(session.cookies) : validateCookie(session.cookie);
  } catch(e) {
    if (e.code === 'ENOENT') throw new WlxtError('尚未登录，请先运行 wlxt-cli auth login。');
    if (e instanceof SyntaxError) throw new WlxtError('会话文件无效，请重新登录。');
    throw e;
  }
}
export async function logout() { await fs.rm(sessionPath(), {force:true}); }
export class Client {
  constructor(cookie, fetcher=fetch, signal=null) { this.cookie=Array.isArray(cookie) ? validateCookies(cookie) : validateCookie(cookie); this.fetcher=fetcher; this.signal=signal; this.csrf=null; }
  async request(requestPath, data=null, useToken=true, timeoutMs=30000) {
    if (typeof requestPath !== 'string' || !requestPath.startsWith('/') || requestPath.startsWith('//')) throw new WlxtError('无效请求路径。');
    let url = new URL(requestPath, BASE);
    if (url.origin !== BASE) throw new WlxtError('无效请求地址。');
    if (useToken && this.csrf) url.searchParams.append('_csrf', this.csrf);
    const headers = {'User-Agent':'wlxt-cli/0.1', 'Referer':BASE+HOME, 'Accept-Encoding':'identity'};
    let body;
    if (data instanceof FormData) { body=data; }
    else if (data !== null) { body=new URLSearchParams(data); headers['Content-Type']='application/x-www-form-urlencoded; charset=UTF-8'; }
    for (let i=0; i<6; i++) {
      const cookie = Array.isArray(this.cookie) ? cookieForUrl(this.cookie, url) : this.cookie;
      headers.Cookie = cookie;
      const xsrf = cookie.split(';').map(x=>x.trim()).find(x=>x.startsWith('XSRF-TOKEN='));
      if (xsrf) { try { headers['X-XSRF-TOKEN']=decodeURIComponent(xsrf.slice(11)); } catch { throw new WlxtError('Cookie 中的 XSRF 令牌无效。'); } } else delete headers['X-XSRF-TOKEN'];
      let response;
      try { response = await this.fetcher(url, {method:data === null ? 'GET' : 'POST', headers, body, redirect:'manual', signal:this.signal ? AbortSignal.any([this.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)}); }
      catch (e) { throw new WlxtError('网络请求失败：' + (e.cause?.message || e.message)); }
      if ([301,302,303,307,308].includes(response.status)) {
        const location=response.headers.get('location');
        if (!location) throw new WlxtError('服务器返回无效跳转。');
        const next=new URL(location,url);
        if (next.origin !== BASE) throw new WlxtError('登录已失效或服务器跳转到了其他域名，请重新登录。');
        if (next.pathname.includes('login_timeout')) throw new WlxtError('登录已失效，请重新登录。');
        await response.body?.cancel();
        if ([301,302,303].includes(response.status)) { data=null; body=undefined; delete headers['Content-Type']; }
        url=next; continue;
      }
      if (response.status===401 || response.status===403) throw new WlxtError('登录失效或无权访问，请重新登录。');
      if (!response.ok) throw new WlxtError('请求失败，HTTP ' + response.status);
      if (url.pathname.includes('login_timeout')) throw new WlxtError('登录已失效，请重新登录。');
      return response;
    }
    throw new WlxtError('服务器跳转次数过多。');
  }
  async init() {
    const page=await (await this.request(HOME,null,false)).text();
    const match=page.match(/(?:&amp;|&|\?)_csrf=([^&"'\s<>]+)/);
    if (!match) throw new WlxtError('无法从网络学堂页面获取会话令牌，请重新登录或检查接口是否变化。');
    try { this.csrf=decodeURIComponent(match[1]); } catch { throw new WlxtError('服务器返回无效的会话令牌。'); }
  }
  async json(url,data=null) {
    const response=await this.request(url,data);
    try { return await response.json(); } catch { throw new WlxtError('服务器未返回预期的 JSON；会话可能失效或接口发生变化。'); }
  }
  async current() { const obj=await this.json(CURRENT); if (!obj?.result?.id) throw new WlxtError('无法解析当前学期。'); return obj.result.id; }
  async semesters() { const data=await this.json(SEMESTERS); if (!Array.isArray(data)) throw new WlxtError('无法解析学期列表。'); return data.filter(Boolean); }
  async courses(semester) { const data=await this.json('/b/wlxt/kc/v_wlkc_xs_xkb_kcb_extend/student/loadCourseBySemesterId/'+encodeURIComponent(semester)+'/zh/'); if (!Array.isArray(data?.resultList)) throw new WlxtError('无法解析课程列表。'); return data.resultList; }
  async rows(url,course) { const aoData=JSON.stringify([{name:'wlkcid',value:course},{name:'iDisplayStart',value:0},{name:'iDisplayLength',value:-1}]); const result=await this.json(url,{aoData}); if(result?.result!=='success') throw new WlxtError('服务器返回失败，无法获取列表。'); const rows=result?.object?.aaData ?? result?.object?.resultsList; if(!Array.isArray(rows)) throw new WlxtError('无法解析列表响应。'); return rows; }
  async notifications(course) { const rows=[]; for (const status of ['Wgq','Ygq']) rows.push(...await this.rows('/b/wlxt/kcgg/wlkc_ggb/student/pageListXsby'+status,course)); return rows.map(x=>({...x,...(x.ggnr ? {_content:Buffer.from(x.ggnr,'base64').toString('utf8')} : {})})); }
  async homework(course) { const rows=[]; for (const [suffix,status] of [['zyListWj','未交'],['zyListYjwg','已交未批'],['zyListYpg','已批']]) rows.push(...(await this.rows('/b/wlxt/kczy/zy/student/'+suffix,course)).map(x=>({...x,_status:status}))); return rows; }
  async findHomework(course, id) {
    const rows=await this.homework(course);
    const matches=rows.filter(row=>String(row.xszyid ?? '')===id);
    if(matches.length!==1) throw new WlxtError('未找到唯一学生作业 ID，请先用 homework 查询该课程。');
    return matches[0];
  }
  async homeworkFeedback(course, id) {
    const row=await this.findHomework(course,id);
    return {courseId:course, homeworkId:id, title:row.bt, status:row._status,
      submissionMethod:row.zytjfs, submittedAt:row.scsjStr ?? row.scsj,
      grade:row.cj, gradeStatus:row.pyzt,
      feedback:row.pynr, gradedAt:row.pysjStr ?? row.pysj, grader:row.jsm};
  }
  async submitHomework(course, id, {file, text, replace=false}) {
    if (!file && !text) throw new WlxtError('请使用 --file 指定附件或使用 --text 指定作业内容。');
    let bytes, filename;
    if (file) {
      const stat=await fs.stat(file);
      if (!stat.isFile()) throw new WlxtError('附件必须是普通文件。');
      if (stat.size===0) throw new WlxtError('附件为空，未提交。');
      if (stat.size > 100 * 1024 * 1024) throw new WlxtError('附件超过 100 MiB，请通过网页提交。');
      bytes=await fs.readFile(file); filename=path.basename(file);
      if (!bytes.length || bytes.length!==stat.size) throw new WlxtError('读取附件时大小发生变化，未提交。');
    }
    const row=await this.findHomework(course,id);
    if (String(row.zytjfs)!=='2') throw new WlxtError('该作业不是网络学堂在线提交类型，未提交。');
    if (String(row.zywcfs)!=='1') throw new WlxtError('暂不支持小组或未知完成方式的作业，未提交。');
    if (row._status!=='未交' && !replace) throw new WlxtError('此作业已有提交或已批改；如需重新提交，请明确使用 --replace。');
    const form=new FormData();
    form.append('xszyid',id); form.append('zynr',text ?? '');
    if (bytes) form.append('fileupload',new Blob([bytes]),filename); else form.append('fileupload','undefined');
    form.append('isDeleted','0');
    let result;
    try { result=await this.json('/b/wlxt/kczy/zy/student/tjzy',form); }
    catch(e) { throw new WlxtError('提交结果未知，请先查询作业状态，不要立即重试。'+e.message); }
    if (result?.result!=='success') throw new WlxtError('服务器未确认提交成功，请查询作业状态。');
    let status='unknown';
    try { status=(await this.findHomework(course,id))._status; } catch {}
    return {result:'server_accepted', previousStatus:row._status, status, message:'服务器已接受请求；请在网页核对提交内容和附件。'};
  }
  async files(course) { const query=new URLSearchParams({wlkcid:course,size:'0'}); const data=await this.json('/b/wlxt/kj/wlkc_kjxxb/student/kjxxbByWlkcidAndSizeForStudent?'+query); if(data?.result!=='success') throw new WlxtError('服务器返回失败，无法获取课件列表。'); if(!Array.isArray(data.object)) throw new WlxtError('无法解析课件列表。'); return data.object; }
}
export function safeName(name) { return String(name).replace(/[\\/\x00-\x1f\x7f]/g,'_').replace(/^[. ]+|[. ]+$/g,'').slice(0,180) || 'download'; }
export async function download(client,course,id,dir='.') {
  const matches=(await client.files(course)).filter(x=>String(x.wjid ?? '')===id);
  if(matches.length!==1) throw new WlxtError('找不到唯一的文件 ID，请先查询文件列表。');
  const file=matches[0]; let name=String(file.bt || file.wjmc || id); const ext=String(file.wjlx || '').replace(/^\.+|\.+$/g,''); if(ext && !name.toLowerCase().endsWith('.'+ext.toLowerCase())) name+='.'+ext;
  name=safeName(name); await fs.mkdir(dir,{recursive:true}); const target=path.join(dir,name);
  const query=new URLSearchParams({sfgk:'0',wjid:id}); const response=await client.request('/b/wlxt/kj/wlkc_kjxxb/student/downloadFile?'+query,null,true,30*60*1000);
  const type=(response.headers.get('content-type') || '').toLowerCase();
  if(type.includes('text/html') || type.includes('application/json') || !response.body) throw new WlxtError('下载响应不是文件，会话可能失效或服务器拒绝访问。');
  const tmp=path.join(dir,'.wlxt-download-'+randomBytes(12).toString('hex'));
  try {
    await pipeline(Readable.fromWeb(response.body),createWriteStream(tmp,{flags:'wx',mode:0o600}));
    const length=response.headers.get('content-length'), encoding=(response.headers.get('content-encoding') || 'identity').toLowerCase(); if(encoding==='identity' && length && /^\d+$/.test(length) && (await fs.stat(tmp)).size!==Number(length)) throw new WlxtError('下载不完整，未保存文件。');
    try { await fs.link(tmp,target); } catch(e) { if(e.code==='EEXIST') throw new WlxtError('目标文件已存在：'+target); throw e; }
  } finally { await fs.rm(tmp,{force:true}); }
  return target;
}
