#!/usr/bin/env node
import { browserLogin } from '../src/browser-login.js';
import { homeworkDetails, downloadHomeworkAttachment } from '../src/homework-details.js';
import { announcementAttachments, downloadAnnouncement } from '../src/announcement-attachments.js';
import { feedbackAttachments, downloadFeedback } from '../src/feedback.js';
import { Client, WlxtError, download, getCookie, logout, saveSession, sessionPath } from '../src/client.js';

const help = `清华网络学堂 CLI（非官方学生端）

用法：wlxt-cli <命令> [参数]

  auth login                         打开浏览器完成学校认证
  auth status                        验证保存的会话
  auth logout                        删除本机保存的会话
  semesters                          列出学期
  courses [--semester 学期ID]        列出课程，默认当前学期
  notifications <课程ID>            查询课程公告
  notification-attachments <课程ID> <公告ID>  查看公告附件
  notification-download <课程ID> <公告ID> <附件ID> [-d 目录]  下载公告附件
  homework <课程ID>                 查询课程作业
  homework-detail <课程ID> <学生作业ID>  查看完整作业要求和附件
  homework-download <课程ID> <学生作业ID> <附件ID> [-d 目录]  下载老师下发的作业附件
  homework-feedback <课程ID> <学生作业ID>  查询成绩和反馈
  feedback-attachments <课程ID> <学生作业ID>  查看批改附件
  feedback-download <课程ID> <学生作业ID> <附件ID> [-d 目录]  下载批改附件
  homework-submit <课程ID> <学生作业ID> [--file 文件] [--text 正文] [--replace]  提交作业
  files <课程ID>                    查询课程资料
  download <课程ID> <文件ID> [-d 目录]  下载资料，不覆盖已有文件

命令结果为 JSON；错误输出到 stderr。课程 ID 来自 courses，文件 ID 来自 files。
学生作业 ID 使用 homework 返回的 xszyid；公告 ID 使用 notifications 返回的 ggid。
--replace 可能覆盖已有提交。
`;
function output(data) { process.stdout.write(JSON.stringify({ok:true,data},null,2)+'\n'); }
function parse(argv) {
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) return {command:'help'};
  if (argv.length===1 && argv[0]==='--version') return {command:'version'};
  let [cmd,...rest]=argv;
  if(cmd==='auth') { if(rest.length!==1 || !['login','logout','status'].includes(rest[0])) throw new WlxtError('用法：wlxt-cli auth <login|status|logout>'); return {command:'auth '+rest[0]}; }
  if(['login','logout'].includes(cmd) && rest.length===0) return {command:'auth '+cmd};
  if(cmd==='semesters' && rest.length===0) return {command:cmd};
  if(cmd==='courses' && (rest.length===0 || (rest.length===2 && rest[0]==='--semester' && rest[1]))) return {command:cmd,semester:rest[1]};
  if(['notifications','homework','files'].includes(cmd) && rest.length===1 && !rest[0].startsWith('-')) return {command:cmd,course:rest[0]};
  if(['homework-feedback','feedback-attachments','homework-detail'].includes(cmd) && rest.length===2 && rest.every(x=>!x.startsWith('-'))) return {command:cmd,course:rest[0],homework:rest[1]};
  if(cmd==='notification-attachments' && rest.length===2 && rest.every(x=>!x.startsWith('-'))) return {command:cmd,course:rest[0],announcement:rest[1]};
  if(['homework-download','notification-download'].includes(cmd) && (rest.length===3 || (rest.length===5 && ['-d','--directory'].includes(rest[3]) && rest[4])) && rest.slice(0,3).every(x=>!x.startsWith('-'))) return {command:cmd,course:rest[0],object:rest[1],file:rest[2],directory:rest[4]||'.'};
  if(cmd==='feedback-download' && (rest.length===3 || (rest.length===5 && ['-d','--directory'].includes(rest[3]) && rest[4])) && rest.slice(0,3).every(x=>!x.startsWith('-'))) return {command:cmd,course:rest[0],homework:rest[1],file:rest[2],directory:rest[4]||'.'};
  if(cmd==='homework-submit' && rest.length>=3 && !rest[0].startsWith('-') && !rest[1].startsWith('-')) {
    const options={};
    for (let i=2;i<rest.length;i++) {
      const arg=rest[i];
      if(arg==='--replace' && options.replace===undefined) options.replace=true;
      else if((arg==='--file'||arg==='--text') && options[arg.slice(2)]===undefined && rest[i+1] && !rest[i+1].startsWith('--')) options[arg.slice(2)]=rest[++i];
      else throw new WlxtError('作业提交参数无效，请运行 wlxt-cli --help。');
    }
    if(!options.file && !options.text) throw new WlxtError('请指定 --file 或 --text。');
    return {command:cmd,course:rest[0],homework:rest[1],options};
  }
  if(cmd==='download' && (rest.length===2 || (rest.length===4 && ['-d','--directory'].includes(rest[2]) && rest[3])) && !rest[0].startsWith('-') && !rest[1].startsWith('-')) return {command:cmd,course:rest[0],file:rest[1],directory:rest[3]||'.'};
  throw new WlxtError('命令或参数无效，请运行 wlxt-cli --help 查看用法。');
}
async function main() {
  const args=parse(process.argv.slice(2));
  if(args.command==='help') { process.stdout.write(help); return; }
  if(args.command==='version') { process.stdout.write('0.1.0\n'); return; }
  if(args.command==='auth logout') { await logout(); output({message:'已删除本机保存的会话。'}); return; }
  if(args.command==='auth login') {
    const cookie=await browserLogin(); await saveSession(cookie);
    output({message:'会话验证成功并已保存。',session:sessionPath()}); return;
  }
  const client=new Client(await getCookie()); await client.init();
  switch(args.command) {
    case 'auth status': { await client.current(); output({authenticated:true}); break; }
    case 'semesters': output(await client.semesters()); break;
    case 'courses': output(await client.courses(args.semester || await client.current())); break;
    case 'notifications': output(await client.notifications(args.course)); break;
    case 'notification-attachments': output((await announcementAttachments(client,args.course,args.announcement)).map(({id,name})=>({id,name}))); break;
    case 'notification-download': output({path:await downloadAnnouncement(client,args.course,args.object,args.file,args.directory)}); break;
    case 'homework': output(await client.homework(args.course)); break;
    case 'homework-detail': { const detail=await homeworkDetails(client,args.course,args.homework); detail.attachments=detail.attachments.map(({id,name})=>({id,name})); output(detail); break; }
    case 'homework-download': output({path:await downloadHomeworkAttachment(client,args.course,args.object,args.file,args.directory)}); break;
    case 'homework-feedback': output(await client.homeworkFeedback(args.course,args.homework)); break;
    case 'feedback-attachments': output((await feedbackAttachments(client,args.course,args.homework)).map(({id,name})=>({id,name}))); break;
    case 'feedback-download': output({path:await downloadFeedback(client,args.course,args.homework,args.file,args.directory)}); break;
    case 'homework-submit': output(await client.submitHomework(args.course,args.homework,args.options)); break;
    case 'files': output(await client.files(args.course)); break;
    case 'download': output({path:await download(client,args.course,args.file,args.directory)}); break;
  }
}
main().catch(error=>{ process.stderr.write(JSON.stringify({ok:false,error:{message:error instanceof WlxtError ? error.message : '操作失败：'+error.message}},null,2)+'\n'); process.exitCode=1; });
