import { promises as fs, createWriteStream } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { BASE, WlxtError, safeName } from './client.js';

function unescapeHtml(value) {
  const named = {amp:'&',quot:'"',apos:"'",lt:'<',gt:'>',nbsp:' '};
  return String(value).replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi,(all,key)=>{
    if (key[0]!=='#') return named[key.toLowerCase()] ?? all;
    const n=key[1].toLowerCase()==='x' ? parseInt(key.slice(2),16) : parseInt(key.slice(1),10);
    return Number.isInteger(n) && n>0 && n<=0x10ffff && !(n>=0xd800 && n<=0xdfff) ? String.fromCodePoint(n) : all;
  });
}
function attr(tag,name) {
  const match=tag.match(new RegExp('(?:^|\\s)'+name+'\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))','i'));
  return match ? unescapeHtml(match[1] ?? match[2] ?? match[3]) : null;
}
export function parseHomeworkAttachments(html,course) {
  // Page has four distinct blocks: question, answer, student's submission, teacher feedback.
  const tokens=/<script\b[^>]*>[\s\S]*?<\/script\s*>|<style\b[^>]*>[\s\S]*?<\/style\s*>|<!--[\s\S]*?-->|<\/?div\b[^>]*>/gi;
  const blocks=[]; let depth=0,start=-1,baseDepth=0;
  for(const m of html.matchAll(tokens)) {
    const token=m[0]; if(!/^<\/?div\b/i.test(token)) continue;
    if(/^<\/div\b/i.test(token)) {
      if(depth<=0) throw new WlxtError('作业详情页面结构不完整，无法检查作业附件。');
      depth--;
      if(start>=0 && depth===baseDepth) {blocks.push(html.slice(start,m.index+token.length));start=-1;}
    } else {
      const classes=(attr(token,'class') ?? '').split(/\s+/);
      if(start<0 && ['list','fujian','clearfix'].every(c=>classes.includes(c))) {start=m.index;baseDepth=depth;}
      depth++;
    }
  }
  if(start>=0 || blocks.length!==4) throw new WlxtError('作业详情页面附件结构发生变化，无法可靠识别作业附件。');
  const files=[];
  for(const m of blocks[0].matchAll(/<a\b[^>]*>[\s\S]*?<\/a\s*>/gi)) {
    const tag=m[0].match(/^<a\b[^>]*>/i)?.[0], href=tag && attr(tag,'href');
    if(!href) continue;
    let preview,download;
    try {
      preview=new URL(href,BASE);
      if(preview.origin!==BASE || preview.username || preview.password) throw Error();
      download=new URL(preview.searchParams.get('downloadUrl') ?? preview.href,BASE);
      if(download.origin!==BASE || download.username || download.password) throw Error();
    } catch {throw new WlxtError('作业附件链接不属于网络学堂，已拒绝。');}
    const expected='/b/wlxt/kczy/zy/student/downloadFile/'+encodeURIComponent(course)+'/';
    if(!download.pathname.startsWith(expected) || !download.pathname.slice(expected.length) || download.pathname.slice(expected.length).includes('/')) throw new WlxtError('作业附件下载地址格式异常。');
    let id;
    try {id=decodeURIComponent(download.pathname.slice(expected.length));} catch {throw new WlxtError('作业附件标识无效。');}
    const previewId=preview.searchParams.get('fileId');
    if(!id || (previewId && previewId!==id) || /[\/\\\x00-\x1f]/.test(id)) throw new WlxtError('作业附件标识不一致。');
    const name=unescapeHtml(m[0].replace(/^<a\b[^>]*>/i,'').replace(/<\/a\s*>$/i,'').replace(/<[^>]*>/g,'')).trim() || id;
    download.searchParams.delete('_csrf');
    files.push({id,name,downloadPath:download.pathname+download.search});
  }
  return files;
}
export async function homeworkDetails(client,course,homework) {
  const row=await client.findHomework(course,homework);
  if(!row.zyid) throw new WlxtError('作业缺少详情标识，无法获取说明。');
  const detail=await client.json('/b/wlxt/kczy/zy/student/detail',{id:String(row.zyid)});
  if(detail?.result!=='success' || (detail.msg != null && typeof detail.msg!=='string')) throw new WlxtError('服务器未返回有效作业说明。');
  const query=new URLSearchParams({wlkcid:course,xszyid:homework});
  const response=await client.request('/f/wlxt/kczy/zy/student/viewCj?'+query);
  const type=(response.headers.get('content-type')||'').toLowerCase();
  if(type && !type.includes('text/html')) throw new WlxtError('作业详情响应不是网页。');
  return {courseId:course,homeworkId:homework,title:row.bt,status:row._status,deadline:row.jzsjStr ?? row.jzsj,descriptionHtml:unescapeHtml(detail.msg ?? ''),attachments:parseHomeworkAttachments(await response.text(),course)};
}
export async function downloadHomeworkAttachment(client,course,homework,id,dir='.') {
  const files=(await homeworkDetails(client,course,homework)).attachments.filter(f=>f.id===id);
  if(files.length!==1) throw new WlxtError('未找到唯一作业附件 ID，请先查询作业详情。');
  const file=files[0],target=path.join(dir,safeName(file.name));
  const response=await client.request(file.downloadPath,null,true,30*60*1000);
  const type=(response.headers.get('content-type')||'').toLowerCase();
  if(type.includes('text/html') || type.includes('application/json') || !response.body) throw new WlxtError('下载响应不是附件，登录可能失效或服务器拒绝访问。');
  await fs.mkdir(dir,{recursive:true});const tmp=path.join(dir,'.wlxt-homework-'+randomBytes(12).toString('hex'));
  try {
    await pipeline(Readable.fromWeb(response.body),createWriteStream(tmp,{flags:'wx',mode:0o600}));
    const length=response.headers.get('content-length'),encoding=(response.headers.get('content-encoding')||'identity').toLowerCase();
    if(encoding==='identity' && length && /^\d+$/.test(length) && (await fs.stat(tmp)).size!==Number(length)) throw new WlxtError('下载不完整，未保存文件。');
    try {await fs.link(tmp,target);} catch(e) {if(e.code==='EEXIST') throw new WlxtError('目标文件已存在：'+target);throw e;}
  } finally {await fs.rm(tmp,{force:true});}
  return target;
}
