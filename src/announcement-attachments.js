import { promises as fs, createWriteStream } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { BASE, WlxtError, safeName } from './client.js';

const DOWNLOAD_PATH = '/b/wlxt/kcgg/wlkc_ggb/student/kcggFjxz';
function unescapeHtml(value) {
  const named = {amp:'&', quot:'"', apos:"'", lt:'<', gt:'>', nbsp:' '};
  return String(value).replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (all,key)=>{
    if(key[0]!=='#') return named[key.toLowerCase()] ?? all;
    const n=key[1].toLowerCase()==='x'?parseInt(key.slice(2),16):parseInt(key.slice(1),10);
    return n>0 && n<=0x10ffff && !(n>=0xd800 && n<=0xdfff) ? String.fromCodePoint(n) : all;
  });
}
function attr(tag,name) {
  const m=tag.match(new RegExp('(?:^|\\s)'+name+'\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))','i'));
  return m ? unescapeHtml(m[1] ?? m[2] ?? m[3]) : null;
}
export function parseAnnouncementAttachment(html, course, announcement, name) {
  const candidates=[];
  for(const match of html.matchAll(/<a\b[^>]*>/gi)) {
    const tag=match[0];
    if(!(attr(tag,'class') ?? '').split(/\s+/).includes('ml-10')) continue;
    const href=attr(tag,'href'); if(!href) continue;
    let url;
    try {url=new URL(href,BASE);} catch {throw new WlxtError('公告附件地址无效。');}
    if(url.origin!==BASE || url.username || url.password || url.pathname!==DOWNLOAD_PATH) throw new WlxtError('公告附件下载地址不属于网络学堂或格式异常。');
    const ids=['wlkcid','ggid','wjid'];
    if(ids.some(key=>url.searchParams.getAll(key).length!==1)) throw new WlxtError('公告附件参数格式异常。');
    const id=url.searchParams.get('wjid');
    if(url.searchParams.get('wlkcid')!==course || url.searchParams.get('ggid')!==announcement || !id || /[\/\\\x00-\x1f\x7f]/.test(id)) throw new WlxtError('公告附件与所选公告不匹配。');
    const query=new URLSearchParams({wlkcid:course,ggid:announcement,wjid:id});
    candidates.push({id,name:unescapeHtml(name),downloadPath:DOWNLOAD_PATH+'?'+query});
  }
  if(candidates.length!==1) throw new WlxtError('无法可靠识别该公告的附件；页面结构可能发生变化。');
  return candidates;
}
export async function announcementAttachments(client,course,announcement) {
  const matches=(await client.notifications(course)).filter(n=>String(n.ggid ?? '')===announcement);
  if(matches.length!==1) throw new WlxtError('未找到唯一公告 ID，请先查询该课程的公告。');
  if(!matches[0].fjmc) return [];
  const query=new URLSearchParams({wlkcid:course,id:announcement});
  const response=await client.request('/f/wlxt/kcgg/wlkc_ggb/student/beforeViewXs?'+query);
  const type=(response.headers.get('content-type')||'').toLowerCase();
  if(type && !type.includes('text/html')) throw new WlxtError('公告详情响应不是网页。');
  return parseAnnouncementAttachment(await response.text(),course,announcement,matches[0].fjmc);
}
export async function downloadAnnouncement(client,course,announcement,id,dir='.') {
  const matches=(await announcementAttachments(client,course,announcement)).filter(f=>f.id===id);
  if(matches.length!==1) throw new WlxtError('未找到唯一公告附件 ID，请先查询附件列表。');
  const target=path.join(dir,safeName(matches[0].name));
  const response=await client.request(matches[0].downloadPath,null,true,30*60*1000);
  const type=(response.headers.get('content-type')||'').toLowerCase();
  if(type.includes('text/html')||type.includes('application/json')||!response.body) throw new WlxtError('下载响应不是附件，登录可能失效或服务器拒绝访问。');
  await fs.mkdir(dir,{recursive:true});
  const tmp=path.join(dir,'.wlxt-announcement-'+randomBytes(12).toString('hex'));
  try {
    await pipeline(Readable.fromWeb(response.body),createWriteStream(tmp,{flags:'wx',mode:0o600}));
    const length=response.headers.get('content-length'), encoding=(response.headers.get('content-encoding')||'identity').toLowerCase();
    if(encoding==='identity' && length && /^\d+$/.test(length) && (await fs.stat(tmp)).size!==Number(length)) throw new WlxtError('下载不完整，未保存文件。');
    try {await fs.link(tmp,target);} catch(e) {if(e.code==='EEXIST') throw new WlxtError('目标文件已存在：'+target);throw e;}
  } finally {await fs.rm(tmp,{force:true});}
  return target;
}
